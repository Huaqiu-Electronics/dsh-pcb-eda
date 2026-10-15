"""Bind a Windows named-pipe server to its PID and creation time, including PID reuse."""

import ctypes
from ctypes import wintypes

from specctra import require


def identity(socket: str) -> str:
    require(socket.startswith("ipc://"), "INVALID_SOCKET", "仅支持本地 IPC named pipe")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetNamedPipeServerProcessId.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    pipe = kernel.CreateFileW("\\\\.\\pipe\\" + socket[6:], 0xC0000000, 0, None, 3, 0, None)
    require(
        pipe not in (None, ctypes.c_void_p(-1).value),
        "INSTANCE_IDENTITY_FAILED",
        "无法确认 IPC 实例进程",
    )
    pid = wintypes.ULONG()
    try:
        require(
            kernel.GetNamedPipeServerProcessId(pipe, ctypes.byref(pid)),
            "INSTANCE_IDENTITY_FAILED",
            "无法读取 IPC 实例进程标识",
        )
    finally:
        kernel.CloseHandle(pipe)
    process = kernel.OpenProcess(0x1000, False, pid.value)
    require(bool(process), "INSTANCE_IDENTITY_FAILED", "无法确认 IPC 实例启动时间")
    times = [wintypes.FILETIME() for _ in range(4)]
    try:
        require(
            kernel.GetProcessTimes(process, *(ctypes.byref(t) for t in times)),
            "INSTANCE_IDENTITY_FAILED",
            "无法读取 IPC 实例启动时间",
        )
    finally:
        kernel.CloseHandle(process)
    return f"{pid.value}:{times[0].dwHighDateTime:x}:{times[0].dwLowDateTime:x}"
