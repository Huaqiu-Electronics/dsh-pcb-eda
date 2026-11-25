#!/usr/bin/env python3
"""Phase-1 initial placement packer: functional modules -> legal, non-overlapping poses.

    python pack.py --geometry geometry.json --board board.kicad_pcb \
                   --config placement_config.json
    # -> <board dir>/placement/placement_plan.json   (override with --out / --outdir)

Inputs
------
geometry.json  from board_geometry.py - courtyard boxes + board outline
board.kicad_pcb  read-only, only to resolve ``pad`` anchored fixed parts
placement_config.json  the floorplan decisions a human has to make:
    modules / anchors / fixed anchors / keep-outs / order (see the example)

What it does, in order
----------------------
 1. rasterise the board polygon into a grid; a cell is usable only if its centre
    and its four corners are on the board, so no courtyard can hang off the edge
 2. stamp every fixed part (connectors, SIMM sockets, cores) as a non-evictable
    obstacle, then every keep-out rectangle
 3. give secondary cores (clock, crystals, EEPROM, trimmers) first pick of the
    space next to their own module's anchor
 4. pack each module outwards from its anchor: large parts first, then passives,
    modules round-robin, nearest legal slot wins; a part that fails gets a wider
    radius on its next turn instead of being dumped far away
 5. repair: anything still homeless looks for the legal slot whose eviction cost
    (total courtyard area displaced) is lowest, and swaps it out - the displaced
    parts go back into the queue
 6. compact: repeatedly pull each part to the nearest legal slot that is closer
    to its own module anchor; this can only tighten grouping, never break it

The result is a pose per footprint on a fixed grid.  Nothing here touches KiCad.
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


# --------------------------------------------------------------------- geometry
def rot_pt(lx, ly, deg):
    """Local -> board offset.  Board Y points down, so this is a clockwise turn.
    Validated to 1e-9 mm against KiCad's own pad placement."""
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return (lx * c + ly * s, -lx * s + ly * c)


class Board:
    def __init__(self, geometry, outline):
        self.geo = {g["ref"]: g for g in geometry["footprints"]}
        self.orig_rot = {g["ref"]: g["rot"] for g in geometry["footprints"]}
        self.poly = [tuple(p) for p in outline]
        xs = [p[0] for p in self.poly]
        ys = [p[1] for p in self.poly]
        self.bx0, self.by0, self.bxe, self.bye = min(xs), min(ys), max(xs), max(ys)
        self._box = {}

    def rot_box(self, ref, rot):
        key = (ref, rot % 360)
        v = self._box.get(key)
        if v is None:
            x0, y0, x1, y1 = self.geo[ref]["bbox_local"]
            pts = [rot_pt(px, py, rot) for px in (x0, x1) for py in (y0, y1)]
            v = (min(p[0] for p in pts), min(p[1] for p in pts),
                 max(p[0] for p in pts), max(p[1] for p in pts))
            self._box[key] = v
        return v

    def rect_of(self, ref, ox, oy, rot):
        b = self.rot_box(ref, rot)
        return (ox + b[0], oy + b[1], ox + b[2], oy + b[3])

    def wh(self, ref, rot):
        b = self.rot_box(ref, rot)
        return (b[2] - b[0], b[3] - b[1])

    def inside(self, x, y):
        res, n = False, len(self.poly)
        for i in range(n):
            x0, y0 = self.poly[i]
            x1, y1 = self.poly[(i + 1) % n]
            if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                res = not res
        return res


class Grid:
    """Occupancy raster.  OCC=1 means blocked; OWNER identifies the part so it can
    be lifted again.  All index maths goes through cell() - see the note there."""

    FREE = 255

    def __init__(self, board, grid, gap):
        self.b, self.g, self.gap = board, grid, gap
        self.nx = int((board.bxe - board.bx0) / grid) + 3
        self.ny = int((board.bye - board.by0) / grid) + 3
        self.occ = [bytearray(self.nx) for _ in range(self.ny)]
        self.own = [bytearray([self.FREE]) * self.nx for _ in range(self.ny)]
        for j in range(self.ny):
            y = board.by0 + j * grid + grid / 2
            row = self.occ[j]
            for i in range(self.nx):
                x = board.bx0 + i * grid + grid / 2
                ok = board.inside(x, y)
                if ok:
                    for dx in (-grid / 2 - 1e-6, grid / 2 + 1e-6):
                        for dy in (-grid / 2 - 1e-6, grid / 2 + 1e-6):
                            if not board.inside(x + dx, y + dy):
                                ok = False
                                break
                        if not ok:
                            break
                if not ok:
                    row[i] = 1

    def cell(self, v, base):
        """Grid index with *floor* semantics.  int() truncates towards zero, which
        silently maps a slightly-off-board rectangle onto cell 0 instead of -1 and
        lets parts hang over the edge."""
        return math.floor((v - base) / self.g + 0.5)

    def mark(self, x0, y0, x1, y1, gap=0.0, owner=FREE):
        # identical rounding to rect_free(), so a stamped rectangle can never spill
        # into a neighbouring part's cells
        i0 = max(0, self.cell(x0 - gap, self.b.bx0))
        i1 = min(self.nx - 1, self.cell(x1 + gap, self.b.bx0))
        j0 = max(0, self.cell(y0 - gap, self.b.by0))
        j1 = min(self.ny - 1, self.cell(y1 + gap, self.b.by0))
        for j in range(j0, j1 + 1):
            row, own = self.occ[j], self.own[j]
            for i in range(i0, i1 + 1):
                row[i] = 1
                own[i] = owner

    def unmark(self, owner):
        for j in range(self.ny):
            row, own = self.occ[j], self.own[j]
            for i in range(self.nx):
                if own[i] == owner:
                    own[i] = self.FREE
                    row[i] = 0

    def rect_free(self, rect, g=None):
        g = self.gap if g is None else g
        i0 = self.cell(rect[0] - g, self.b.bx0)
        i1 = self.cell(rect[2] + g, self.b.bx0)
        j0 = self.cell(rect[1] - g, self.b.by0)
        j1 = self.cell(rect[3] + g, self.b.by0)
        if i0 < 0 or j0 < 0 or i1 >= self.nx or j1 >= self.ny or i1 < i0 or j1 < j0:
            return False
        for j in range(j0, j1 + 1):
            if any(self.occ[j][i0:i1 + 1]):
                return False
        return True

    def free_area(self):
        return sum(r.count(0) for r in self.occ) * self.g * self.g


# ---------------------------------------------------------------------- packing
class Packer:
    def __init__(self, board, cfg):
        self.b = board
        self.cfg = cfg
        self.G = cfg["grid_mm"]
        self.gap = cfg["gap_mm"]
        self.g = Grid(board, self.G, self.gap)
        self.positions = {}          # ref -> (x, y, rot)
        self.fixed = set()
        self.idx, self.by_idx, self.own_area, self.free_ids = {}, {}, {}, []
        self.queues, self.labels = {}, {}
        self.module_of = {}

    # -- module bookkeeping -------------------------------------------------
    def build_modules(self, modules):
        for mod, spec in modules.items():
            for ref in spec["members"]:
                if ref in self.module_of:
                    raise SystemExit("part %s listed in two modules (%s and %s)"
                                     % (ref, self.module_of[ref], mod))
                self.module_of[ref] = mod
        unknown = sorted(set(self.module_of) - set(self.b.geo))
        if unknown:
            raise SystemExit("config names parts that are not on the board: %s" % unknown)
        ungrouped = sorted(set(self.b.geo) - set(self.module_of))
        if ungrouped:
            raise SystemExit("every footprint needs exactly one module; ungrouped: %s"
                             % ungrouped)

    # -- occupancy bookkeeping ---------------------------------------------
    def _owner_id(self):
        return self.free_ids.pop() if self.free_ids else len(self.own_area)

    def commit(self, ref, pose):
        if ref in self.idx:
            self.release(ref)
        i = self._owner_id()
        self.positions[ref] = (pose[0], pose[1], pose[2])
        self.idx[ref] = i
        self.by_idx[i] = ref
        self.own_area[i] = self.area(ref)
        self.g.mark(*pose[3], gap=self.gap, owner=i)

    def release(self, ref):
        i = self.idx.pop(ref)
        self.by_idx.pop(i, None)
        self.own_area.pop(i, None)
        self.free_ids.append(i)
        self.g.unmark(i)
        self.positions.pop(ref, None)

    def area(self, ref):
        w, h = self.b.wh(ref, self.b.orig_rot[ref])
        return w * h

    def longest(self, ref):
        w, h = self.b.wh(ref, self.b.orig_rot[ref])
        return max(w, h)

    # -- placement ----------------------------------------------------------
    def rots(self, ref, n=2):
        o = self.b.orig_rot[ref]
        base = [o, (o + 90) % 360]
        return base if n == 2 else base + [(o + 180) % 360, (o + 270) % 360]

    def fit_at(self, ref, cx, cy, rot, g=None):
        b = self.b.rot_box(ref, rot)
        ox = round((cx - (b[0] + b[2]) / 2) / self.G) * self.G
        oy = round((cy - (b[1] + b[3]) / 2) / self.G) * self.G
        rect = (ox + b[0], oy + b[1], ox + b[2], oy + b[3])
        return (ox, oy, rot, rect) if self.g.rect_free(rect, g) else None

    def place_nearest(self, ref, ax, ay, coarse=1.27, max_r=60.0, nrot=2, g=None):
        """Nearest legal pose to one anchor, searched ring by ring."""
        R = 0.0
        while R <= max_r:
            if R <= 0:
                pts = ((ax, ay),)
            else:
                n = max(8, int(2 * math.pi * R / coarse))
                pts = ((ax + R * math.cos(2 * math.pi * k / n),
                        ay + R * math.sin(2 * math.pi * k / n)) for k in range(n))
            for (cx, cy) in pts:
                for rot in self.rots(ref, nrot):
                    hit = self.fit_at(ref, cx, cy, rot, g)
                    if hit:
                        best, bd = hit, (hit[0] - ax) ** 2 + (hit[1] - ay) ** 2
                        for dx in range(-3, 4):        # polish on the grid
                            for dy in range(-3, 4):
                                f = self.fit_at(ref, cx + dx * self.G,
                                                cy + dy * self.G, rot, g)
                                if f:
                                    d = (f[0] - ax) ** 2 + (f[1] - ay) ** 2
                                    if d < bd:
                                        bd, best = d, f
                        return best
            R += coarse
        return None

    def place_anywhere(self, ref, g=None):
        """Row-major sweep - finds a slot whenever one exists on the board."""
        for rot in self.rots(ref, 4):
            w, h = self.b.wh(ref, rot)
            for j in range(int((self.b.bye - self.b.by0 - h) / self.G) + 1):
                cy = self.b.by0 + j * self.G + h / 2
                for i in range(int((self.b.bxe - self.b.bx0 - w) / self.G) + 1):
                    cx = self.b.bx0 + i * self.G + w / 2
                    p = self.fit_at(ref, cx, cy, rot, g)
                    if p:
                        return p
        return None

    def dist_to(self, anchors, x, y):
        return min((x - ax) ** 2 + (y - ay) ** 2 for ax, ay in anchors)

    def place_in_module(self, ref, anchors, max_r=32.0, nrot=2):
        best = None
        for (ax, ay) in anchors:
            p = self.place_nearest(ref, ax, ay, coarse=1.27, max_r=max_r, nrot=nrot)
            if p:
                d = (p[0] - ax) ** 2 + (p[1] - ay) ** 2
                if best is None or d < best[0]:
                    best = (d, p)
        return None if best is None else best[1]

    def best_swap(self, ref, anchors, g=None, step=2):
        """Cheapest eviction: the legal slot displacing the least courtyard area,
        tie-broken by proximity to the module anchor."""
        g = self.gap if g is None else g
        best = None
        for rot in self.rots(ref, 4):
            b = self.b.rot_box(ref, rot)
            w, h = b[2] - b[0], b[3] - b[1]
            for j in range(0, int((self.b.bye - self.b.by0 - h) / self.G) + 1, step):
                cy = self.b.by0 + j * self.G + h / 2
                for i in range(0, int((self.b.bxe - self.b.bx0 - w) / self.G) + 1, step):
                    cx = self.b.bx0 + i * self.G + w / 2
                    ox = round((cx - (b[0] + b[2]) / 2) / self.G) * self.G
                    oy = round((cy - (b[1] + b[3]) / 2) / self.G) * self.G
                    rect = (ox + b[0], oy + b[1], ox + b[2], oy + b[3])
                    i0 = self.g.cell(rect[0] - g, self.b.bx0)
                    i1 = self.g.cell(rect[2] + g, self.b.bx0)
                    j0 = self.g.cell(rect[1] - g, self.b.by0)
                    j1 = self.g.cell(rect[3] + g, self.b.by0)
                    if i0 < 0 or j0 < 0 or i1 >= self.g.nx or j1 >= self.g.ny:
                        continue
                    owners, ok = set(), True
                    for jj in range(j0, j1 + 1):
                        row_o, row_w = self.g.occ[jj], self.g.own[jj]
                        for ii in range(i0, i1 + 1):
                            if row_o[ii]:
                                o = row_w[ii]
                                if o == Grid.FREE:      # board edge or keep-out
                                    ok = False
                                    break
                                owners.add(o)
                        if not ok:
                            break
                    if not ok:
                        continue
                    key = (sum(self.own_area[o] for o in owners),
                           self.dist_to(anchors, ox, oy))
                    if best is None or key < best[0]:
                        best = (key, ox, oy, rot, rect, owners)
        return best

    # -- driver -------------------------------------------------------------
    def run(self, modules, order, fixed, keepouts, priority, radius, big_area):
        self.build_modules(modules)

        for ref, spec in fixed.items():
            if "pad" in spec:
                x, y = self.pad_origin(ref, spec["pad"], spec["at"])
            else:
                x, y = spec["x"], spec["y"]
            pose = (x, y, spec.get("rot", 0))
            self.positions[ref] = pose
            self.fixed.add(ref)

        for rect in keepouts:
            self.g.mark(rect["rect"][0], rect["rect"][1], rect["rect"][2],
                        rect["rect"][3], gap=0.0, owner=Grid.FREE)

        for ref in fixed:
            self.g.mark(*self.b.rect_of(ref, *self.positions[ref]), gap=self.gap)

        anchors = {m: [tuple(a) for a in s["anchors"]] for m, s in modules.items()}
        for mod in order:
            parts = [r for r in modules[mod]["members"] if r not in self.positions]
            big = sorted([r for r in parts if self.area(r) >= big_area],
                         key=lambda r: -self.longest(r))
            small = sorted([r for r in parts if self.area(r) < big_area],
                           key=lambda r: -self.area(r))
            self.queues[mod] = [big, small]
            self.labels[mod] = modules[mod].get("title", mod)

        # secondary cores get first pick next to their own module
        for ref in priority:
            for mod in order:
                for phase in (0, 1):
                    if ref in self.queues[mod][phase]:
                        self.queues[mod][phase].remove(ref)
                        p = self.place_in_module(ref, anchors[mod], max_r=45.0)
                        if p:
                            self.commit(ref, p)
                        else:
                            self.queues[mod][phase].append(ref)

        tries = {}
        for phase in (0, 1):
            progress = True
            while progress:
                progress = False
                for mod in order:
                    q = self.queues[mod][phase]
                    if not q:
                        continue
                    ref = q.pop(0)
                    n = tries.get(ref, 0)
                    p = self.place_in_module(ref, anchors[mod],
                                             max_r=radius[min(n, len(radius) - 1)])
                    if p:
                        self.commit(ref, p)
                        progress = True
                    else:
                        tries[ref] = n + 1
                        q.append(ref)

        for mod in order:                     # leftovers: widen, then anywhere
            still = []
            for phase in (0, 1):
                for ref in self.queues[mod][phase]:
                    p = self.place_in_module(ref, anchors[mod], max_r=200.0, nrot=4)
                    if not p:
                        p = self.place_anywhere(ref)
                    if p:
                        self.commit(ref, p)
                    else:
                        still.append(ref)
            self.queues[mod] = [[], still]

        for round_no in range(8):             # eviction repair
            unplaced = self.unplaced()
            if not unplaced:
                break
            unplaced.sort(key=lambda r: -self.area(r))
            moved = 0
            for ref in list(unplaced):
                mod = self.module_of[ref]
                p = self.place_in_module(ref, anchors[mod], max_r=200.0, nrot=4)
                if not p:
                    p = self.place_anywhere(ref)
                if p:
                    self.commit(ref, p)
                    self.drop_from_queues(ref)
                    moved += 1
                    continue
                sw = self.best_swap(ref, anchors[mod])
                if sw is None:
                    continue
                key, ox, oy, rot, rect, owners = sw
                if key[0] > self.area(ref) * 2.0:   # too destructive, leave it
                    continue
                for o in owners:                    # evict the displaced parts
                    victim = self.by_idx[o]
                    vmod = self.module_of[victim]
                    self.release(victim)
                    if victim not in self.queues[vmod][0] and \
                       victim not in self.queues[vmod][1]:
                        self.queues[vmod][1].append(victim)
                self.commit(ref, (ox, oy, rot, rect))
                self.drop_from_queues(ref)
                moved += 1
            print("repair round %d: moved %d, still unplaced %d"
                  % (round_no + 1, moved, len(self.unplaced())))
            if moved == 0:
                break

        for it in range(3):                   # compaction
            order_by_far = sorted((r for r in self.positions if r not in self.fixed),
                                  key=lambda r: -self.dist_to(anchors[self.module_of[r]],
                                                              self.positions[r][0],
                                                              self.positions[r][1]))
            moved = 0
            for ref in order_by_far:
                mod = self.module_of[ref]
                cur = self.positions[ref]
                d0 = self.dist_to(anchors[mod], cur[0], cur[1])
                self.g.unmark(self.idx[ref])
                p = self.place_in_module(ref, anchors[mod],
                                         max_r=math.sqrt(d0) + 1.0, nrot=4)
                if p is None:
                    p = (cur[0], cur[1], cur[2],
                         self.b.rect_of(ref, cur[0], cur[1], cur[2]))
                d1 = self.dist_to(anchors[mod], p[0], p[1])
                self.commit(ref, p)
                if d1 < d0 - 1e-9:
                    moved += 1
            print("compaction %d: %d parts pulled closer to their core" % (it + 1, moved))
            if moved == 0:
                break
        return self.unplaced()

    def drop_from_queues(self, ref):
        for q in self.queues[self.module_of[ref]]:
            if ref in q:
                q.remove(ref)

    def unplaced(self):
        return [r for q in self.queues.values() for r in q[0] + q[1]]

    def pad_origin(self, ref, pad_name, target):
        """Position a footprint so that one named pad lands on a board coordinate."""
        for fp in sexpr.footprints(self.cfg["_board_text"]):
            if sexpr.property_value(fp, "Reference") != ref:
                continue
            for pad in fp.kids("pad"):
                if pad.atoms()[1].strip('"') == pad_name:
                    n = pad.first("at").nums()
                    return (target[0] - n[0], target[1] - n[1])
        raise SystemExit("fixed part %s has no pad %r" % (ref, pad_name))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--geometry", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--board", help="board file; required only for pad-anchored fixed parts")
    ap.add_argument("--out", help="placement_plan.json to write "
                                  "(default <placement dir>/placement_plan.json)")
    projpaths.add_outdir(ap)
    args = ap.parse_args()

    # utf-8-sig: a BOM is what you get from Notepad / PowerShell Set-Content
    cfg = json.load(open(args.config, encoding="utf-8-sig"))
    geom = json.load(open(args.geometry, encoding="utf-8-sig"))

    cfg.setdefault("grid_mm", 0.635)
    cfg.setdefault("gap_mm", 0.3)
    cfg.setdefault("big_part_area_mm2", 40.0)
    cfg.setdefault("radius_schedule_mm", [30, 45, 65, 90, 130, 200])
    cfg.setdefault("keepouts", [])
    cfg.setdefault("priority", [])
    cfg.setdefault("fixed", {})
    order = cfg.get("module_order") or sorted(cfg["modules"])

    board_file = args.board or cfg.get("board")
    if board_file is None:
        raise SystemExit("pass --board (or set \"board\" in the config)")
    if not os.path.isabs(board_file):
        if args.board:
            # A path typed on the command line means what it means in the caller's
            # shell: relative to the cwd.  Resolving it against the config instead
            # turns "--config placement/placement_config.json --board board.kicad_pcb"
            # into placement/board.kicad_pcb, which is never what was meant.
            board_file = os.path.abspath(board_file)
        else:
            # A path stored in the config is relative to that config file - which,
            # under the placement/ convention, usually means "../board.kicad_pcb".
            board_file = os.path.join(os.path.dirname(os.path.abspath(args.config)), board_file)
    if not os.path.isfile(board_file):
        raise SystemExit(
            "board file not found: %s\n"
            "  --board is resolved against the current directory (%s);\n"
            "  a \"board\" entry inside the config is resolved against the config file (%s)."
            % (board_file, os.getcwd(), os.path.dirname(os.path.abspath(args.config))))
    cfg["_board_text"] = open(board_file, encoding="utf-8").read()

    out_path = projpaths.resolve_out(args.out, "placement_plan.json",
                                     board=board_file, refs=(args.config,),
                                     outdir=args.outdir)

    for mod in order:
        if mod not in cfg["modules"]:
            raise SystemExit("module_order names unknown module %r" % mod)

    board = Board(geom, geom["outline"])
    packer = Packer(board, cfg)
    unplaced = packer.run(cfg["modules"], order, cfg["fixed"], cfg["keepouts"],
                          cfg["priority"], cfg["radius_schedule_mm"],
                          cfg["big_part_area_mm2"])

    print("\nmodule packing (placed / peripheral total):")
    for mod in order:
        tot = len([r for r in cfg["modules"][mod]["members"] if r not in packer.fixed])
        n = len([r for r in cfg["modules"][mod]["members"] if r in packer.positions])
        print("  %-4s %-34s %3d/%3d" % (mod, packer.labels[mod], n, tot))
    print("placed %d of %d, unplaced: %s"
          % (len(packer.positions), len(board.geo), unplaced))
    print("free area left: %.0f mm2" % packer.g.free_area())

    json.dump({"positions": {k: {"x": v[0], "y": v[1], "rot": v[2]}
                             for k, v in packer.positions.items()},
               "unplaced": unplaced,
               "modules": {m: cfg["modules"][m]["members"] for m in order},
               "module_titles": {m: cfg["modules"][m].get("title", m) for m in order},
               "anchors": {m: cfg["modules"][m]["anchors"] for m in order},
               "fixed": sorted(packer.fixed),
               "keepouts": cfg["keepouts"],
               "grid_mm": cfg["grid_mm"], "gap_mm": cfg["gap_mm"]},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
