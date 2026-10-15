"""Prepare the complete Windows plugin dependencies before checks and packaging."""

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

from build_dependencies import prepare_jre, prepare_vendor, replace_directory, run_logged


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--jdk", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != "win32" or sys.version_info[:2] != (3, 11):
        raise RuntimeError("Run with the selected Windows KiCad Python 3.11")
    root = Path(__file__).resolve().parents[1]
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    if not (args.jdk / "bin/javac.exe").is_file():
        raise RuntimeError("DSH_ENGINE_TEST_JDK must point to a full JDK 25")
    # Stage beside the package for same-volume rename; never remove a user's
    # cache or installation tree. Old runtime directories survive preparation failures.
    with tempfile.TemporaryDirectory(prefix=".dependency-build-", dir=root) as directory:
        work = Path(directory)
        vendor = prepare_vendor(root, work, cache, args.python.resolve())
        jre = prepare_jre(root, work, cache)
        run_logged(
            [
                str(args.python),
                "-B",
                str(root / "engine/build.py"),
                "--jdk",
                str(args.jdk.resolve()),
                "--output",
                str(work / "freerouting.jar"),
                "--gradle-cache",
                str(cache / "gradle"),
                "--check",
            ],
            cache / "engine-build.log",
            1000,
        )
        shutil.copy2(work / "freerouting.build.log", cache / "engine-upstream.log")
        replace_directory(vendor, root / "python/vendor", work / "previous-vendor")
        replace_directory(jre, root / "bundled/jre", work / "previous-jre")
        for filename in ("freerouting.jar", "freerouting.build.json"):
            (work / filename).replace(root / "bundled" / filename)
    print(
        json.dumps(
            {"prepared": True, "cache": str(cache), "engine": "source-built with upstream tests"}
        )
    )


if __name__ == "__main__":
    main()
