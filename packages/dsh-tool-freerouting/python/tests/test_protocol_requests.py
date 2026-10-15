"""Invalid requests must fail before any process or board operation begins."""

import io
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "vendor")]
from protocol_requests import InvalidRequest, compute_request, helper_request


class ProtocolRequestTests(unittest.TestCase):
    def stream(self, request):
        return io.BytesIO(json.dumps(request).encode())

    def test_valid_requests_preserve_values(self):
        request = {
            "command": "launch",
            "argv": [sys.executable, "-c", "pass"],
            "owner": {"pid": 123},
        }
        self.assertEqual(compute_request(self.stream(request)), request)
        request = {
            "socket": "ipc://test.sock",
            "directory": "C:/isolated",
            "nets": [],
            "allowDesignViolations": False,
        }
        self.assertEqual(helper_request(self.stream(request), "import"), request)

    def test_invalid_process_requests_are_rejected(self):
        for request in (
            {"command": "sample", "pids": [True]},
            {"command": "sample", "pids": [-1]},
            {"command": "sample", "pids": [2**32]},
            {"command": "launch", "argv": [], "owner": {"pid": 1}},
            {"command": "launch", "argv": ["program"], "owner": {"pid": 1}, "extra": "ignored?"},
            {"command": "state", "record": {"pid": 1}},
            {"command": "unsupported"},
            [],
        ):
            with self.subTest(request=request), self.assertRaises(InvalidRequest):
                compute_request(self.stream(request))

    def test_invalid_helper_requests_are_rejected_without_echoing_credentials(self):
        secret = "fixture-token-do-not-expose"
        for command, request in (
            ("import", {"socket": "ipc://test", "token": secret}),
            (
                "preview",
                {
                    "socket": "ipc://test",
                    "directory": "C:/isolated",
                    "nets": [False],
                    "token": secret,
                },
            ),
            ("fill", {"socket": "ipc://test", "directory": "C:/isolated", "unknown": secret}),
        ):
            with self.subTest(command=command), self.assertRaises(InvalidRequest) as caught:
                helper_request(self.stream(request), command)
            self.assertEqual(caught.exception.outcome, "unchanged")
            self.assertNotIn(secret, str(caught.exception))

    def test_invalid_and_oversized_json_is_rejected(self):
        for payload in (b"{", b"\xff", b" " * 65537):
            with self.subTest(size=len(payload)), self.assertRaises(InvalidRequest):
                compute_request(io.BytesIO(payload))

    def test_real_fill_entrypoint_reports_unchanged_for_invalid_request(self):
        secret = "fixture-token-do-not-expose"
        reply = subprocess.run(
            [sys.executable, "-B", str(ROOT / "kicad_helper.py"), "fill"],
            input=json.dumps({"token": secret}),
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.assertEqual(reply.returncode, 0, reply.stderr[-1000:])
        envelope = json.loads(reply.stdout)
        self.assertEqual(envelope["code"], "HELPER_REQUEST_INVALID")
        self.assertEqual(envelope["outcome"], "unchanged")
        self.assertNotIn(secret, reply.stdout + reply.stderr)
