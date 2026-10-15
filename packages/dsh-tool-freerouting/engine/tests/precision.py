"""Verify the real SES writer and native KiCad import preserve short segments."""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pcbnew

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jdk", required=True, type=Path)
    parser.add_argument("--jar", type=Path, default=ROOT / "bundled/freerouting.jar")
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT / "python"))
    from specctra import ses_geometry

    with tempfile.TemporaryDirectory(prefix="ses-precision-") as directory:
        result = subprocess.run(
            [
                str(args.jdk / "bin/java.exe"),
                "-cp",
                str(args.jar.resolve()),
                str(Path(__file__).with_name("PrecisionRegression.java")),
                directory,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if result.returncode:
            raise AssertionError(result.stdout[-2000:] + result.stderr[-2000:])
        cases = []
        for path in sorted(Path(directory).glob("*.ses")):
            expected = ses_geometry(path.read_text(), {"F.Cu", "B.Cu"}, {"GND"})
            assert len(expected) == 1, "Writer lost or duplicated a segment"
            board = pcbnew.BOARD()
            board.Add(pcbnew.NETINFO_ITEM(board, "GND"))
            assert pcbnew.ImportSpecctraSES(board, str(path)), "Native SES import failed"
            tracks = list(board.GetTracks())
            assert len(tracks) == 1, "Native import lost or duplicated a segment"
            track = tracks[0]
            a, b = (track.GetStart().x, track.GetStart().y), (track.GetEnd().x, track.GetEnd().y)
            actual = (
                "track",
                track.GetNetname(),
                track.GetLayerName(),
                track.GetWidth(),
                *sorted((a, b)),
            )
            assert actual == expected[0], f"Native coordinates differ: {actual} != {expected[0]}"
            assert (a == b) == path.stem.endswith("-point"), "Native trace geometry changed"
            cases.append(path.stem)
        assert len(cases) == 7
        print(
            json.dumps(
                {"passed": cases, "nativeCoordinatesExact": True, "subNanometreRejected": True}
            )
        )


if __name__ == "__main__":
    main()
