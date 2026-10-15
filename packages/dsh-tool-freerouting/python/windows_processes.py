"""Read process identities and confirm stale board leases under an OS mutex."""

import ctypes
import json
from ctypes import wintypes
from pathlib import Path

from windows_api import HANDLE, api, close, open_process, times, wait

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x100000
ERROR_INVALID_PARAMETER = 87
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


def process_identity(
    pid: int, expected_birth: str | None = None, precision: str = "filetime"
) -> dict:
    """An unreadable identity is unknown, never evidence that its process exited."""
    if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
        raise ValueError("Invalid process identifier")
    if expected_birth is not None and (
        not isinstance(expected_birth, str) or not expected_birth.isdecimal()
    ):
        raise ValueError("Invalid process creation time")
    if precision not in ("filetime", "microseconds"):
        raise ValueError("Invalid creation-time precision")
    handle = open_process(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid)
    if not handle:
        state = "closed" if ctypes.get_last_error() == ERROR_INVALID_PARAMETER else "unknown"
        return {"pid": pid, "state": state}
    try:
        values = [wintypes.FILETIME() for _ in range(4)]
        if not times(handle, *(ctypes.byref(value) for value in values)):
            return {"pid": pid, "state": "unknown"}
        ticks = (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime
        # Lease files historically used CIM timestamps, which truncate to microseconds.
        # Editor pipe identities use the full 100-nanosecond FILETIME instead.
        birth = str(ticks - ticks % 10 if precision == "microseconds" else ticks)
        result = wait(handle, 0)
        if result == 0 or expected_birth is not None and birth != expected_birth:
            return {"pid": pid, "state": "closed", "birth": birth}
        if result != 0x102:
            return {"pid": pid, "state": "unknown"}
        return {"pid": pid, "state": "alive", "birth": birth}
    finally:
        close(handle)


def process_identities(processes: list[dict]) -> dict:
    return {
        "processes": [
            process_identity(item["pid"], item.get("birth"), item.get("precision", "filetime"))
            for item in processes
        ]
    }


def confirm_board(paths: dict) -> dict:
    """Hold an exclusive Windows file handle until ownership and deletion settle."""
    mutex = None
    try:
        create_file = api(
            "CreateFileW",
            [
                wintypes.LPCWSTR,
                wintypes.DWORD,
                wintypes.DWORD,
                ctypes.c_void_p,
                wintypes.DWORD,
                wintypes.DWORD,
                HANDLE,
            ],
            HANDLE,
        )
        mutex = create_file(paths["confirmation"], 0xC0000000, 0, None, 4, 0x80, None)
        if mutex in (None, INVALID_HANDLE_VALUE):
            raise ctypes.WinError(ctypes.get_last_error())
        lease_path = Path(paths["lease"])
        if lease_path.exists():
            lease = json.loads(lease_path.read_text(encoding="utf-8"))
            if not isinstance(lease, dict) or not lease.get("runId") or not lease.get("birth"):
                raise ValueError("Invalid lease")
            owners = [(lease["pid"], lease["birth"])]
            if lease.get("helperPid"):
                if not lease.get("helperBirth"):
                    raise ValueError("Invalid helper identity")
                owners.append((lease["helperPid"], lease["helperBirth"]))
            if any(
                process_identity(pid, birth, "microseconds")["state"] != "closed"
                for pid, birth in owners
            ):
                return {
                    "ok": False,
                    "code": "BOARD_RUN_ACTIVE",
                    "message": f"任务 {lease['runId']} 的进程尚未退出，不能解除标记",
                }
        lease_path.unlink(missing_ok=True)
        Path(paths["marker"]).unlink(missing_ok=True)
        return {"ok": True}
    except (OSError, ValueError, KeyError, TypeError):
        return {
            "ok": False,
            "code": "BOARD_CONFIRM_FAILED",
            "message": "无法独占并确认目标板子状态；标记未解除，请稍后重试",
        }
    finally:
        if mutex not in (None, INVALID_HANDLE_VALUE):
            close(mutex)
