#!/usr/bin/env python3
"""Create one copper zone from a closed polygon via KiCad IPC.

Pass --points as x,y pairs in millimetres separated by semicolons.  This
creates the zone only; use refill_zones.py separately after reviewing it.
"""

from __future__ import annotations

import argparse

from kipy.board_types import Zone
from kipy.common_types import PolygonWithHoles
from kipy.geometry import PolyLine, PolyLineNode
from kipy.util import from_mm

from kipy_common import (
    close_kicad,
    commit_or_drop,
    connect_board,
    get_required_net,
    resolve_copper_layer,
)


def polygon(value: str) -> PolygonWithHoles:
    points = []
    try:
        for token in value.split(";"):
            x_mm, y_mm = (float(part.strip()) for part in token.split(",", 1))
            points.append((x_mm, y_mm))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--points format should be x,y;x,y;x,y, in mm") from exc

    if len(points) < 3:
        raise argparse.ArgumentTypeError("copper zone outline needs at least three distinct vertices")
    if points[0] != points[-1]:
        points.append(points[0])

    outline = PolyLine()
    for x_mm, y_mm in points:
        outline.append(PolyLineNode.from_xy(from_mm(x_mm), from_mm(y_mm)))
    result = PolygonWithHoles()
    result.outline = outline
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--net", required=True, help="name of an existing PCB net")
    parser.add_argument("--layer", default="F.Cu", help="target copper layer, default F.Cu")
    parser.add_argument("--points", type=polygon, required=True, help="outline vertices x,y;x,y;..., in mm")
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after successful validation")
    args = parser.parse_args()

    kicad, board = connect_board()
    try:
        zone = Zone()
        zone.net = get_required_net(board, args.net)
        zone.layers = [resolve_copper_layer(board, args.layer)]
        zone.outline = args.points

        def validate(created):
            if len(created) != 1:
                raise RuntimeError("KiCad did not create exactly one zone.")
            if created[0].net is None or created[0].net.name != args.net:
                raise RuntimeError("KiCad returned a zone net that does not match the request.")

        created_zone, = commit_or_drop(
            board,
            f"Create {args.net} copper zone",
            lambda: board.create_items(zone),
            validate,
        )
        print(f"Created an unfilled copper zone: {created_zone.id}")
        print("After reviewing the outline, run refill_zones.py to fill the zone.")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
