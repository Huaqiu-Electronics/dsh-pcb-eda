"""Windows-owned compute jobs. PCB-mutating helpers must never be job members.

A non-inheritable job handle is duplicated into the DSH host. Windows closes it
when that host dies. DRC also has a helper-owned inner job, so killing either the
host or its read-only helper stops DRC. Creation joins both jobs atomically.
"""

import ctypes
import json
import os
import subprocess
import time
import uuid
from ctypes import wintypes
from pathlib import Path

from compute_types import ComputeRecord, ProcessOwner, ProcessState
from runtime_dependencies import win32job
from windows_api import (
    HANDLE,
    SIZE,
    ProcessInformation,
    StartupInfoEx,
    api,
    checked,
    close,
    compare,
    create_process,
    current,
    delete_attrs,
    duplicate,
    init_attrs,
    open_job,
    open_process,
    resume,
    terminate_job,
    times,
    update_attrs,
    wait,
)


def birth(handle: int) -> str:
    values = [wintypes.FILETIME() for _ in range(4)]
    checked(times(handle, *(ctypes.byref(v) for v in values)))
    return str((values[0].dwHighDateTime << 32) | values[0].dwLowDateTime)


def owner_process(owner: ProcessOwner) -> int:
    handle = checked(open_process(0x40 | 0x1000 | 0x100000, False, int(owner["pid"])))
    try:
        if owner.get("birth") and birth(handle) != owner["birth"]:
            raise RuntimeError("Compute owner changed")
        if wait(handle, 0) == 0:
            raise RuntimeError("Compute owner exited")
        return handle
    except BaseException:
        close(handle)
        raise


def make_job(name: str | None) -> int:
    handle = win32job.CreateJobObject(None, name or "")
    try:
        limits = win32job.QueryInformationJobObject(
            handle, win32job.JobObjectExtendedLimitInformation
        )
        limits["BasicLimitInformation"]["LimitFlags"] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        win32job.SetInformationJobObject(handle, win32job.JobObjectExtendedLimitInformation, limits)
        # Transfer ownership to the existing raw-handle lifecycle. PyHANDLE must
        # not close the handle before atomic process startup or remote duplication.
        return handle.Detach()
    finally:
        if handle:
            handle.Close()


def remote_close(owner_handle: int, remote: str | int, job: int) -> None:
    """Revalidate ownership on every recovery; never close a reused handle."""
    local = HANDLE()
    if not duplicate(
        owner_handle, HANDLE(int(remote)), current(), ctypes.byref(local), 0, False, 2
    ):
        error = ctypes.get_last_error()
        if error == 6:  # ERROR_INVALID_HANDLE: source was already consumed.
            return
        raise ctypes.WinError(error)
    try:
        if not compare(local, job):
            return  # Source was consumed and its numeric value was reused.
    finally:
        close(local)
    consumed = HANDLE()
    # CLOSE_SOURCE may consume on failure; recovery must inspect identity anew.
    # Recovery runs only after the helper exits, so there is a single closer.
    try:
        checked(
            duplicate(
                owner_handle, HANDLE(int(remote)), current(), ctypes.byref(consumed), 0, False, 3
            )
        )
    finally:
        if consumed:
            close(consumed)


def write_journal(path: Path, record: dict, timeout: float = 2) -> None:
    """Publish complete records; Windows readers can briefly deny replacement."""
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(record), encoding="utf-8")
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                os.replace(temporary, path)
                return
            except PermissionError as error:
                if (
                    getattr(error, "winerror", None) not in (5, 32, 33)
                    or time.monotonic() >= deadline
                ):
                    raise
                time.sleep(0.01)
    finally:
        temporary.unlink(missing_ok=True)


def launch(
    argv: list[str], owner: ProcessOwner, directory: str | None = None, inner_job: int | None = None
) -> ComputeRecord:
    host = owner_process(owner)
    owner = {"pid": int(owner["pid"]), "birth": birth(host)}
    name = "Local\\dsh-routing-" + uuid.uuid4().hex
    if directory:
        plan = Path(directory) / "compute-launch.json"
        write_journal(plan, {"job": name, "owner": owner})
    job = make_job(name)
    remote = HANDLE()
    info = ProcessInformation()
    attributes = None
    try:
        size = SIZE()
        init_attrs(None, 1, 0, ctypes.byref(size))
        attributes = ctypes.create_string_buffer(size.value)
        checked(init_attrs(attributes, 1, 0, ctypes.byref(size)))
        jobs = (HANDLE * (2 if inner_job else 1))(*([job, inner_job] if inner_job else [job]))
        checked(update_attrs(attributes, 0, 0x2000D, jobs, ctypes.sizeof(jobs), None, None))
        startup = StartupInfoEx()
        startup.startup.cb = ctypes.sizeof(startup)
        startup.attributes = ctypes.cast(attributes, ctypes.c_void_p)
        # CREATE_SUSPENDED + EXTENDED_STARTUPINFO_PRESENT + CREATE_NO_WINDOW.
        checked(
            create_process(
                str(argv[0]),
                ctypes.create_unicode_buffer(subprocess.list2cmdline(argv)),
                None,
                None,
                False,
                0x8080004,
                None,
                directory,
                ctypes.byref(startup),
                ctypes.byref(info),
            )
        )
        checked(duplicate(current(), job, host, ctypes.byref(remote), 0, False, 2))
        if wait(host, 0) == 0:
            raise RuntimeError("Compute owner exited during startup")
        record = {
            "pid": int(info.pid),
            "birth": birth(info.process),
            "owner": owner,
            "job": name,
            "remote": str(remote.value),
        }
        if directory:
            write_journal(Path(directory) / "compute-launch.json", record)
        # Job membership existed from CreateProcess onward; a crash at every
        # bootstrap point kills the suspended process when handles close.
        if resume(info.thread) == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        return record
    except BaseException:
        terminate_job(job, 1)
        if remote.value and wait(host, 0) != 0:
            remote_close(host, remote.value, job)
        raise
    finally:
        if attributes is not None:
            delete_attrs(attributes)
        if info.thread:
            close(info.thread)
        if info.process:
            close(info.process)
        close(job)
        close(host)


def state(record: ComputeRecord) -> ProcessState:
    process = open_process(0x1000 | 0x100000, False, int(record["pid"]))
    if not process:
        if ctypes.get_last_error() == 87:
            return "closed"
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return "closed" if birth(process) != record["birth"] or wait(process, 0) == 0 else "alive"
    finally:
        close(process)


def job_empty(job: int) -> bool:
    account = win32job.QueryInformationJobObject(job, win32job.JobObjectBasicAccountingInformation)
    return account["ActiveProcesses"] == 0


def stop(record: ComputeRecord) -> None:
    job = open_job(0x1F003F, False, record["job"])
    if not job:
        if state(record) == "closed":
            return
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        checked(terminate_job(job, 1))
        deadline = time.monotonic() + 8
        while state(record) != "closed" or not job_empty(job):
            if time.monotonic() >= deadline:
                raise TimeoutError("Compute exit unconfirmed")
            time.sleep(0.05)
    finally:
        close(job)


def release(record: ComputeRecord) -> None:
    job = open_job(0x1F003F, False, record["job"])
    if not job:
        return
    host = None
    try:
        host = owner_process(record["owner"])
        remote_close(host, record["remote"], job)
    finally:
        if host:
            close(host)
        close(job)


def pin_owner() -> None:
    owner = json.loads(os.environ["DSH_COMPUTE_OWNER"])
    host = owner_process(owner)
    try:
        os.environ["DSH_COMPUTE_OWNER"] = json.dumps({"pid": owner["pid"], "birth": birth(host)})
    finally:
        close(host)


def run_checked(argv: list[str], timeout: float, directory: str | Path | None = None) -> None:
    """DRC has two independent death owners: host and calling helper."""
    owner = json.loads(os.environ.get("DSH_COMPUTE_OWNER", "{}"))
    inner = make_job(None)
    record = None
    try:
        record = launch(
            argv, owner, directory=str(directory) if directory else None, inner_job=inner
        )
        process = checked(open_process(0x1000 | 0x100000, False, record["pid"]))
        try:
            if wait(process, int(timeout * 1000)) == 0x102:
                stop(record)
                raise subprocess.TimeoutExpired(argv, timeout)
            code = wintypes.DWORD()
            checked(
                api("GetExitCodeProcess", [HANDLE, ctypes.POINTER(wintypes.DWORD)])(
                    process, ctypes.byref(code)
                )
            )
            if code.value:
                raise subprocess.CalledProcessError(code.value, argv)
            # DRC completion never authorizes a write after host death.
            host = owner_process(record["owner"])
            close(host)
        finally:
            close(process)
    finally:
        close(inner)
        if record:
            try:
                release_directory(directory) if directory else release(record)
            except (OSError, RuntimeError):
                pass  # Keep the journal; recovery revalidates owner and handle identity.


def stop_directory(directory: str | Path) -> None:
    path = Path(directory) / "compute-launch.json"
    if path.is_file():
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("pid"):
            stop(record)


def release_directory(directory: str | Path) -> None:
    """After helper exit, close its host-owned DRC handle once, including faults."""
    path = Path(directory) / "compute-launch.json"
    if not path.is_file():
        return
    record = json.loads(path.read_text(encoding="utf-8"))
    if not record.get("pid"):
        recover_launch(directory)
        return
    stop(record)  # Wait for every descendant before deleting files or ownership.
    # A prior helper can die before or after CLOSE_SOURCE. The persisted record
    # remains recoverable until release revalidates the exact source identity.
    release(record)
    path.unlink(missing_ok=True)


def recover_launch(directory: str | Path) -> None:
    """A missing bootstrap response must not leave its resumed compute running."""
    path = Path(directory) / "compute-launch.json"
    if not path.is_file():
        return
    plan = json.loads(path.read_text(encoding="utf-8"))
    host = owner_process(plan["owner"])
    job = None
    try:
        job = open_job(0x1F003F, False, plan["job"])
        if not job:
            # The previous closer may already have destroyed the Job. Do not
            # retain a stale journal, but never treat a live process as stopped.
            if plan.get("pid") and state(plan) != "closed":
                raise RuntimeError("Compute job ownership missing for a live process")
            path.unlink(missing_ok=True)
            return
        checked(terminate_job(job, 1))
        deadline = time.monotonic() + 8
        while not job_empty(job):
            if time.monotonic() >= deadline:
                raise TimeoutError("Compute exit unconfirmed")
            time.sleep(0.05)
        if plan.get("remote"):
            # Use the same identity-based recovery as normal shutdown. A helper
            # may have exited before or after consuming the source handle.
            remote_close(host, plan["remote"], job)
        path.unlink(missing_ok=True)
    finally:
        if job:
            close(job)
        close(host)
