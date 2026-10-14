"""Windows ctypes declarations. No task ownership or PCB operations live here."""

import ctypes
from ctypes import wintypes

KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
HANDLE = wintypes.HANDLE
SIZE = ctypes.c_size_t


class StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("reserved", wintypes.LPWSTR),
        ("desktop", wintypes.LPWSTR),
        ("title", wintypes.LPWSTR),
        ("x", wintypes.DWORD),
        ("y", wintypes.DWORD),
        ("xsize", wintypes.DWORD),
        ("ysize", wintypes.DWORD),
        ("xchars", wintypes.DWORD),
        ("ychars", wintypes.DWORD),
        ("fill", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("show", wintypes.WORD),
        ("reserved_size", wintypes.WORD),
        ("reserved2", ctypes.c_void_p),
        ("stdin", HANDLE),
        ("stdout", HANDLE),
        ("stderr", HANDLE),
    ]


class StartupInfoEx(ctypes.Structure):
    _fields_ = [("startup", StartupInfo), ("attributes", ctypes.c_void_p)]


class ProcessInformation(ctypes.Structure):
    _fields_ = [
        ("process", HANDLE),
        ("thread", HANDLE),
        ("pid", wintypes.DWORD),
        ("tid", wintypes.DWORD),
    ]


def api(name, args, rest=wintypes.BOOL):
    fn = getattr(KERNEL32, name)
    fn.argtypes, fn.restype = args, rest
    return fn


close = api("CloseHandle", [HANDLE])
open_process = api("OpenProcess", [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], HANDLE)
times = api("GetProcessTimes", [HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4)
wait = api("WaitForSingleObject", [HANDLE, wintypes.DWORD], wintypes.DWORD)
duplicate = api(
    "DuplicateHandle",
    [HANDLE, HANDLE, HANDLE, ctypes.POINTER(HANDLE), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD],
)
current = api("GetCurrentProcess", [], HANDLE)
open_job = api("OpenJobObjectW", [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR], HANDLE)
terminate_job = api("TerminateJobObject", [HANDLE, wintypes.UINT])
in_job = api("IsProcessInJob", [HANDLE, HANDLE, ctypes.POINTER(wintypes.BOOL)])
compare = ctypes.WinDLL("KernelBase", use_last_error=True).CompareObjectHandles
compare.argtypes, compare.restype = [HANDLE, HANDLE], wintypes.BOOL
init_attrs = api(
    "InitializeProcThreadAttributeList",
    [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(SIZE)],
)
update_attrs = api(
    "UpdateProcThreadAttribute",
    [
        ctypes.c_void_p,
        wintypes.DWORD,
        SIZE,
        ctypes.c_void_p,
        SIZE,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ],
)
delete_attrs = api("DeleteProcThreadAttributeList", [ctypes.c_void_p], None)
create_process = api(
    "CreateProcessW",
    [
        wintypes.LPCWSTR,
        wintypes.LPWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.BOOL,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.POINTER(ProcessInformation),
    ],
)
resume = api("ResumeThread", [HANDLE], wintypes.DWORD)


def checked(value):
    if not value:
        raise ctypes.WinError(ctypes.get_last_error())
    return value
