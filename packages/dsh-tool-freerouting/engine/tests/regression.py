"""Exercise stopping through the actual bundled HTTP engine, without KiCad."""

import argparse
import base64
import json
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java", type=Path, default=ROOT / "bundled/jre/bin/java.exe")
    parser.add_argument("--jar", type=Path, default=ROOT / "bundled/freerouting.jar")
    parser.add_argument("--dsn", type=Path, default=Path(__file__).with_name("blocked.dsn"))
    args = parser.parse_args()
    with socket.socket() as port_selector:
        port_selector.bind(("127.0.0.1", 0))
        port = port_selector.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    headers = {
        "Content-Type": "application/json",
        "Freerouting-Profile-ID": "3d3f8948-79c8-4b5e-a7a7-6e3f77f9d98c",
        "Freerouting-Profile-Email": "engine-regression@example.com",
        "Freerouting-Environment-Host": "dsh-engine-regression/1.0",
    }

    def api(method, path, data=None):
        body = None if data is None else json.dumps(data).encode()
        request = urllib.request.Request(
            base + "/v1" + path, data=body, headers=headers, method=method
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read(48 * 1024 * 1024 + 1)
            assert len(raw) <= 48 * 1024 * 1024
            return json.loads(raw) if raw else {}

    with tempfile.TemporaryDirectory(prefix="freerouting-regression-") as directory:
        config = Path(directory)
        (config / "freerouting.json").write_text(
            json.dumps(
                {
                    # The engine rejects a configuration without the version
                    # discriminator and falls back to the default endpoint, so the
                    # requested port would never be bound. Mirror the launcher.
                    "version": "2.5.0",
                    "api_server": {
                        "enabled": True,
                        "http_allowed": True,
                        "endpoints": [base],
                        "authentication": {"enabled": False},
                    },
                    "gui": {"enabled": False},
                    "profile": {"allow_telemetry": False, "allow_contact": False},
                    "usage_and_diagnostic_data": {"disable_analytics": True},
                }
            )
        )
        with (config / "engine.log").open("wb") as log:
            engine = subprocess.Popen(
                [
                    str(args.java.resolve()),
                    "-Xmx2G",
                    "-Djdk.net.unixdomain.tmpdir=C:/Windows/Temp",
                    "-jar",
                    str(args.jar.resolve()),
                    "--user_data_path=" + str(config),
                    "--gui.enabled=false",
                    "--api_server.enabled=true",
                    "--api_server.http_allowed=true",
                ],
                stdout=log,
                stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            jobs = []
            try:
                ready_by = time.monotonic() + 30
                while True:
                    try:
                        api("GET", "/system/status")
                        break
                    except Exception:
                        if time.monotonic() >= ready_by:
                            raise AssertionError("Bundled engine did not start")
                        time.sleep(0.25)
                session = api("POST", "/sessions/create", {})["id"]
                results = []
                # A dense crossing fixture lasts long enough to observe live paths.
                # Never use the user's board or change KiCad for this engine check.
                count = 36
                placements = []
                networks = []
                for i in range(count):
                    left = 5000 + i * 1000
                    right = 5000 + ((i * 13) % count) * 1000
                    placements += [
                        f"(place L{i} 5000 {left} front 0)",
                        f"(place R{i} 45000 {right} front 0)",
                    ]
                    networks.append(f"(net N{i} (pins L{i}-1 R{i}-1))")
                preview_dsn = f"""(pcb live-preview (resolution um 10) (unit um)
                    (structure (layer F.Cu (type signal) (property (index 0)))
                      (layer B.Cu (type signal) (property (index 1)))
                      (boundary (path pcb 0 0 0 50000 0 50000 45000 0 45000 0 0))
                      (via Via) (rule (width 200) (clearance 200)))
                    (placement (component Pin {" ".join(placements)}))
                    (library (image Pin (pin Pad 1 0 0))
                      (padstack Pad (shape (circle F.Cu 600)) (attach off))
                      (padstack Via (shape (circle F.Cu 600))
                        (shape (circle B.Cu 600)) (attach off)))
                    (network {" ".join(networks)}) (wiring))"""
                live_job = api(
                    "POST",
                    "/jobs/enqueue",
                    {"name": "live-preview", "priority": "NORMAL", "session_id": session},
                )["id"]
                jobs.append(live_job)
                api(
                    "POST",
                    f"/jobs/{live_job}/input",
                    {
                        "filename": "preview.dsn",
                        "data": base64.b64encode(preview_dsn.encode()).decode(),
                    },
                )
                live_settings = api("GET", f"/jobs/{live_job}/settings")
                live_settings["autorouter"]["max_passes"] = 5
                live_settings["optimizer"]["enabled"] = False
                live_settings["job_timeout"] = "00:00:20"
                api("POST", f"/jobs/{live_job}/settings", live_settings)
                api("PUT", f"/jobs/{live_job}/start")
                preview_by = time.monotonic() + 30
                snapshots = set()
                while time.monotonic() < preview_by:
                    state = api("GET", f"/jobs/{live_job}")["state"]
                    if state not in ["QUEUED", "READY_TO_START", "RUNNING", "STOPPING"]:
                        break
                    if state == "RUNNING":
                        try:
                            output = api("GET", f"/jobs/{live_job}/output").get("data")
                            still_running = api("GET", f"/jobs/{live_job}")["state"] == "RUNNING"
                            if output and still_running:
                                content = base64.b64decode(output).decode()
                                if "(wire" in content and "(path" in content:
                                    snapshots.add(content)
                        except urllib.error.HTTPError as error:
                            if error.code not in [404, 409, 500]:
                                raise
                    if len(snapshots) >= 2:
                        break
                    time.sleep(0.02)
                assert len(snapshots) >= 2, "Engine did not expose changing paths while RUNNING"
                api("PUT", f"/jobs/{live_job}/cancel")
                cancel_by = time.monotonic() + 15
                while time.monotonic() < cancel_by:
                    state = api("GET", f"/jobs/{live_job}")["state"]
                    if state == "CANCELLED":
                        break
                    time.sleep(0.05)
                assert state == "CANCELLED", "Cancelled preview computation did not stop"
                results.append(
                    {
                        "case": "live-preview",
                        "running_snapshots": len(snapshots),
                        "cancelState": state,
                    }
                )
                for label, settings, expected in [
                    ("pass-limit", {"max_passes": 1, "job_timeout": "00:01:00"}, "COMPLETED"),
                    ("deadline", {"max_passes": 10000, "job_timeout": "00:00:01"}, "TIMED_OUT"),
                ]:
                    job = api(
                        "POST",
                        "/jobs/enqueue",
                        {"name": label, "priority": "NORMAL", "session_id": session},
                    )["id"]
                    jobs.append(job)
                    api(
                        "POST",
                        f"/jobs/{job}/input",
                        {
                            "filename": "blocked.dsn",
                            "data": base64.b64encode(
                                preview_dsn.encode()
                                if label == "deadline"
                                else args.dsn.read_bytes()
                            ).decode(),
                        },
                    )
                    effective = api("GET", f"/jobs/{job}/settings")
                    effective["autorouter"]["max_passes"] = settings["max_passes"]
                    effective["optimizer"]["enabled"] = False
                    effective["job_timeout"] = settings["job_timeout"]
                    api("POST", f"/jobs/{job}/settings", effective)
                    configured = api("GET", f"/jobs/{job}")["router_settings"]
                    assert configured["autorouter"]["max_passes"] == settings["max_passes"]
                    api("PUT", f"/jobs/{job}/start")
                    finish_by = time.monotonic() + 80
                    while True:
                        status = api("GET", f"/jobs/{job}")
                        state = status["state"]
                        if state not in ["QUEUED", "READY_TO_START", "RUNNING", "STOPPING"]:
                            break
                        if time.monotonic() >= finish_by:
                            raise AssertionError(f"{label} did not stop")
                        time.sleep(0.05)
                    assert state == expected, f"{label}: expected {expected}, got {state}"
                    logs = api("GET", f"/jobs/{job}/logs")
                    passes = [
                        int(n) for n in re.findall(r"Auto-routing pass #(\d+)", json.dumps(logs))
                    ]
                    if label == "pass-limit":
                        assert max(passes, default=0) == 1, f"Pass limit ignored: {passes}"
                        assert api("GET", f"/jobs/{job}/output").get("data"), "Final output missing"
                    for _ in range(20):
                        time.sleep(0.1)
                        assert api("GET", f"/jobs/{job}")["state"] == expected, (
                            "Terminal state changed"
                        )
                    results.append(
                        {"case": label, "state": state, "passes": max(passes, default=0)}
                    )
                print(json.dumps({"passed": results}))
            finally:
                for job in jobs:
                    try:
                        api("PUT", f"/jobs/{job}/cancel")
                    except Exception:
                        pass
                engine.terminate()
                try:
                    engine.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    engine.kill()
                    engine.wait(timeout=10)


if __name__ == "__main__":
    main()
