"""Importing a command module must not read input or run a routing operation."""

import subprocess
import sys
import unittest
from pathlib import Path

HELPER_DIRECTORY = Path(__file__).resolve().parents[1]


class EntrypointTests(unittest.TestCase):
    def test_importing_command_modules_does_not_consume_stdin(self):
        for module in ("compute_host", "kicad_helper"):
            with self.subTest(module=module):
                result = subprocess.run(
                    [sys.executable, "-B", "-c", f"import {module}; print('imported')"],
                    cwd=HELPER_DIRECTORY,
                    input="invalid request: must not be consumed",
                    capture_output=True,
                    text=True,
                    timeout=10,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                self.assertEqual(result.returncode, 0, result.stderr[-2000:])
                self.assertEqual(result.stdout.strip(), "imported")


if __name__ == "__main__":
    unittest.main()
