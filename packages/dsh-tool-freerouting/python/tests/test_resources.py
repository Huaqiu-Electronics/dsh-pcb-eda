"""Resource sampling retains commit/private semantics and fails closed on denial."""

import ctypes
import os
import subprocess
import sys
import unittest
from ctypes import wintypes
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows_resources import psutil, sample


class ResourceTests(unittest.TestCase):
    def test_memory_metrics_keep_existing_meaning(self):
        process = Mock()
        process.children.return_value = []
        process.memory_info.return_value = SimpleNamespace(private=123, rss=456)
        with (
            patch("windows_resources.psutil.Process", return_value=process),
            patch(
                "windows_resources.psutil.virtual_memory",
                return_value=SimpleNamespace(total=1000, available=800),
            ),
            patch(
                "windows_resources.win32api.GlobalMemoryStatusEx",
                return_value={"AvailPageFile": 700},
            ),
        ):
            self.assertEqual(
                sample([42]),
                {
                    "available": 800,
                    "commitAvailable": 700,
                    "total": 1000,
                    "processes": [{"pid": 42, "private": 123, "working": 456}],
                },
            )

    def test_access_denied_is_not_a_zero_memory_sample(self):
        with patch("windows_resources.psutil.Process", side_effect=psutil.AccessDenied(42)):
            with self.assertRaises(psutil.AccessDenied):
                sample([42])

    def test_exited_process_is_ignored(self):
        with patch("windows_resources.psutil.Process", side_effect=psutil.NoSuchProcess(42)):
            self.assertEqual(sample([42])["processes"], [])

    def test_real_descendant_is_counted_once_and_sampling_releases_handles(self):
        child = subprocess.Popen(
            [sys.executable, "-B", "-c", "import time; time.sleep(30)"],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            current = psutil.Process()
            baseline = current.num_handles()
            for _ in range(12):
                snapshot = sample([os.getpid(), child.pid])
                pids = [item["pid"] for item in snapshot["processes"]]
                self.assertEqual(pids.count(child.pid), 1)
                self.assertEqual(pids.count(os.getpid()), 1)
            self.assertLessEqual(current.num_handles(), baseline + 2)
            memory = (ctypes.c_ulonglong * 8)()
            # Independent native oracle: DWORD length/load followed by seven uint64s.
            memory[0] = ctypes.sizeof(memory)
            native = ctypes.WinDLL("kernel32", use_last_error=True).GlobalMemoryStatusEx
            native.argtypes = [ctypes.c_void_p]
            native.restype = wintypes.BOOL
            self.assertTrue(native(ctypes.byref(memory)))
            self.assertEqual(snapshot["total"], memory[1])
            self.assertLess(abs(snapshot["commitAvailable"] - memory[4]), 256 * 1024 * 1024)
        finally:
            child.kill()
            child.wait(timeout=5)
