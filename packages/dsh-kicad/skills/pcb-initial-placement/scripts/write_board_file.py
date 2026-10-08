#!/usr/bin/env python3
"""FALLBACK ONLY: write a placed board as a NEW .kicad_pcb file, offline.

    python write_board_file.py --board board.kicad_pcb --plan placement_plan.json
    # -> <board dir>/placement/board-placed-preview.kicad_pcb
    #    (override with --out / --outdir; the source board is never the target)

Use this only when KiCad IPC is genuinely unavailable AND the user has accepted an
offline file instead - prefer apply_via_ipc.py.  Reasons this is the worse path:
the result is not in the editor's undo stack, KiCad will not reload it by itself,
and the file stops being the single source of truth the moment someone types in
the GUI.

Safety properties kept anyway:
* the SOURCE board is never modified - a new file is written
* only the depth-1 ``(at x y [rot])`` span of each footprint is replaced, so every
  other byte (UUIDs, nets, pad stacks, 3D models, text effects) survives verbatim
* the rewritten text is re-parsed and every pose is read back before the file is
  written; a mismatch aborts
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import projpaths  # noqa: E402
import sexpr  # noqa: E402


def num(v):
    """Format like KiCad does: 4 decimals, trailing zeros stripped."""
    s = "%.4f" % v
    s = s.rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", required=True, help="source .kicad_pcb (never modified)")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", help="new .kicad_pcb to write (default "
                                  "<placement dir>/<board>-placed-preview.kicad_pcb)")
    projpaths.add_outdir(ap)
    args = ap.parse_args()

    stem = os.path.splitext(os.path.basename(args.board))[0]
    out_path = projpaths.resolve_out(
        args.out, "%s-placed-preview.kicad_pcb" % stem,
        board=args.board, refs=(args.plan,), outdir=args.outdir)

    if os.path.abspath(args.board) == os.path.abspath(out_path):
        raise SystemExit("refusing to overwrite the source board; choose another --out")

    text = open(args.board, encoding="utf-8").read()
    pos = json.load(open(args.plan, encoding="utf-8"))["positions"]
    fps = list(sexpr.root(text).kids("footprint"))

    edits, seen = [], set()
    for fp in fps:
        ref = sexpr.property_value(fp, "Reference")
        if ref not in pos:
            print("!! no planned position for", ref)
            continue
        seen.add(ref)
        at = fp.first("at")                  # first *direct* child named "at"
        assert at is not None, ref
        p = pos[ref]
        r = p["rot"] % 360
        new = ("(at %s %s)" % (num(p["x"]), num(p["y"])) if r == 0
               else "(at %s %s %s)" % (num(p["x"]), num(p["y"]), num(r)))
        edits.append((at.start, at.end, new))

    print("footprints in file   :", len(fps))
    print("poses applied        :", len(edits))
    print("planned but not found:", sorted(set(pos) - seen))

    out = text
    for start, end, new in sorted(edits, reverse=True):   # back to front
        out = out[:start] + new + out[end:]

    chk = sexpr.root(out)
    assert len(list(chk.kids("footprint"))) == len(fps), "footprint count changed"
    bad = 0
    for fp in chk.kids("footprint"):
        ref = sexpr.property_value(fp, "Reference")
        a = fp.first("at").nums()
        p = pos[ref]
        if abs(a[0] - p["x"]) > 1e-4 or abs(a[1] - p["y"]) > 1e-4:
            print("  position mismatch", ref, a[:2], p["x"], p["y"])
            bad += 1
        got = round(a[2]) % 360 if len(a) > 2 else 0
        if got != (p["rot"] % 360):
            print("  rotation mismatch", ref, a, p["rot"])
            bad += 1
    print("read-back mismatches :", bad)
    if bad:
        raise SystemExit("not writing: the rewritten text does not read back as planned")

    open(out_path, "w", encoding="utf-8", newline="").write(out)
    print("wrote %s (%d bytes, source %d)" % (out_path, len(out), len(text)))
    print("reload it in KiCad with File > Open; the original file is untouched")


if __name__ == "__main__":
    main()
