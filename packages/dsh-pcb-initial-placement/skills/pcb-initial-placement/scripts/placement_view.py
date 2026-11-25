#!/usr/bin/env python3
"""Render a placement plan as a module-coloured SVG plan view + evaluation panel.

    python placement_view.py --geometry geometry.json --plan placement_plan.json
    # -> <placement dir>/placement_view.svg

This is the picture a reviewer opens first, and it is deliberately self-contained:
standard library only, no KiCad, no browser, no rasteriser, so it can be produced on
any machine that got as far as running the packer.

What it draws
-------------
* the real board outline from Edge.Cuts, filled, so the board shape (notches, tabs,
  rounded corners) is visible rather than a bounding box;
* every keep-out registered in the plan, hatched, with its reason in the panel - the
  tilt volume of a socket or the antenna clear zone is a decision, not noise;
* every courtyard rectangle tinted by the module that owns it, labelled once it is
  big enough on screen to carry text, with fixed/anchor parts drawn at full opacity
  so a reviewer can separate *decisions* from *consequences*;
* each module's anchor points, drawn as crosses in the module colour.

The panel underneath carries the numbers that decide whether the plan is acceptable -
occupancy, per-module area, and the hard gates.  The canvas is sized from the content
that actually exists, so a board with 14 modules or 5 keep-outs does not run its text
off the bottom edge.

The gates shown here are for DISPLAY: the authoritative check is
``verify_placement.py``, which computes the same quantities from the same inputs
without sharing the packer's code.  If the two ever disagree, believe
verify_placement.py.
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import projpaths  # noqa: E402

#: Palette for up to 12 modules; assigned in sorted module order so the same board
#: always produces the same colours run to run.
PALETTE = ["#2e8b57", "#c0392b", "#8e44ad", "#e67e22", "#2471a3", "#16a085",
           "#7f8c8d", "#34495e", "#b7950b", "#a04000", "#1a5276", "#7d3c98"]
UNASSIGNED = "#95a5a6"
FONT = "DejaVu Sans, Segoe UI, Microsoft YaHei, Arial, sans-serif"
ROW_H = 18
LEGEND_COL_PX = 330
PANEL_HEAD_PX = 72


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def rect_of(geo_ref, pose):
    """Courtyard rectangle in board coordinates (KiCad Y down => clockwise turn)."""
    x0, y0, x1, y1 = geo_ref["bbox_local"]
    t = math.radians(pose["rot"])
    c, s = math.cos(t), math.sin(t)
    pts = [(lx * c + ly * s, -lx * s + ly * c) for lx in (x0, x1) for ly in (y0, y1)]
    return (pose["x"] + min(p[0] for p in pts), pose["y"] + min(p[1] for p in pts),
            pose["x"] + max(p[0] for p in pts), pose["y"] + max(p[1] for p in pts))


def poly_area(poly):
    a = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2.0


def inside_poly(poly, x, y):
    r, n = False, len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            r = not r
    return r


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--geometry", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--config", help="optional placement_config.json; only used to "
                                     "recover module titles/keep-outs if the plan lacks them")
    ap.add_argument("--out", help="SVG to write (default <placement dir>/placement_view.svg)")
    ap.add_argument("--scale", type=float,
                    help="pixels per mm; default auto-fits the board to --target-width-px")
    ap.add_argument("--title", help="override the drawing title")
    ap.add_argument("--target-width-px", type=float, default=1500.0)
    projpaths.add_outdir(ap)
    args = ap.parse_args()

    geom = json.load(open(args.geometry, encoding="utf-8-sig"))
    plan = json.load(open(args.plan, encoding="utf-8-sig"))
    cfg = json.load(open(args.config, encoding="utf-8-sig")) if args.config else {}

    geo = {g["ref"]: g for g in geom["footprints"]}
    pos = plan["positions"]
    poly = [tuple(p) for p in geom["outline"]]
    fixed = set(plan.get("fixed", []))
    keepouts = plan.get("keepouts") or cfg.get("keepouts") or []
    titles = dict(plan.get("module_titles") or {})
    for m, spec in (cfg.get("modules") or {}).items():
        titles.setdefault(m, spec.get("title", m))

    modules = plan.get("modules") or {m: s.get("members", [])
                                      for m, s in (cfg.get("modules") or {}).items()}
    mod_of = {}
    for m, members in modules.items():
        for r in members:
            mod_of[r] = m
    order = sorted(modules)
    color = {m: PALETTE[i % len(PALETTE)] for i, m in enumerate(order)}

    bx0 = min(p[0] for p in poly)
    bx1 = max(p[0] for p in poly)
    by0 = min(p[1] for p in poly)
    by1 = max(p[1] for p in poly)
    bw, bh = bx1 - bx0, by1 - by0

    S = args.scale or max(1.5, min(14.0, args.target_width_px / max(bw, 1e-6)))
    PAD = 34
    plan_w = bw * S + 2 * PAD
    plan_h = bh * S + 2 * PAD

    # ---- geometry of every part, and the display metrics -------------------
    R = {r: rect_of(geo[r], p) for r, p in pos.items() if r in geo}
    refs = sorted(R)

    overlaps = []
    for i in range(len(refs)):
        a = refs[i]
        ax0, ay0, ax1, ay1 = R[a]
        for j in range(i + 1, len(refs)):
            b = refs[j]
            bxx0, byy0, bxx1, byy1 = R[b]
            if ax0 < bxx1 and bxx0 < ax1 and ay0 < byy1 and byy0 < ay1:
                overlaps.append((a, b))

    off_board = []
    for r in refs:
        x0, y0, x1, y1 = R[r]
        out = tot = 0
        for k in range(12):
            px = x0 + (x1 - x0) * ((k % 4) / 3.0)
            py = y0 + (y1 - y0) * ((k // 4) / 2.0)
            tot += 1
            if not inside_poly(poly, px, py):
                out += 1
        if out:
            off_board.append((r, out / tot))

    board_area = poly_area(poly)
    court_area = sum((R[r][2] - R[r][0]) * (R[r][3] - R[r][1]) for r in refs)
    density = 100.0 * court_area / board_area if board_area else 0.0

    mod_area, mod_count = {}, {}
    for r in refs:
        m = mod_of.get(r, "?")
        mod_area[m] = mod_area.get(m, 0.0) + (R[r][2] - R[r][0]) * (R[r][3] - R[r][1])
        mod_count[m] = mod_count.get(m, 0) + 1

    weak = sorted({(g["ref"], g["bbox_src"]) for g in geom["footprints"]
                   if g.get("bbox_src") not in (None, "courtyard")})

    # ---- panel content, counted BEFORE the canvas is sized -----------------
    legend = [(m, mod_count.get(m, 0),
               100.0 * mod_area.get(m, 0.0) / board_area if board_area else 0.0)
              for m in order]
    unassigned = sorted(set(refs) - set(mod_of))
    if unassigned:
        legend.append(("(unassigned)", len(unassigned), 0.0))

    rows = [
        ("footprints on board / placed", "%d / %d" % (len(geo), len(pos)), "#222"),
        ("fixed anchors / algorithm-placed",
         "%d / %d" % (len(fixed), len(pos) - len(fixed)), "#222"),
        ("board size / area", "%.1f x %.1f mm / %.0f mm2" % (bw, bh, board_area), "#222"),
        ("courtyard area / density", "%.0f mm2 / %.1f%%" % (court_area, density),
         "#c0392b" if density > 75 else "#1e8449"),
        ("courtyard overlap pairs",
         "%d%s" % (len(overlaps), " PASS" if not overlaps else " FAIL"),
         "#1e8449" if not overlaps else "#c0392b"),
        ("parts off the board",
         "%d%s" % (len(off_board), " PASS" if not off_board else " REVIEW"),
         "#1e8449" if not off_board else "#b7950b"),
        ("unplaced by the packer", "%d" % len(plan.get("unplaced") or []),
         "#222" if not plan.get("unplaced") else "#c0392b"),
        ("keep-outs registered", "%d" % len(keepouts), "#222"),
    ]
    if weak:
        rows.append(("courtyard stand-ins / no geometry",
                     "%d / %d" % (len(weak), sum(1 for w in weak if w[1] == "none")),
                     "#b7950b"))

    notes = []
    if overlaps:
        notes.append(("overlapping: %s" % ", ".join("%s/%s" % p for p in overlaps[:6]),
                      "#c0392b"))
    if off_board:
        notes.append(("off-board: %s" % ", ".join("%s %.0f%%" % (r, f * 100)
                                                  for r, f in off_board[:6]), "#b7950b"))
    for i, ko in enumerate(keepouts):
        notes.append(("keep-out %d: %s" % (i + 1, (ko.get("why") or "")[:110]), "#c0392b"))

    # legend columns, then the canvas that fits them
    per_col = max(1, min(len(legend), 12))
    ncol = max(1, -(-len(legend) // per_col))
    legend_w = ncol * LEGEND_COL_PX
    mx = PAD + legend_w + 16
    body_rows = max(per_col, len(rows) + len(notes) + 1)
    panel_h = PANEL_HEAD_PX + body_rows * ROW_H + 28
    W = max(plan_w, mx + 520.0)
    H = plan_h + panel_h

    def tx(x):
        return PAD + (x - bx0) * S

    def ty(y):
        return PAD + (y - by0) * S

    title = args.title or ("%s - Phase-1 initial placement: courtyard occupancy by module"
                           % geom.get("board", "board"))

    o = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" '
         'viewBox="0 0 %.0f %.0f" font-family="%s">' % (W, H, W, H, FONT),
         '<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" '
         'patternTransform="rotate(45)">'
         '<rect width="8" height="8" fill="#fdecea"/>'
         '<line x1="0" y1="0" x2="0" y2="8" stroke="#c0392b" stroke-width="2.4"/>'
         '</pattern></defs>',
         '<rect width="100%" height="100%" fill="#fbfbfb"/>']

    o.append('<polygon points="%s" fill="#eef3f7" stroke="#1a1a1a" stroke-width="2.5"/>'
             % " ".join("%.1f,%.1f" % (tx(px), ty(py)) for px, py in poly))

    for ko in keepouts:
        x0, y0, x1, y1 = ko["rect"]
        o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="url(#hatch)" '
                 'stroke="#c0392b" stroke-width="1.4" stroke-dasharray="5,3"/>'
                 % (tx(x0), ty(y0), (x1 - x0) * S, (y1 - y0) * S))

    # big parts first, so a small part's label is never buried under a big rectangle
    for ref in sorted(refs, key=lambda r: -((R[r][2] - R[r][0]) * (R[r][3] - R[r][1]))):
        x0, y0, x1, y1 = R[ref]
        fx, fy = tx(x0), ty(y0)
        w, h = (x1 - x0) * S, (y1 - y0) * S
        col = color.get(mod_of.get(ref), UNASSIGNED)
        is_fixed = ref in fixed
        o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="%s" '
                 'fill-opacity="%.2f" stroke="%s" stroke-width="%.1f" rx="1.5"/>'
                 % (fx, fy, w, h, col, 0.85 if is_fixed else 0.5,
                    "#111" if is_fixed else col, 1.2 if is_fixed else 0.6))
        if w >= 34 and h >= 15:
            o.append('<text x="%.1f" y="%.1f" font-size="10" fill="#111" '
                     'text-anchor="middle">%s</text>'
                     % (fx + w / 2, fy + h / 2 + 3.5, esc(ref)))

    anchors = plan.get("anchors") or {}
    for m in order:
        for ax, ay in anchors.get(m, []):
            o.append('<path d="M %.1f %.1f l 7 7 m 0 -7 l -7 7" stroke="%s" '
                     'stroke-width="2.2" fill="none"/>'
                     % (tx(ax) - 3.5, ty(ay) - 3.5, color.get(m, "#111")))

    bar_mm = 10.0 if bw > 60 else 20.0
    while bar_mm * S < 60:
        bar_mm *= 2
    bxp, byp = PAD + 6, plan_h - PAD - 8
    o.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#111" stroke-width="3"/>'
             % (bxp, byp, bxp + bar_mm * S, byp))
    o.append('<text x="%.1f" y="%.1f" font-size="12" fill="#111">%g mm</text>'
             % (bxp + bar_mm * S + 8, byp + 4, bar_mm))

    # ---- panel -------------------------------------------------------------
    def text(x, y, s, size=12, fill="#222", weight="normal", anchor="start"):
        o.append('<text x="%.1f" y="%.1f" font-size="%d" font-weight="%s" fill="%s" '
                 'text-anchor="%s">%s</text>'
                 % (x, y, size, weight, fill, anchor, esc(s)))

    head_y = plan_h + 26
    o.append('<line x1="0" y1="%.1f" x2="%.0f" y2="%.1f" stroke="#ccc" stroke-width="1"/>'
             % (plan_h, W, plan_h))
    text(PAD, head_y, title, 17, "#111", "bold")
    text(PAD, head_y + 20,
         "%s | generated %s | display metrics only - the gate is verify_placement.py"
         % (geom.get("board", ""), datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
         11, "#555")

    top = plan_h + PANEL_HEAD_PX
    text(PAD, top, "modules", 13, "#111", "bold")
    for i, (m, n, share) in enumerate(legend):
        col_i, row_i = divmod(i, per_col)
        lx = PAD + col_i * LEGEND_COL_PX
        ly = top + ROW_H * (row_i + 1)
        col = color.get(m, UNASSIGNED)
        o.append('<rect x="%.1f" y="%.1f" width="12" height="12" fill="%s" '
                 'fill-opacity="0.6" stroke="%s"/>' % (lx, ly - 10, col, col))
        text(lx + 17, ly, "%s  %s  (%d, %.1f%%)" % (m, titles.get(m, ""), n, share), 11)

    text(mx, top, "evaluation panel", 13, "#111", "bold")
    my = top + ROW_H
    for label, value, col in rows:
        text(mx, my, "%s:" % label, 11, "#555")
        text(mx + 250, my, value, 11, col, "bold")
        my += ROW_H
    my += 4
    for note, col in notes:
        text(mx, my, note, 10, col)
        my += 15

    o.append("</svg>")

    out_path = projpaths.resolve_out(args.out, "placement_view.svg",
                                     refs=(args.geometry, args.plan), outdir=args.outdir)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(o) + "\n")

    print("wrote %s  (%.0f x %.0f px, %.2f px/mm)" % (out_path, W, H, S))
    print("modules %d | parts %d | fixed %d | density %.1f%% | overlaps %d | off-board %d"
          % (len(order), len(pos), len(fixed), density, len(overlaps), len(off_board)))
    if weak:
        print("stand-in courtyards (name these in the report): %s"
              % ", ".join("%s=%s" % w for w in weak[:12]))


if __name__ == "__main__":
    main()
