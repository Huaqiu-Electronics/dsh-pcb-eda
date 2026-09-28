#!/usr/bin/env python3
"""Create one through via on an existing KiCad PCB net via IPC."""

from __future__ import annotations

import argparse

from kipy.board_types import Via
from kipy.geometry import Vector2
from kipy.util import from_mm

from kipy_common import close_kicad, commit_or_drop, connect_board, get_required_net


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--net", required=True, help="name of an existing PCB net")
    parser.add_argument("--x-mm", type=float, required=True, help="X coordinate, in mm")
    parser.add_argument("--y-mm", type=float, required=True, help="Y coordinate, in mm")
    parser.add_argument("--diameter-mm", type=float, required=True, help="outer diameter, in mm")
    parser.add_argument("--drill-mm", type=float, required=True, help="drill diameter, in mm")
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after successful validation")
    args = parser.parse_args()

    if args.drill_mm <= 0 or args.diameter_mm <= args.drill_mm:
        parser.error("must satisfy 0 < --drill-mm < --diameter-mm")

    kicad, board = connect_board()
    try:
        via = Via()
        via.position = Vector2.from_xy(from_mm(args.x_mm), from_mm(args.y_mm))
        via.diameter = from_mm(args.diameter_mm)
        via.drill_diameter = from_mm(args.drill_mm)
        via.net = get_required_net(board, args.net)

        def validate(created):
            if len(created) != 1:
                raise RuntimeError("KiCad did not create exactly one via.")
            if created[0].net.name != args.net:
                raise RuntimeError("KiCad returned a result that does not match the request.")

        created_via, = commit_or_drop(
            board,
            f"Create via on {args.net}",
            lambda: board.create_items(via),
            validate,
        )

        print(f"Created via: {created_via.id}")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
