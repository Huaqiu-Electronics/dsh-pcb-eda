"""Catch CPU/allocation churn when a completed job remains downloadable."""

import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jdk", required=True, type=Path)
    parser.add_argument("--jar", type=Path, default=ROOT / "bundled/freerouting.jar")
    args = parser.parse_args()
    reply = subprocess.run(
        [
            str(args.jdk / "bin/java.exe"),
            "-Xmx512M",
            "-cp",
            str(args.jar.resolve()),
            str(Path(__file__).with_name("SchedulerIdleRegression.java")),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if reply.returncode:
        raise AssertionError(reply.stdout[-2000:] + reply.stderr[-2000:])
    measurement = json.loads(reply.stdout.strip())
    print(json.dumps({"passed": "completed-job-idle", **measurement}))


if __name__ == "__main__":
    main()
