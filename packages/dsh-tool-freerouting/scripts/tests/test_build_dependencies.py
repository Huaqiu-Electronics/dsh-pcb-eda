"""Negative controls for artifact integrity and prepared-directory publication."""

import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_dependencies import download_verified, replace_directory


class DependencyBuildTests(unittest.TestCase):
    def test_corrupt_download_is_rejected_and_partial_removed(self):
        checksum = hashlib.sha256(b"expected").hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            with patch("urllib.request.urlopen", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    download_verified("https://example.test/runtime.zip", checksum, cache)
            self.assertEqual(list(cache.iterdir()), [])

    def test_corrupt_cache_is_replaced_only_by_verified_download(self):
        content = b"verified artifact"
        checksum = hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            target = cache / "runtime.zip"
            target.write_bytes(b"corrupt old cache")
            with patch("urllib.request.urlopen", return_value=io.BytesIO(content)) as download:
                self.assertEqual(
                    download_verified("https://example.test/runtime.zip", checksum, cache), target
                )
                download.assert_called_once()
            with patch("urllib.request.urlopen") as download:
                self.assertEqual(
                    download_verified("https://example.test/runtime.zip", checksum, cache), target
                )
                download.assert_not_called()
            self.assertEqual(target.read_bytes(), content)

    def test_directory_publication_failure_restores_previous_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "vendor"
            target.mkdir()
            (target / "original").write_bytes(b"keep")
            with self.assertRaises(FileNotFoundError):
                replace_directory(root / "missing-preparation", target, root / "backup")
            self.assertEqual((target / "original").read_bytes(), b"keep")
            self.assertFalse((root / "backup").exists())

    def test_insecure_or_unpinned_download_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                download_verified("http://example.test/runtime.zip", "0" * 64, Path(temporary))
            with self.assertRaises(ValueError):
                download_verified("https://example.test/runtime.zip", "missing", Path(temporary))


if __name__ == "__main__":
    unittest.main()
