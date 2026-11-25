#!/usr/bin/env python3
"""Turn a placement plan into the hand-off pose table (CSV).

    python pose_table.py --geometry geometry.json --plan placement_plan.json
    # -> <placement dir>/placement_pose_table.csv   (override with --out / --outdir)

Columns: module, ref, value, footprint, origin_x_mm, origin_y_mm, rotation_deg,
courtyard_w_mm, courtyard_h_mm, center_x_mm, center_y_mm, source
``source`` is ``fixed`` for anchors the config pinned and ``placed`` otherwise, so a
reviewer can tell decisions from consequences.  Written UTF-8 with BOM so Excel
opens the Chinese module names correctly.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import projpaths  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--geometry", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", help="CSV to write "
                                  "(default <placement dir>/placement_pose_table.csv)")
    projpaths.add_outdir(ap)
    args = ap.parse_args()

    out_path = projpaths.resolve_out(args.out, "placement_pose_table.csv",
                                     refs=(args.geometry, args.plan),
                                     outdir=args.outdir)

    geo = {g["ref"]: g
           for g in json.load(open(args.geometry, encoding="utf-8-sig"))["footprints"]}
    plan = json.load(open(args.plan, encoding="utf-8-sig"))
    pos = plan["positions"]
    fixed = set(plan.get("fixed", []))
    order = list(plan["modules"].keys())

    rows = []
    for mod in order:
        for ref in plan["modules"][mod]:
            if ref not in pos:
                continue
            p = pos[ref]
            x0, y0, x1, y1 = geo[ref]["bbox_local"]
            t = math.radians(p["rot"])
            c, s = math.cos(t), math.sin(t)
            pts = [(lx * c + ly * s, -lx * s + ly * c) for lx in (x0, x1) for ly in (y0, y1)]
            xs = [q[0] for q in pts]
            ys = [q[1] for q in pts]
            rows.append({
                "module": mod, "ref": ref, "value": geo[ref]["value"],
                "footprint": geo[ref]["libid"],
                "origin_x_mm": "%.3f" % p["x"], "origin_y_mm": "%.3f" % p["y"],
                "rotation_deg": "%.4g" % (p["rot"] % 360),
                "courtyard_w_mm": "%.2f" % (max(xs) - min(xs)),
                "courtyard_h_mm": "%.2f" % (max(ys) - min(ys)),
                "center_x_mm": "%.2f" % (p["x"] + (min(xs) + max(xs)) / 2),
                "center_y_mm": "%.2f" % (p["y"] + (min(ys) + max(ys)) / 2),
                "source": "fixed" if ref in fixed else "placed",
            })

    cols = ["module", "ref", "value", "footprint", "origin_x_mm", "origin_y_mm",
            "rotation_deg", "courtyard_w_mm", "courtyard_h_mm",
            "center_x_mm", "center_y_mm", "source"]
    with open(out_path, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print("wrote %s (%d rows)" % (out_path, len(rows)))
    by_module = {}
    for r in rows:
        by_module[r["module"]] = by_module.get(r["module"], 0) + 1
    print("per module:", by_module)


if __name__ == "__main__":
    main()
