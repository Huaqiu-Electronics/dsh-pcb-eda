"""Developer-only DSN export probe; never imported by the routing runtime."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python" / "vendor"))
import shutil
import tempfile

import pcbnew
from kipy import KiCad


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="dsh-export-probe-"))
    root.mkdir(exist_ok=True)
    b = KiCad().get_board()
    p = root / "board.kicad_pcb"
    p.write_text(b.get_as_string(), encoding="utf-8")
    project = Path(b.document.project.path) / b.document.project.name
    for ext in [".kicad_pro", ".kicad_dru"]:
        src = project.with_suffix(ext)
        if src.exists():
            shutil.copyfile(src, p.with_suffix(ext))
    offline = pcbnew.LoadBoard(str(p))
    print("tracks", len(offline.GetTracks()))
    for t in offline.GetTracks():
        t.SetLocked(True)
    print("export", pcbnew.ExportSpecctraDSN(offline, str(root / "board.dsn")))
    print("netclass count", len(b.get_project().get_net_classes()))
    print("rules:", (root / "board.dsn").read_text(encoding="utf-8")[-6500:])


if __name__ == "__main__":
    main()
