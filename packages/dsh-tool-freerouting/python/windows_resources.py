"""Read-only Windows process-tree and memory sampling through bundled libraries."""

from compute_types import ResourceSample
from runtime_dependencies import psutil, win32api


def descendants(pids: list[int]) -> set[int]:
    found = set(pids)
    for pid in pids:
        try:
            found.update(child.pid for child in psutil.Process(pid).children(recursive=True))
        except psutil.NoSuchProcess:
            continue
    return found


def sample(pids: list[int]) -> ResourceSample:
    memory = psutil.virtual_memory()
    # swap_memory().free measures page-file usage, not remaining commit capacity.
    # Preserve the existing GlobalMemoryStatusEx protection metric exactly.
    commit_available = win32api.GlobalMemoryStatusEx()["AvailPageFile"]
    processes = []
    for pid in sorted(descendants(pids)):
        try:
            counters = psutil.Process(pid).memory_info()
            processes.append({"pid": pid, "private": counters.private, "working": counters.rss})
        except psutil.NoSuchProcess:
            continue
    return {
        "available": memory.available,
        "commitAvailable": commit_available,
        "total": memory.total,
        "processes": processes,
    }
