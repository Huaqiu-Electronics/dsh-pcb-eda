#!/usr/bin/env python3
"""Apply a Phase-1 placement plan to the OPEN board through KiCad's IPC API.

    python apply_via_ipc.py --plan placement_plan.json            # preview commit
    python apply_via_ipc.py --plan placement_plan.json --save     # and persist

This is the preferred way to get a placement into KiCad.  KiCad owns the objects,
the UUIDs, the connectivity and the undo history, and the whole placement lands as
ONE undo step - the user evaluates it with a single Ctrl+Z.

Read the kicad-ipc skill before changing this script.  Rules that matter here:

* never edit .kicad_pcb by hand while an editor has the board open
* one commit for the whole batch, dropped on any validation failure
* re-read the updated footprints and compare them with the plan - ``update_items``
  returning without raising is not proof that the board now matches the plan
* ``board.save()`` only when the user asked for it

Before running: kicad_ipc_diagnose must be ok, and DSH needs Full Access so the
KiCad pipe is reachable.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import projpaths  # noqa: E402
from kipy.geometry import Angle, Vector2  # noqa: E402

from kipy_common import close_kicad, connect_board  # noqa: E402


def load_plan(path):
    """Accept pack.py's placement_plan.json or report.py's pose table CSV."""
    if path.lower().endswith(".json"):
        plan = json.load(open(path, encoding="utf-8-sig"))
        target = {ref: (p["x"], p["y"], p["rot"] % 360)
                  for ref, p in plan["positions"].items()}
        unplaced = plan.get("unplaced", [])
        fixed = set(plan.get("fixed", []))
        return target, unplaced, fixed
    target, fixed = {}, set()
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            target[row["ref"]] = (float(row["origin_x_mm"]), float(row["origin_y_mm"]),
                                  float(row["rotation_deg"]) % 360)
            if row.get("source") == "fixed":
                fixed.add(row["ref"])
    return target, [], fixed


def angle_delta(a, b):
    """Smallest signed difference between two angles, in degrees."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def connect_or_explain():
    """Connect to the running PCB Editor, or stop with something actionable.

    A raw traceback here is useless: every cause below has a different fix, and
    none of them is "edit the board file by hand".
    """
    try:
        return connect_board()
    except Exception as exc:  # noqa: BLE001 - the causes are all environment-level
        raise SystemExit(
            "cannot place anything: KiCad IPC is not usable (%s: %s)\n"
            "  - is the PCB Editor open, showing the board this plan was made from?\n"
            "  - is the KiCad API service enabled (Preferences > Plugins) and the\n"
            "    editor restarted after enabling it?\n"
            "  - is DSH running with Full Access? a restricted sandbox blocks KiCad's\n"
            "    named pipe even when the GUI is up.\n"
            "  - is another KiCad process (project manager) holding the socket? close\n"
            "    it and leave only the PCB Editor running.\n"
            "Run kicad_ipc_diagnose first - it separates a broken environment from a\n"
            "busy editor. Do not fall back to hand-editing the .kicad_pcb unless the\n"
            "user explicitly accepts an offline file instead." % (type(exc).__name__, exc)
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", required=True, help="placement_plan.json or pose table CSV")
    ap.add_argument("--save", action="store_true",
                    help="save the PCB over IPC once the batch is verified")
    ap.add_argument("--include-fixed", action="store_true",
                    help="also move parts the plan marks as fixed (off by default)")
    ap.add_argument("--tolerance-mm", type=float, default=1e-3)
    ap.add_argument("--tolerance-deg", type=float, default=1e-3)
    ap.add_argument("--dry-run", action="store_true",
                    help="connect, validate and report, but change nothing")
    ap.add_argument("--report", help="log to write "
                                     "(default <placement dir>/apply_via_ipc.txt)")
    ap.add_argument("--no-report", action="store_true",
                    help="print only; leave no log file behind")
    projpaths.add_outdir(ap)
    args = ap.parse_args()

    tee = None
    if not args.no_report:
        report = projpaths.resolve_out(args.report, "apply_via_ipc.txt",
                                       refs=(args.plan,), outdir=args.outdir)
        tee = projpaths.start_report(report)
        print("report: %s\n" % report)

    target, unplaced, fixed = load_plan(args.plan)
    if unplaced:
        raise SystemExit("the plan still has %d unplaced part(s): %s"
                         % (len(unplaced), unplaced))

    kicad, board = connect_or_explain()
    try:
        footprints = list(board.get_footprints())
        by_ref = {}
        for fp in footprints:
            ref = fp.reference_field.text.value
            if ref in by_ref:
                raise SystemExit("the open board has two footprints with reference %r" % ref)
            by_ref[ref] = fp

        # ---- 1. locate and pre-validate, before touching anything ----------
        missing = sorted(set(target) - set(by_ref))
        if missing:
            raise SystemExit("the open board has no footprint(s) %s; nothing was changed.\n"
                             "Open the board this plan was made from." % missing)
        skip = fixed if not args.include_fixed else set()
        locked = sorted(r for r in target
                        if r not in skip and getattr(by_ref[r], "locked", False))
        if locked:
            raise SystemExit("refusing to move locked footprint(s) %s" % locked)

        moves = []
        for ref in sorted(target):
            if ref in skip:
                continue
            x, y, rot = target[ref]
            fp = by_ref[ref]
            old = (fp.position.x / 1e6, fp.position.y / 1e6, fp.orientation.degrees)
            if (abs(old[0] - x) < args.tolerance_mm and abs(old[1] - y) < args.tolerance_mm
                    and angle_delta(old[2], rot) < args.tolerance_deg):
                continue
            moves.append((ref, fp, x, y, rot, old))

        print("footprints on the open board : %d" % len(footprints))
        print("poses in the plan            : %d" % len(target))
        print("fixed parts left alone       : %d" % len(skip))
        print("parts to move                : %d" % len(moves))
        if args.dry_run:
            for ref, _, x, y, rot, old in moves[:20]:
                print("   %-8s (%8.3f,%8.3f,%6.1f) -> (%8.3f,%8.3f,%6.1f)"
                      % (ref, old[0], old[1], old[2], x, y, rot))
            print("dry run - the board was not touched")
            return

        # ---- 2. one commit for the whole placement -------------------------
        commit = board.begin_commit()
        try:
            for _, fp, x, y, rot, _ in moves:
                fp.position = Vector2.from_xy_mm(x, y)
                fp.orientation = Angle.from_degrees(rot)
            updated = board.update_items([m[1] for m in moves])
            if len(updated) != len(moves):
                raise RuntimeError("KiCad updated %d objects, expected %d"
                                   % (len(updated), len(moves)))
            board.push_commit(commit, "Phase-1 initial placement (%d footprints)" % len(moves))
        except Exception:
            board.drop_commit(commit)
            raise

        # ---- 3. verify against what KiCad now reports ----------------------
        board = kicad.get_board()
        by_ref = {fp.reference_field.text.value: fp for fp in board.get_footprints()}
        bad = []
        for ref, _, x, y, rot, _ in moves:
            fp = by_ref[ref]
            if (abs(fp.position.x / 1e6 - x) > args.tolerance_mm
                    or abs(fp.position.y / 1e6 - y) > args.tolerance_mm
                    or angle_delta(fp.orientation.degrees, rot) > args.tolerance_deg):
                bad.append((ref, fp.position.x / 1e6, fp.position.y / 1e6,
                            fp.orientation.degrees, x, y, rot))
        print("read-back mismatches         : %d" % len(bad))
        for b in bad[:20]:
            print("   %-8s KiCad (%8.3f,%8.3f,%7.1f) vs plan (%8.3f,%8.3f,%7.1f)" % b)
        if bad:
            print("! the commit is in KiCad's undo stack; press Ctrl+Z once to revert it")

        print("\nApplied as ONE undo step. Review it in the PCB editor; Ctrl+Z reverts"
              " the whole placement.")
        if args.save and not bad:
            board.save()
            print("Saved the PCB over IPC.")
        elif args.save:
            print("Not saving: the read-back did not match the plan.")
        else:
            print("Not saved: pass --save once you are happy, or save from the GUI.")
    finally:
        close_kicad(kicad)

    if tee is not None:
        tee.close()
        print("report written to %s" % tee.path)


if __name__ == "__main__":
    main()
