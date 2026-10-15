#!/usr/bin/env python3
"""Extract the placement geometry of a .kicad_pcb: courtyard boxes + board outline.

Read-only: this never writes to the board file.  It produces the two inputs the
packer needs, so the packer itself never has to understand KiCad file syntax.

    python board_geometry.py --board board.kicad_pcb
    # -> <board dir>/placement/geometry.json   (override with --out / --outdir)

For every footprint it records ``bbox_local`` - the occupied rectangle in the
footprint's own coordinate system - taken from the courtyard layer when present,
falling back to the fabrication layer, then the pad extents, and finally the
silkscreen (for artwork such as logos that has none of the first three).  That
rectangle is what "no overlap" is judged on, so the source is reported per
footprint (``bbox_src``) and must be sanity-checked: a footprint whose courtyard
is bogus will silently poison the whole placement.

The board outline is emitted as an ordered closed polygon, plus the axis-aligned
bounding box, so callers can do point-in-polygon without re-parsing the file.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import projpaths  # noqa: E402
import sexpr  # noqa: E402

GRAPHIC_KINDS = ("fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly")

#: Courtyard first, then progressively weaker stand-ins.  The order matters: the
#: courtyard is the only rectangle "no overlap" is honestly judged on, so every step
#: away from it is recorded in ``bbox_src`` and reported for review.  ``SilkS`` is the
#: last resort for silkscreen-only artwork (logos, fiducial marks) that has no
#: courtyard, no fab graphics and no pads - without it those footprints come back as
#: ``None`` and crash the summary below.
BBOX_CHAIN = (
    (("CrtYd",), "courtyard"),
    (("Fab",), "fab"),
    ((), "pads"),
    (("SilkS",), "silk"),
)


def footprint_bbox_local(fp, want):
    """Occupied rectangle of one footprint in local coordinates.

    ``want`` is a tuple of layer-name suffixes; graphics on those layers are
    included.  An empty tuple means "pads only".
    """
    xs, ys = [], []
    for pad in fp.kids("pad"):
        at = pad.first("at")
        if at is None:
            continue
        pn = at.nums()
        w = h = 0.0
        size = pad.first("size")
        if size is not None:
            sn = size.nums()
            if len(sn) >= 2:
                w, h = sn[0], sn[1]
        xs += [pn[0] - w / 2, pn[0] + w / 2]
        ys += [pn[1] - h / 2, pn[1] + h / 2]

    for kind in GRAPHIC_KINDS:
        for g in fp.kids(kind):
            layer = g.first("layer")
            if layer is None or len(layer.atoms()) < 2:
                continue
            name = layer.atoms()[1].strip('"')
            if not any(name.endswith(suffix) for suffix in want):
                continue
            for key in ("start", "end", "center", "mid"):
                for s in g.kids(key):
                    nn = s.nums()
                    if len(nn) >= 2:
                        xs.append(nn[0])
                        ys.append(nn[1])
            for pts in g.kids("pts"):
                for xy in pts.kids("xy"):
                    nn = xy.nums()
                    if len(nn) >= 2:
                        xs.append(nn[0])
                        ys.append(nn[1])
            if kind == "fp_circle":
                c, e = g.first("center"), g.first("end")
                if c is not None and e is not None:
                    cn, en = c.nums(), e.nums()
                    r = math.hypot(en[0] - cn[0], en[1] - cn[1])
                    xs += [cn[0] - r, cn[0] + r]
                    ys += [cn[1] - r, cn[1] + r]

    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def pick_bbox(fp):
    """First available occupied rectangle for one footprint, with its provenance.

    Returns ``(box, src)`` walking :data:`BBOX_CHAIN`.  ``src`` is ``"none"`` only when
    the footprint carries no geometry on any of those layers - the box is then a
    degenerate point and the part is reported by name, because a part nobody can
    measure is a part nothing protects from overlap.
    """
    for want, src in BBOX_CHAIN:
        box = footprint_bbox_local(fp, want)
        if box is not None:
            return box, src
    return [0.0, 0.0, 0.0, 0.0], "none"


def _round2(seq):
    return tuple(round(v, 4) for v in seq[:2])


def edge_cuts_segments(text):
    """Every Edge.Cuts primitive as a list of ``(a, b)`` vertex pairs.

    ``gr_line`` and the four edges of ``gr_rect`` come back as segments.  The
    single-vertex primitives (``gr_circle``, ``gr_poly``, ``gr_arc``) are *not*
    silently dropped any more: a board may legitimately be outlined by one of them,
    and dropping it used to make the caller believe the board had no outline at all.
    They are returned through ``walks`` instead.
    """
    segs, walks, kinds = [], [], []
    for g in sexpr.edge_cuts(text):
        kinds.append(g.head)
        if g.head == "gr_rect":
            s, e = g.first("start"), g.first("end")
            if s is None or e is None:
                continue
            x0, y0 = _round2(s.nums())
            x1, y1 = _round2(e.nums())
            corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            for i in range(4):
                segs.append((corners[i], corners[(i + 1) % 4]))
            continue
        start, end = g.first("start"), g.first("end")
        if start is not None and end is not None:
            segs.append((_round2(start.nums()), _round2(end.nums())))
            continue
        pts = g.first("pts")
        if pts is not None:                       # gr_poly: already an ordered ring
            ring = [_round2(xy.nums()) for xy in pts.kids("xy")]
            if len(ring) >= 3:
                walks.append(ring)
            continue
        c, e = g.first("center"), g.first("end")
        if c is not None and e is not None:       # gr_circle: sampled ring
            cn, en = c.nums(), e.nums()
            r = math.hypot(en[0] - cn[0], en[1] - cn[1])
            walks.append([(round(cn[0] + r * math.cos(t), 4),
                           round(cn[1] + r * math.sin(t), 4))
                          for t in [i * math.pi / 24 for i in range(48)]])
    return segs, walks, kinds


def outline_polygon(text):
    """Walk the Edge.Cuts segments into one ordered closed polygon."""
    segs, walks, kinds = edge_cuts_segments(text)
    if walks:
        # A single self-contained ring (gr_poly / gr_circle) is already closed and
        # ordered; take the one with the largest extents and ignore loose segments.
        ring = max(walks, key=lambda w: (max(p[0] for p in w) - min(p[0] for p in w))
                   * (max(p[1] for p in w) - min(p[1] for p in w)))
        return ring
    if not segs:
        raise RuntimeError(
            "no Edge.Cuts geometry found - the board has no outline (%s)"
            % (", ".join(sorted(set(kinds))) or "no Edge.Cuts primitives at all"))

    adj = defaultdict(list)
    for a, b in segs:
        adj[a].append(b)
        adj[b].append(a)

    start = segs[0][0]
    poly, cur, prev = [start], start, None
    seen = {start}
    while True:
        nxts = [p for p in adj[cur] if p != prev and p not in seen]
        if not nxts:
            # at a junction, prefer an unvisited neighbour; only then stop
            nxts = [p for p in adj[cur] if p != prev]
        if not nxts:
            break
        nxt = nxts[0]
        if nxt == start:
            break
        poly.append(nxt)
        seen.add(nxt)
        prev, cur = cur, nxt
    if len(poly) < 3:
        raise RuntimeError("Edge.Cuts does not form a closed polygon; "
                           "preserve the existing outline instead of drawing one")
    return poly


def board_area(poly):
    """True polygon area (shoelace), not the bounding box - a shaped board is smaller."""
    a = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return abs(a) / 2.0


def point_in_poly(poly, x, y):
    res, n = False, len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            res = not res
    return res


def preflight(text, rows, poly, board_name):
    """Everything step 1 has to decide, in one compact block.

    This deliberately replaces "dump the whole board and read it in the agent context":
    the board file already holds every fact step 1 needs, so the evidence costs a
    kilobyte instead of a megabyte.  ``get_pcb_board`` stays the authority for writing;
    it is simply the wrong tool for a size/rotation/density survey.
    """
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    area = board_area(poly)
    by_src, rot_hist, court = defaultdict(int), defaultdict(int), 0.0

    # current pose of every footprint, straight from the file
    origins = {}
    for fp in sexpr.footprints(text):
        at = fp.first("at")
        if at is None:
            continue
        n = at.nums()
        origins[sexpr.property_value(fp, "Reference")] = (n[0], n[1])

    for r in rows:
        by_src[r["bbox_src"]] += 1
        rot_hist[round(r["rot"] or 0.0)] += 1
        x0, y0, x1, y1 = r["bbox_local"]
        w, h = x1 - x0, y1 - y0
        t = math.radians(r["rot"] or 0.0)
        c, s = math.cos(t), math.sin(t)
        w2 = abs(w * c) + abs(h * s)
        h2 = abs(w * s) + abs(h * c)
        court += w2 * h2

    inside = [ref for ref, (x, y) in origins.items() if point_in_poly(poly, x, y)]
    outside = sorted(ref for ref in origins if ref not in set(inside))
    oxs = [origins[r][0] for r in origins] or [0.0]
    oys = [origins[r][1] for r in origins] or [0.0]

    print("board                 : %s" % board_name)
    print("footprints            : %d" % len(rows))
    print("outline               : %d vertices, bbox %.1f,%.1f .. %.1f,%.1f  (%.1f x %.1f mm)"
          % (len(poly), min(xs), min(ys), max(xs), max(ys),
             max(xs) - min(xs), max(ys) - min(ys)))
    print("board area            : %.0f mm2" % area)
    print("courtyard total area  : %.0f mm2  -> density %.1f%%%s"
          % (court, 100.0 * court / area,
             "   (>75%: dense board, expect spill and eviction)" if court / area > 0.75 else ""))
    print("courtyard source      : %s" % dict(sorted(by_src.items())))
    print("rotations present     : %s" % dict(sorted(rot_hist.items())))
    print("device X range        : %.1f .. %.1f" % (min(oxs), max(oxs)))
    print("device Y range        : %.1f .. %.1f" % (min(oys), max(oys)))
    print("device origins inside : %d of %d" % (len(inside), len(rows)))
    if outside:
        same = " (they are already outside: a from-scratch re-place is safe)" if not inside \
            else " (mixed: consider a local adjustment instead of a full re-place)"
        print("device origins outside: %d %s" % (len(outside), outside[:10]))
        print("  ->%s" % same)

    warns = []
    if by_src.get("none"):
        warns.append("! %d part(s) have NO usable geometry and are treated as zero-area "
                     "points - name them in the report and place them by hand"
                     % by_src["none"])
    if by_src.get("silk"):
        warns.append("! %d part(s) fall back to the SILKSCREEN outline - verify those "
                     "courtyards before trusting the overlap numbers" % by_src["silk"])
    if set(by_src) - {"courtyard", "fab", "pads", "silk"}:
        warns.append("! unexpected bbox sources: %s" % sorted(set(by_src) - {"courtyard"}))
    for w in warns:
        print(w)
    return {"area_mm2": round(area, 1), "density": round(court / area, 4),
            "inside": len(inside), "outside": len(outside),
            "devices": len(rows), "bbox_src": dict(by_src),
            "warnings": warns}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", required=True, help="source .kicad_pcb (read-only)")
    ap.add_argument("--out", help="geometry.json to write "
                                  "(default <board dir>/placement/geometry.json)")
    projpaths.add_outdir(ap)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--brief", action="store_true",
                    help="print only the step-1 preflight summary (no per-part lines); "
                         "this is the compact evidence step 1 should read")
    args = ap.parse_args()

    projpaths.make_console_safe()

    out_path = projpaths.resolve_out(args.out, "geometry.json",
                                     board=args.board, outdir=args.outdir)

    text = open(args.board, encoding="utf-8").read()
    fps = sexpr.footprints(text)
    if not fps:
        raise SystemExit("no footprints found in the board file")

    rows, fallback, no_box = [], [], []
    for fp in fps:
        ref = sexpr.property_value(fp, "Reference")
        val = sexpr.property_value(fp, "Value")
        at = fp.first("at")
        n = at.nums()
        rot = n[2] if len(n) > 2 else 0.0

        box, src = pick_bbox(fp)
        if src == "none":
            no_box.append(ref)
        elif src != "courtyard":
            fallback.append((ref, src))
        rows.append({"ref": ref, "value": val, "libid": fp.atoms()[1].strip('"'),
                     "rot": rot, "bbox_local": box, "bbox_src": src})

    poly = outline_polygon(text)
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    pf = preflight(text, rows, poly, os.path.basename(args.board))

    json.dump({"board": os.path.basename(args.board),
               "outline": [list(p) for p in poly],
               "outline_bbox": [min(xs), min(ys), max(xs), max(ys)],
               "board_area_mm2": pf["area_mm2"],
               "courtyard_density": pf["density"],
               "preflight": pf,
               "footprints": rows},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    if not args.quiet:
        if not args.brief:
            widths = sorted((r["bbox_local"][2] - r["bbox_local"][0],
                             r["bbox_local"][3] - r["bbox_local"][1]) for r in rows)
            print("weaker stand-ins      : %d %s" % (len(fallback), fallback[:12]))
            print("smallest / median / largest box (mm): %.2f / %.2f / %.2f"
                  % (min(w for w, _ in widths), widths[len(widths) // 2][0],
                     max(w for w, _ in widths)))
        print("wrote %s" % out_path)


if __name__ == "__main__":
    main()
