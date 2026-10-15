"""Real Windows process ownership fault tests, always dedicated test processes."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows_compute import launch, release, run_checked, state, stop
from windows_resources import sample


class ComputeTests(unittest.TestCase):
    def test_release_recovers_helper_death_before_or_after_source_close(self):
        from windows_api import close, open_job
        from windows_compute import release_directory

        code = """import json,sys,time
sys.path.insert(0,sys.argv[1])
from pathlib import Path
from windows_compute import launch,stop,write_journal,release
record=launch([sys.executable,'-c','import time; time.sleep(90)'],json.loads(sys.argv[2]),sys.argv[3])
stop(record)
record['release_claimed']=True
write_journal(Path(sys.argv[3])/'compute-launch.json',record)
if sys.argv[4]=='after':release(record)
Path(sys.argv[3],'ready').write_text('ready')
time.sleep(90)
"""
        for phase, recover in (
            ("before", False),
            ("after", False),
            ("before", True),
            ("after", True),
        ):
            with (
                self.subTest(phase=phase, bootstrap_recovery=recover),
                tempfile.TemporaryDirectory(prefix="release-interrupt-") as directory,
            ):
                log = Path(directory) / "helper.log"
                with log.open("w") as diagnostic:
                    helper = subprocess.Popen(
                        [
                            sys.executable,
                            "-B",
                            "-c",
                            code,
                            str(Path(__file__).resolve().parents[1]),
                            json.dumps({"pid": os.getpid()}),
                            directory,
                            phase,
                        ],
                        stdout=diagnostic,
                        stderr=diagnostic,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    record = None
                    try:
                        deadline = time.monotonic() + 15
                        while not Path(directory, "ready").exists() and time.monotonic() < deadline:
                            self.assertIsNone(helper.poll(), log.read_text()[-2000:])
                            time.sleep(0.05)
                        self.assertTrue(
                            Path(directory, "ready").exists(),
                            "Helper did not reach the release boundary",
                        )
                        record = json.loads(Path(directory, "compute-launch.json").read_text())
                        helper.kill()
                        helper.wait(timeout=5)
                        if recover:
                            from windows_compute import recover_launch

                            recover_launch(directory)
                        else:
                            release_directory(directory)
                        self.assertFalse(Path(directory, "compute-launch.json").exists())
                        handle = open_job(0x1F003F, False, record["job"])
                        try:
                            self.assertFalse(
                                handle, "Host-owned job handle leaked after helper death"
                            )
                        finally:
                            if handle:
                                close(handle)
                        release_directory(directory)
                    finally:
                        if helper.poll() is None:
                            helper.kill()
                            helper.wait(timeout=5)
                        # Before-close ownership was never consumed by the helper.
                        if record and phase == "before":
                            release(record)

    def test_remote_release_preserves_reused_unrelated_handles(self):
        import ctypes
        from ctypes import wintypes

        from windows_api import api, close, current, wait
        from windows_compute import make_job, remote_close

        event = api(
            "CreateEventW",
            [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR],
            wintypes.HANDLE,
        )(None, True, True, None)
        self.assertTrue(event)
        job = make_job(None)
        try:
            remote_close(current(), event, job)
            self.assertEqual(wait(event, 0), 0, "An unrelated reused handle was closed")
            remote_close(current(), 0, job)  # Already-consumed source is harmless.
        finally:
            close(event)
            close(job)

    def test_real_stop_and_memory(self):
        record = launch([sys.executable, "-c", "import time; time.sleep(90)"], {"pid": os.getpid()})
        try:
            self.assertEqual(state(record), "alive")
            self.assertGreater(sample([record["pid"]])["available"], 0)
            stop(record)
            self.assertEqual(state(record), "closed")
        finally:
            stop(record)
            release(record)

    def test_host_death_closes_compute_but_not_protected_writer(self):
        with tempfile.TemporaryDirectory(prefix="compute-fault-") as directory:
            result = Path(directory) / "owned.json"
            code = """import json,os,subprocess,sys,time
sys.path.insert(0,sys.argv[1])
from windows_compute import launch
writer=subprocess.Popen([sys.executable,'-c','import time; time.sleep(90)'])
record=launch([sys.executable,'-c','import time; time.sleep(90)'],{'pid':os.getpid()})
open(sys.argv[2],'w').write(json.dumps({'record':record,'writer':writer.pid}))
time.sleep(90)
"""
            owner = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    code,
                    str(Path(__file__).resolve().parents[1]),
                    str(result),
                ],
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            writer = None
            try:
                deadline = time.monotonic() + 15
                while not result.is_file() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(result.is_file())
                data = json.loads(result.read_text())
                writer = data["writer"]
                owner.kill()
                owner.wait(timeout=5)
                deadline = time.monotonic() + 5
                while state(data["record"]) != "closed" and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(state(data["record"]), "closed")
                from windows_api import close, open_process, wait

                handle = open_process(0x100000, False, writer)
                self.assertTrue(handle)
                try:
                    self.assertNotEqual(wait(handle, 0), 0)
                finally:
                    close(handle)
            finally:
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=5)
                if writer:
                    subprocess.run(
                        ["taskkill.exe", "/PID", str(writer), "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )

    def test_helper_owned_job_stops_drc_on_timeout(self):
        before = os.environ.get("DSH_COMPUTE_OWNER")
        os.environ["DSH_COMPUTE_OWNER"] = json.dumps({"pid": os.getpid()})
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                run_checked([sys.executable, "-c", "import time; time.sleep(90)"], 0.1)
        finally:
            if before is None:
                os.environ.pop("DSH_COMPUTE_OWNER", None)
            else:
                os.environ["DSH_COMPUTE_OWNER"] = before

    def test_killing_check_helper_stops_its_nested_drc(self):
        with tempfile.TemporaryDirectory(prefix="drc-helper-fault-") as directory:
            code = "import sys; sys.path.insert(0,sys.argv[1]); from windows_compute import run_checked; run_checked([sys.executable,'-c','import time; time.sleep(90)'],90,directory=sys.argv[2])"
            diagnostic = Path(directory) / "helper.log"
            diagnostics = diagnostic.open("w", encoding="utf-8")
            helper = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    code,
                    str(Path(__file__).resolve().parents[1]),
                    directory,
                ],
                stdout=diagnostics,
                stderr=diagnostics,
                env={**os.environ, "DSH_COMPUTE_OWNER": json.dumps({"pid": os.getpid()})},
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            record = None
            try:
                plan = Path(directory) / "compute-launch.json"
                deadline = (
                    time.monotonic() + 30
                )  # Same bounded startup allowance as the live engine test.
                while time.monotonic() < deadline:
                    self.assertIsNone(
                        helper.poll(),
                        "Check helper exited before recording compute ownership: "
                        + diagnostic.read_text(encoding="utf-8")[-2000:],
                    )
                    if plan.is_file():
                        candidate = json.loads(plan.read_text())
                        if candidate.get("pid"):
                            record = candidate
                            break
                    time.sleep(0.05)
                self.assertIsNotNone(
                    record, "Check helper never recorded compute ownership within 30 seconds"
                )
                helper.kill()
                helper.wait(timeout=5)
                deadline = time.monotonic() + 5
                while state(record) != "closed" and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(state(record), "closed")
            finally:
                if helper.poll() is None:
                    helper.kill()
                    helper.wait(timeout=5)
                diagnostics.close()
                if record:
                    from windows_compute import release_directory

                    release_directory(directory)
                    release_directory(directory)
                    self.assertFalse((Path(directory) / "compute-launch.json").exists())

    def test_bootstrap_lost_response_is_recovered_from_ownership_journal(self):
        from windows_compute import recover_launch

        with tempfile.TemporaryDirectory(prefix="compute-bootstrap-recovery-") as directory:
            record = launch(
                [sys.executable, "-c", "import time; time.sleep(90)"],
                {"pid": os.getpid()},
                directory,
            )
            self.assertEqual(state(record), "alive")
            recover_launch(directory)
            deadline = time.monotonic() + 5
            while state(record) != "closed" and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(state(record), "closed")
            self.assertFalse((Path(directory) / "compute-launch.json").exists())

    def test_real_bundled_java_exits_when_its_host_is_killed(self):
        import socket
        import urllib.request

        package = Path(__file__).resolve().parents[2]
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix="java-host-death-") as directory:
            result = Path(directory) / "java.json"
            endpoint = f"http://127.0.0.1:{port}"
            Path(directory, "freerouting.json").write_text(
                json.dumps(
                    {
                        # The engine rejects a configuration without the version
                        # discriminator and falls back to the default endpoint, so the
                        # requested port would never be bound. Mirror the launcher.
                        "version": "2.5.0",
                        "api_server": {
                            "enabled": True,
                            "http_allowed": True,
                            "endpoints": [endpoint],
                            "authentication": {"enabled": False},
                        },
                        "gui": {"enabled": False},
                        "profile": {"allow_telemetry": False, "allow_contact": False},
                        "usage_and_diagnostic_data": {"disable_analytics": True},
                    }
                )
            )
            code = "import sys,os,json,time; sys.path.insert(0,sys.argv[1]); from windows_compute import launch; record=launch(json.loads(sys.argv[2]),{'pid':os.getpid()},sys.argv[3]); open(sys.argv[4],'w').write(json.dumps(record)); time.sleep(90)"
            argv = [
                str(package / "bundled/jre/bin/java.exe"),
                "-Xmx2G",
                "-Djdk.net.unixdomain.tmpdir="
                + str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "Temp"),
                "-jar",
                str(package / "bundled/freerouting.jar"),
                "--user_data_path=" + directory,
                "--gui.enabled=false",
                "--api_server.enabled=true",
                "--api_server.http_allowed=true",
            ]
            owner = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    code,
                    str(package / "python"),
                    json.dumps(argv),
                    directory,
                    str(result),
                ],
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            record = None
            responsive = False
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if result.is_file():
                        record = json.loads(result.read_text())
                        try:
                            request = urllib.request.Request(
                                endpoint + "/v1/system/status",
                                headers={
                                    "Freerouting-Profile-ID": "3d3f8948-79c8-4b5e-a7a7-6e3f77f9d98c",
                                    "Freerouting-Profile-Email": "ipc-test@example.com",
                                    "Freerouting-Environment-Host": "host-death-test/1",
                                },
                            )
                            with urllib.request.urlopen(request, timeout=1) as response:
                                if response.status == 200:
                                    responsive = True
                                    break
                        except Exception:
                            pass
                    time.sleep(0.1)
                self.assertIsNotNone(record)
                self.assertTrue(responsive, "Real Java API never became ready")
                self.assertEqual(state(record), "alive")
                owner.kill()
                owner.wait(timeout=5)
                deadline = time.monotonic() + 5
                while state(record) != "closed" and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(state(record), "closed")
            finally:
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=5)
                if record:
                    stop(record)

    def test_repeated_checks_and_timeouts_release_host_job_handles(self):
        import ctypes
        from ctypes import wintypes

        from windows_api import api, current

        count = api("GetProcessHandleCount", [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)])

        def handles():
            value = wintypes.DWORD()
            self.assertTrue(count(current(), ctypes.byref(value)))
            return value.value

        before = os.environ.get("DSH_COMPUTE_OWNER")
        os.environ["DSH_COMPUTE_OWNER"] = json.dumps({"pid": os.getpid()})
        try:
            baseline = handles()
            with tempfile.TemporaryDirectory(prefix="compute-repeat-") as directory:
                for _ in range(12):
                    run_checked([sys.executable, "-c", "pass"], 5, directory)
                    with self.assertRaises(subprocess.TimeoutExpired):
                        run_checked(
                            [sys.executable, "-c", "import time; time.sleep(90)"], 0.015, directory
                        )
                    self.assertFalse((Path(directory) / "compute-launch.json").exists())
            self.assertLessEqual(handles(), baseline + 2)
        finally:
            if before is None:
                os.environ.pop("DSH_COMPUTE_OWNER", None)
            else:
                os.environ["DSH_COMPUTE_OWNER"] = before

    def test_journal_publication_waits_for_a_brief_windows_reader(self):
        import threading

        from windows_compute import write_journal

        with tempfile.TemporaryDirectory(prefix="journal-reader-") as directory:
            path = Path(directory) / "compute-launch.json"
            path.write_text("{}")
            reader = path.open("rb")
            unlock = threading.Timer(0.05, reader.close)
            unlock.start()
            try:
                write_journal(path, {"pid": 123})
                self.assertEqual(json.loads(path.read_text()), {"pid": 123})
                self.assertFalse(list(Path(directory).glob("*.tmp")))
            finally:
                unlock.join(2)
                reader.close()

    def test_journal_publication_has_a_finite_retry_and_preserves_prior_record(self):
        from windows_compute import write_journal

        with tempfile.TemporaryDirectory(prefix="journal-denied-") as directory:
            path = Path(directory) / "compute-launch.json"
            path.write_text("{}")
            with path.open("rb"):
                with self.assertRaises(PermissionError):
                    write_journal(path, {"pid": 123}, timeout=0.05)
            self.assertEqual(json.loads(path.read_text()), {})
            self.assertFalse(list(Path(directory).glob("*.tmp")))
