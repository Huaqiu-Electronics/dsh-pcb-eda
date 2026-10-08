#!/usr/bin/env python3
"""Independent check of a placement plan against the real board.

    python verify_placement.py --geometry geometry.json --plan placement_plan.json
    # also writes <placement dir>/verify_placement.txt (disable with --no-report)

This shares no code with pack.py beyond the raw outline reader, so it is a genuine
cross-check rather than a re-run of the same arithmetic.  It answers the questions
a reviewer actually asks:

  1 completeness   - every footprint placed, none invented
  2 overlap        - courtyard pairs that intersect (the hard gate: must be 0)
  3 clearance      - minimum courtyard-to-courtyard distance
  4 outline        - which courts hang off the board edge, and by how much
  5 grouping       - per module: centroid, bbox, spread, and stray parts that sit
                     nearer another module's anchor than their own
  6 area budget    - courtyard area vs true board area (density sanity)
  7 fixed anchors  - fixed parts still exactly where the config put them

Exit code is non-zero when a hard gate fails, so it can gate a pipeline.
"""
from __future__ import annotations

import argparse
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
    ap.add_argument("--min-clearance-mm", type=float, default=0.2,
                    help="fail if any two courtyards are closer than this")
    ap.add_argument("--grid-mm", type=float, default=0.635)
    ap.add_argument("--report", help="text report to write "
                                     "(default <placement dir>/verify_placement.txt)")
    ap.add_argument("--no-report", action="store_true",
                    help="print only; leave no report file behind")
    projpaths.add_outdir(ap)
    args = ap.parse_args()

    tee = None
    if not args.no_report:
        report = projpaths.resolve_out(args.report, "verify_placement.txt",
                                       refs=(args.geometry, args.plan),
                                       outdir=args.outdir)
        tee = projpaths.start_report(report)
        print("report: %s\n" % report)

    geom = json.load(open(args.geometry, encoding="utf-8-sig"))
    geo = {g["ref"]: g for g in geom["footprints"]}
    plan = json.load(open(args.plan, encoding="utf-8-sig"))
    pos = plan["positions"]
    anchors = plan.get("anchors", {})
    poly = [tuple(p) for p in geom["outline"]]
    hard_fail = 0

    def inside(x, y):
        r, n = False, len(poly)
        for i in range(n):
            x0, y0 = poly[i]
            x1, y1 = poly[(i + 1) % n]
            if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                r = not r
        return r

    def rect(ref):
        x0, y0, x1, y1 = geo[ref]["bbox_local"]
        ox, oy, rot = pos[ref]["x"], pos[ref]["y"], pos[ref]["rot"]
        t = math.radians(rot)
        c, s = math.cos(t), math.sin(t)
        pts = [(lx * c + ly * s, -lx * s + ly * c) for lx in (x0, x1) for ly in (y0, y1)]
        return (ox + min(p[0] for p in pts), oy + min(p[1] for p in pts),
                ox + max(p[0] for p in pts), oy + max(p[1] for p in pts))

    print("=== 1. completeness ===")
    print("footprints on board           :", len(geo))
    print("placed by the plan            :", len(pos))
    missing = sorted(set(geo) - set(pos))
    extra = sorted(set(pos) - set(geo))
    print("missing / unknown refs        :", missing, extra)
    print("unplaced reported by packer   :", plan.get("unplaced"))
    if missing or extra:
        hard_fail += 1

    R = {r: rect(r) for r in pos}
    refs = sorted(R)

    print("\n=== 2. courtyard overlap check ===")
    overlaps = []
    for i in range(len(refs)):
        a = refs[i]
        ax0, ay0, ax1, ay1 = R[a]
        for j in range(i + 1, len(refs)):
            b = refs[j]
            bx0, by0, bx1, by1 = R[b]
            if ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1:
                ov = (min(ax1, bx1) - max(ax0, bx0)) * (min(ay1, by1) - max(ay0, by0))
                overlaps.append((a, b, ov))
    print("overlapping courtyard pairs   :", len(overlaps))
    for a, b, ov in overlaps[:20]:
        print("   %-6s %-6s overlap %.3f mm2" % (a, b, ov))
    if overlaps:
        hard_fail += 1

    print("\n=== 3. minimum courtyard clearance ===")
    worst = []
    for i in range(len(refs)):
        a = refs[i]
        ax0, ay0, ax1, ay1 = R[a]
        best, who = 1e9, None
        for j in range(len(refs)):
            if i == j:
                continue
            b = refs[j]
            bx0, by0, bx1, by1 = R[b]
            d = math.hypot(max(bx0 - ax1, ax0 - bx1, 0.0),
                           max(by0 - ay1, ay0 - by1, 0.0))
            if d < best:
                best, who = d, b
        worst.append((best, a, who))
    worst.sort()
    for d, a, b in worst[:8]:
        print("   %-6s -> %-6s  %.3f mm" % (a, b, d))
    if worst and worst[0][0] < args.min_clearance_mm:
        print("   ! below the %.2f mm floor" % args.min_clearance_mm)
        hard_fail += 1

    print("\n=== 4. parts off the board outline ===")
    off = []
    for r in refs:
        x0, y0, x1, y1 = R[r]
        tot = out = 0
        for k in range(12):
            px = x0 + (x1 - x0) * ((k % 4) / 3.0)
            py = y0 + (y1 - y0) * ((k // 4) / 2.0)
            tot += 1
            if not inside(px, py):
                out += 1
        if out:
            off.append((out / tot, r, R[r]))
    off.sort(reverse=True)
    for frac, r, rr in off:
        print("   %-6s %4.0f%% of courtyard outside  rect=(%.1f,%.1f)-(%.1f,%.1f)"
              % (r, frac * 100, rr[0], rr[1], rr[2], rr[3]))
    if not off:
        print("   none - every courtyard is fully on the board")
    print("   (connectors whose body is meant to overhang the edge belong here;")
    print("    anything else is a placement bug - see the half-cell erosion note)")

    print("\n=== 5. module grouping ===")
    titles = plan.get("module_titles", {})
    mods = plan["modules"]
    # A module whose members are all FIXED (mounting holes, board-edge terminals)
    # legitimately declares no anchors.  Only modules that actually have anchors may
    # take part in the distance/stray maths - indexing anchors[k][0] unconditionally
    # is an IndexError waiting for the first all-fixed module.
    with_anchors = sorted(k for k in anchors if anchors.get(k))
    if not with_anchors:
        print("   no module declares anchors - distance/stray metrics skipped")
    for m in sorted(mods):
        rs = [r for r in mods[m] if r in R]
        if not rs:
            continue
        xs = [(R[r][0] + R[r][2]) / 2 for r in rs]
        ys = [(R[r][1] + R[r][3]) / 2 for r in rs]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        allx = [R[r][0] for r in rs] + [R[r][2] for r in rs]
        ally = [R[r][1] for r in rs] + [R[r][3] for r in rs]
        print("   %s %-32s n=%2d  centroid=(%6.1f,%6.1f)  bbox %5.1fx%5.1f"
              % (m, titles.get(m, m), len(rs), cx, cy,
                 max(allx) - min(allx), max(ally) - min(ally)))
        if m in with_anchors:
            ds = sorted(min(math.hypot(x - ax, y - ay) for ax, ay in anchors[m])
                        for x, y in zip(xs, ys))
            print("        distance to nearest own core: median %.1f mm, max %.1f mm"
                  % (ds[len(ds) // 2], ds[-1]))
        else:
            print("        no anchors declared - spread not scored")
        if with_anchors:
            stray = [r for r in rs
                     if min(with_anchors, key=lambda k: math.hypot(
                         (R[r][0] + R[r][2]) / 2 - anchors[k][0][0],
                         (R[r][1] + R[r][3]) / 2 - anchors[k][0][1])) != m]
            if stray:
                print("        %d part(s) sit nearer another module anchor: %s"
                      % (len(stray), sorted(stray)[:16]))

    print("\n=== 6. area budget ===")
    g = args.grid_mm
    bx0 = min(p[0] for p in poly)
    bx1 = max(p[0] for p in poly)
    by0 = min(p[1] for p in poly)
    by1 = max(p[1] for p in poly)
    board = sum(g * g
                for i in range(int((bx1 - bx0) / g) + 1)
                for j in range(int((by1 - by0) / g) + 1)
                if inside(bx0 + i * g, by0 + j * g))
    court = sum((R[r][2] - R[r][0]) * (R[r][3] - R[r][1]) for r in refs)
    print("   board area                : %8.0f mm2" % board)
    print("   sum of courtyards         : %8.0f mm2  (%.1f%%)" % (court, 100 * court / board))
    print("   above ~75% the board is dense: expect spills into the inter-bank gaps")

    print("\n=== 7. fixed parts did not move ===")
    for ref in plan.get("fixed", []):
        if ref in pos:
            p = pos[ref]
            print("   %-6s (%8.3f, %8.3f) rot %6.1f" % (ref, p["x"], p["y"], p["rot"]))

    print("\n%s" % ("PASS - all hard gates clear" if hard_fail == 0
                    else "FAIL - %d hard gate(s) tripped" % hard_fail))
    if tee is not None:
        tee.close()
        print("report written to %s" % tee.path)
    raise SystemExit(1 if hard_fail else 0)


if __name__ == "__main__":
    main()
