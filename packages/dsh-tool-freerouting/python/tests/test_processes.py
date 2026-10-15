"""Real process-identity and exclusive confirmation checks, on isolated files."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows_processes import confirm_board, process_identity


class ProcessTests(unittest.TestCase):
    def paths(self, directory):
        return {name: str(Path(directory) / name) for name in ("lease", "marker", "confirmation")}

    def lease(self, paths, **extra):
        record = {
            "pid": os.getpid(),
            "birth": process_identity(os.getpid(), precision="microseconds")["birth"],
            "runId": "isolated-run",
            **extra,
        }
        Path(paths["lease"]).write_text(json.dumps(record))
        Path(paths["marker"]).write_text('{"state":"uncertain"}')

    def test_current_identity_and_reused_pid(self):
        identity = process_identity(os.getpid())
        self.assertEqual(identity["state"], "alive")
        self.assertTrue(identity["birth"].isdecimal())
        self.assertEqual(process_identity(os.getpid(), "0")["state"], "closed")

    def test_lease_precision_preserves_cim_values_without_rounding_editor_identity(self):
        raw = process_identity(os.getpid())["birth"]
        coarse = process_identity(os.getpid(), precision="microseconds")["birth"]
        self.assertEqual(int(coarse), int(raw) - int(raw) % 10)
        self.assertEqual(process_identity(os.getpid(), coarse, "microseconds")["state"], "alive")
        self.assertEqual(process_identity(os.getpid(), raw)["state"], "alive")
        with self.assertRaises(ValueError):
            process_identity(os.getpid(), precision="unknown")

    def test_access_failure_is_unknown_not_closed(self):
        with (
            patch("windows_processes.open_process", return_value=None),
            patch("windows_processes.ctypes.get_last_error", return_value=5),
        ):
            self.assertEqual(process_identity(os.getpid())["state"], "unknown")

    def test_invalid_identity_input_is_rejected(self):
        for pid in (True, 0, -1, 2**32):
            with self.subTest(pid=pid), self.assertRaises(ValueError):
                process_identity(pid)
        with self.assertRaises(ValueError):
            process_identity(os.getpid(), "bad")

    def test_confirmation_preserves_live_task_and_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.paths(directory)
            self.lease(paths)
            self.assertEqual(confirm_board(paths)["code"], "BOARD_RUN_ACTIVE")
            self.assertTrue(Path(paths["marker"]).exists())

    def test_confirmation_rejects_unknown_or_malformed_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.paths(directory)
            self.lease(paths)
            with patch("windows_processes.process_identity", return_value={"state": "unknown"}):
                self.assertEqual(confirm_board(paths)["code"], "BOARD_RUN_ACTIVE")
            self.lease(paths, birth=123)
            self.assertEqual(confirm_board(paths)["code"], "BOARD_CONFIRM_FAILED")
            self.assertTrue(Path(paths["marker"]).exists())

    def test_confirmation_preserves_live_protected_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.paths(directory)
            self.lease(
                paths,
                birth="0",
                helperPid=os.getpid(),
                helperBirth=process_identity(os.getpid(), precision="microseconds")["birth"],
            )
            self.assertEqual(confirm_board(paths)["code"], "BOARD_RUN_ACTIVE")
            self.assertTrue(Path(paths["marker"]).exists())

    def test_confirmation_does_not_clear_files_under_another_os_mutex(self):
        import ctypes
        from ctypes import wintypes

        from windows_api import HANDLE, api, close

        with tempfile.TemporaryDirectory() as directory:
            paths = self.paths(directory)
            self.lease(paths, birth="0")
            create = api(
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
            mutex = create(paths["confirmation"], 0xC0000000, 0, None, 4, 0x80, None)
            self.assertNotIn(mutex, (None, ctypes.c_void_p(-1).value))
            try:
                self.assertEqual(confirm_board(paths)["code"], "BOARD_CONFIRM_FAILED")
                self.assertTrue(Path(paths["marker"]).exists())
            finally:
                close(mutex)
            self.assertTrue(confirm_board(paths)["ok"])

    def test_confirmation_can_clear_reused_pid_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.paths(directory)
            self.lease(paths, birth="0")
            self.assertTrue(confirm_board(paths)["ok"])
            self.assertFalse(Path(paths["marker"]).exists())
            self.assertTrue(confirm_board(paths)["ok"])
