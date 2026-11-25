#!/usr/bin/env python3
"""Draft the placement config from the board's own connectivity - step 2 + 4 helpers.

Step 2 ("every electrical device belongs to exactly one module") and step 4 ("give each
module a rough zone") are the two steps a human otherwise has to do by reading a netlist
and inventing anchors.  Both are largely mechanical, and getting them wrong is the most
expensive kind of wrong: a bad partition survives all the way to the delivered board.

This script does the mechanical part and writes a config you review and correct:

  * clusters devices by shared SIGNAL nets (union-find), with power/ground
    down-weighted the way the skill requires - a net touching half the board carries no
    grouping information, so it must not merge everything into one blob,
  * attaches the power-only parts (decoupling, bulk caps) to the cluster they belong to,
  * names a core per module (highest pin-count / highest intra-module degree),
  * lays the modules out as area-proportional horizontal bands and puts one anchor at
    each band's centre, so the packer has a legal starting region per module,
  * asserts the partition is a true partition (no duplicates, nothing missing) - the
    same assertion the skill tells you to hand-write.

What it deliberately does NOT do: decide which parts are mechanically fixed, or draw
keep-outs.  Those are physical facts about the enclosure and must come from the user.

    python suggest_modules.py --board board.kicad_pcb
    python suggest_modules.py --board board.kicad_pcb --out placement/placement_config.json
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

#: Nets whose name marks them as a supply/return rail.
POWER_NAMES = {"GND", "VCC", "VDD", "VSS", "VPP", "VEE",
               "+5V", "+3V3", "+3.3V", "+12V", "-12V", "VBUS", "VBAT"}


def is_power_name(name, power_extra):
    base = name.strip("/").split("/")[-1]
    return name in POWER_NAMES or base in POWER_NAMES or name in power_extra


def load(board):
    text = open(board, encoding="utf-8").read()
    devs, net2pins = {}, defaultdict(set)
    for fp in sexpr.footprints(text):
        ref = sexpr.property_value(fp, "Reference")
        if ref is None:
            continue
        pins = []
        for pad in fp.kids("pad"):
            num = pad.atoms()[1].strip('"') if len(pad.atoms()) > 1 else ""
            pins.append((num, sexpr.net_name(pad)))
        devs[ref] = {"value": sexpr.property_value(fp, "Value"),
                     "lib": fp.atoms()[1].strip('"'),
                     "pins": pins,
                     "nets": sorted({n for _, n in pins if n})}
        for num, name in pins:
            if name:
                net2pins[name].add((ref, num))
    return devs, net2pins


def ranks(devs, lib):
    """'SOIC-8' / 'R_0805' -> ('sop', 4) so blocks can be laid out sensibly."""
    up = lib.upper()
    if "DIP" in up:
        return "dip", up
    if up.startswith("R_") or up.startswith("C_") or "CHIP" in up:
        return "passive", up
    return "other", up


def bridging_nets(net2pins, candidates, min_pins=4, max_frac=0.5):
    """Nets that act as a *bus* rather than as local wiring.

    A net that really groups parts has its pins already tied together by other nets -
    cut it and they stay connected.  A bus does not: ``/DATA-RB7`` runs from the DB9
    across the buffers to the ZIF socket, and its pins are otherwise in unrelated
    blocks.  Treating such a net as grouping evidence merges half the board into one
    useless module.

    Both guards matter, and the defaults are deliberately conservative:

    * ``min_pins`` - a 3-pin local net (buffer output -> series R -> indicator, a very
      common sub-circuit) is real grouping evidence, not a bus.  Only nets that reach
      across several pins *and* fail the reconnect test are cut.
    * ``max_frac`` - hesitate unless the net genuinely falls apart.  Cutting a net that
      still holds half its pins together shreds a coherent module into single parts,
      which is just as useless as lumping everything into one.

    Returns {net: (largest_component_fraction, n_pins)} for every bridging net found.
    """
    incident = defaultdict(list)
    for n in candidates:
        for r, _ in net2pins[n]:
            incident[r].append(n)

    found = {}
    for n in candidates:
        pins = net2pins[n]
        refs = sorted({r for r, _ in pins})
        if len(refs) < min_pins:
            continue
        start = refs[0]
        seen, stack = {start}, [start]
        while stack:
            cur = stack.pop()
            for other_net in incident[cur]:
                if other_net == n:
                    continue
                for r, _ in net2pins[other_net]:
                    if r not in seen:
                        seen.add(r)
                        stack.append(r)
        frac = len(seen) / float(len(refs))
        if frac <= max_frac:
            found[n] = (round(frac, 3), len(refs))
    return found


def cluster(devs, net2pins, power_extra, fanout_limit):
    """Union-find over non-power, non-single-pin, non-bridging nets."""
    parent = {r: r for r in devs}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    candidates = []
    for n, pins in net2pins.items():
        if len(pins) < 2:
            continue                      # a net nothing else touches groups nothing
        if is_power_name(n, power_extra):
            continue
        if len(pins) > fanout_limit:
            continue                      # a rail by another name: too wide to group
        candidates.append(n)

    bridges = bridging_nets(net2pins, candidates)
    signal_nets = {}
    for n in candidates:
        if n in bridges:
            continue
        signal_nets[n] = net2pins[n]
        refs = sorted({r for r, _ in net2pins[n]})
        for r in refs[1:]:
            union(refs[0], r)

    groups = defaultdict(list)
    for r in devs:
        groups[find(r)].append(r)
    return {k: sorted(v) for k, v in groups.items()}, signal_nets, bridges


def attach_power_only(devs, net2pins, groups, power_extra, fanout_limit):
    """Move devices that only touch power/singletons into their best-host cluster.

    A decoupling cap must sit next to the chip it decouples, and the only evidence is
    which power net it is on - so it goes to the cluster holding the most other devices
    on that same net.
    """
    host_of = {}
    for gid, refs in groups.items():
        for r in refs:
            host_of[r] = gid

    moved = {}
    for gid, refs in list(groups.items()):
        keep = []
        for r in refs:
            functional = [n for n in devs[r]["nets"]
                          if len(net2pins[n]) >= 2 and not is_power_name(n, power_extra)]
            if functional or not devs[r]["nets"]:
                keep.append(r)
                continue
            # power-only: find the cluster sharing the most power-net pins with it
            votes = defaultdict(int)
            for n in devs[r]["nets"]:
                if len(net2pins[n]) > fanout_limit and not is_power_name(n, power_extra):
                    continue
                for other, _ in net2pins[n]:
                    if other != r and host_of.get(other) != gid:
                        votes[host_of[other]] += 1
            best = max(votes.items(), key=lambda kv: (kv[1], -len(groups[kv[0]])))[0] \
                if votes else None
            if best is None:
                keep.append(r)
            else:
                moved.setdefault(best, []).append(r)
        groups[gid] = keep

    for gid, refs in moved.items():
        groups.setdefault(gid, []).extend(refs)
    return {gid: sorted(set(refs)) for gid, refs in groups.items() if refs}, moved


def attach_singletons(devs, net2pins, groups, power_extra, fanout_limit):
    """Fold one-part modules into the block they are actually wired to.

    Single-part modules are an artefact, not a partition: an indicator LED whose series
    resistor was cut off by the bus test becomes its own "module", which then gets its
    own anchor and its own share of the floorplan.  That fragments the layout for no
    reason, so a lone part is merged into whichever module holds most of its
    neighbours.  Ties leave the part alone.
    """
    host_of = {}
    for gid, refs in groups.items():
        for r in refs:
            host_of[r] = gid

    merged = {}
    for gid, refs in list(groups.items()):
        if len(refs) != 1:
            continue
        r = refs[0]
        votes = defaultdict(int)
        nets = [n for n in devs[r]["nets"] if len(net2pins[n]) <= fanout_limit]
        for n in nets:
            for other, _ in net2pins[n]:
                if other == r:
                    continue
                h = host_of.get(other)
                if h is None or h == gid:
                    continue
                votes[h] += 1 if not is_power_name(n, power_extra) else 0
        # power pins vote too, but only as a weak tie-breaker
        for n in devs[r]["nets"]:
            if is_power_name(n, power_extra):
                for other, _ in net2pins[n]:
                    h = host_of.get(other)
                    if h is not None and h != gid:
                        votes[h] += 0.25
        if not votes:
            continue
        best, score = max(votes.items(), key=lambda kv: kv[1])
        if score <= 0:
            continue
        merged.setdefault(best, []).append(r)
        groups[gid] = []

    for gid, refs in merged.items():
        groups.setdefault(gid, []).extend(refs)
    return {gid: sorted(set(refs)) for gid, refs in groups.items() if refs}, len(merged)


def name_module(refs, devs):
    """A short, stable label from the dominant package family / largest part."""
    biggest = max(refs, key=lambda r: len(devs[r]["pins"]))
    lib = devs[biggest]["lib"].split(":")[-1]
    kind = lib.split("_")[0]
    return ("%s_%s" % (kind, refs[0])).lower().replace("-", "_"), biggest


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", required=True)
    ap.add_argument("--out", help="config to write "
                                  "(default <board dir>/placement/placement_config.json)")
    ap.add_argument("--power", action="append", default=[],
                    help="extra net name to treat as a supply rail (repeatable)")
    ap.add_argument("--fanout", type=int, default=8,
                    help="a non-power net touching more than this many devices is "
                         "treated as a rail and ignored for grouping (default 8)")
    ap.add_argument("--grid-mm", type=float, default=0.635)
    ap.add_argument("--gap-mm", type=float, default=0.3)
    ap.add_argument("--rot-modes", type=int, default=4, choices=(2, 3, 4))
    projpaths.add_outdir(ap)
    args = ap.parse_args()

    projpaths.make_console_safe()
    devs, net2pins = load(args.board)
    if not devs:
        raise SystemExit("no footprints found in %s" % args.board)

    groups, signal_nets, bridges = cluster(devs, net2pins, set(args.power), args.fanout)
    groups, moved = attach_power_only(devs, net2pins, groups, set(args.power),
                                      args.fanout)
    groups, folded = attach_singletons(devs, net2pins, groups, set(args.power),
                                       args.fanout)

    # ---- partition assertion: this is the thing the skill says must be enforced ----
    all_members = [r for refs in groups.values() for r in refs]
    dupes = sorted({r for r in all_members if all_members.count(r) > 1})
    missing = sorted(set(devs) - set(all_members))
    if dupes or missing:
        raise SystemExit("internal error: partition is not exact (dupes=%s missing=%s)"
                         % (dupes, missing))

    # ---- names, cores, areas ----
    mods = {}
    for gid, refs in groups.items():
        name, core = name_module(refs, devs)
        while name in mods:
            name += "x"
        mods[name] = {"refs": refs, "core": core}

    net_deg = defaultdict(int)
    for n, pins in signal_nets.items():
        for r, _ in pins:
            net_deg[r] += 1
    for m in mods.values():
        m["area"] = sum(len(devs[r]["pins"]) * 12.0 + 40.0 for r in m["refs"])
        m["pins"] = sum(len(devs[r]["pins"]) for r in m["refs"])

    # ---- order: biggest block first (it has the hardest time finding space) ----
    order = sorted(mods, key=lambda m: (-mods[m]["area"], m))

    # ---- band floorplan over the true board rectangle ----
    geo_path = os.path.join(
        projpaths.placement_dir(board=args.board, outdir=args.outdir, create=False),
        "geometry.json")
    if os.path.isfile(geo_path):
        geo = json.load(open(geo_path, encoding="utf-8-sig"))
        bx0, by0, bx1, by1 = geo["outline_bbox"]
    else:
        bx0 = by0 = 0.0
        bx1 = by1 = math.sqrt(sum(mods[m]["area"] for m in mods)) * 1.6
    bw, bh = bx1 - bx0, by1 - by0
    total_area = sum(mods[m]["area"] for m in mods)
    scale = (bw * bh) / total_area if total_area else 1.0
    target_w = bw * 0.85
    rows, cur, cur_w = [], [], 0.0
    for m in order:
        w = math.sqrt(mods[m]["area"] * scale)
        if cur and cur_w + w > target_w:
            rows.append(cur)
            cur, cur_w = [], 0.0
        cur.append((m, w))
        cur_w += w
    if cur:
        rows.append(cur)

    anchors = {}
    y = by0
    row_h = max(1, len(rows))
    for r in rows:
        tot = sum(w for _, w in r) or 1.0
        h = min((bh - (y - by0)) / max(1, row_h - rows.index(r)), bh)
        x = bx0
        for m, w in r:
            anchors.setdefault(m, []).append(
                [round(x + (w / tot) * bw / 2, 2), round(y + h / 2, 2)])
            x += (w / tot) * bw
        y += h

    # ---- emit ----
    cfg = {
        "board": "../" + os.path.basename(args.board),
        "grid_mm": args.grid_mm,
        "gap_mm": args.gap_mm,
        "big_part_area_mm2": 40.0,
        "radius_schedule_mm": [20, 32, 45, 65, 90, 130],
        "rot_modes": args.rot_modes,
        "_generated_by": "suggest_modules.py - REVIEW before use: anchors are a "
                         "mechanical first guess, and fixed parts / keep-outs are NOT "
                         "filled in because they are physical facts only you know",
        "module_order": order,
        "priority": sorted((m["core"] for m in mods.values()),
                           key=lambda r: -len(devs[r]["pins"])),
        "modules": {m: {"title": "%s (draft)" % m,
                        "core": [mods[m]["core"]],
                        "anchors": anchors.get(m, [[(bx0 + bx1) / 2, (by0 + by1) / 2]]),
                        "members": mods[m]["refs"]}
                    for m in order},
        "fixed": {},
        "keepouts": [],
    }

    out = projpaths.resolve_out(args.out, "placement_config.json",
                                board=args.board, outdir=args.outdir)
    json.dump(cfg, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print("devices                 : %d" % len(devs))
    print("nets total              : %d" % len(net2pins))
    print("grouping nets used      : %d" % len(signal_nets))
    print("bus/bridging nets cut   : %d %s"
          % (len(bridges), sorted(bridges)[:6]))
    print("modules suggested       : %d" % len(mods))
    print("power-only parts attached: %d" % sum(len(v) for v in moved.values()))
    print("lone parts folded in    : %d" % folded)
    print()
    for m in order:
        d = mods[m]
        flag = ""
        if len(d["refs"]) >= max(8, len(devs) // 4):
            flag = "   <- too big: split by hand, it will otherwise eat the floorplan"
        print("  %-22s core %-5s  %2d parts  %3d pins  anchor %s%s"
              % (m, d["core"], len(d["refs"]), d["pins"], anchors.get(m, ["-"])[0], flag))
    print()
    print("partition exact         : no duplicates, no missing  (%d/%d)"
          % (len(all_members), len(devs)))
    print("wrote %s" % out)
    print()
    print("NEXT: open that file and")
    print("  1. rename modules to what they actually are,")
    print("  2. move each anchor into the zone you want that block in,")
    print("  3. add \"fixed\" entries for every mechanically constrained part, and")
    print("  4. add \"keepouts\" for anything that must not be occupied (tall sockets,")
    print("     connectors that tilt, antenna areas).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
