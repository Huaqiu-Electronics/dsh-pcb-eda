#!/usr/bin/env python3
"""Create one straight track on an existing KiCad PCB net via IPC."""

from __future__ import annotations

import argparse

from kipy.board_types import Track
from kipy.geometry import Vector2
from kipy.util import from_mm

from kipy_common import (
    close_kicad,
    commit_or_drop,
    connect_board,
    get_required_net,
    resolve_copper_layer,
)


def point(value: str) -> Vector2:
    try:
        x_mm, y_mm = (float(part.strip()) for part in value.split(",", 1))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("coordinates must be x,y (in mm), e.g. 10,20") from exc
    return Vector2.from_xy(from_mm(x_mm), from_mm(y_mm))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--net", required=True, help="name of an existing PCB net")
    parser.add_argument("--start", type=point, required=True, help="start point x,y, in mm")
    parser.add_argument("--end", type=point, required=True, help="end point x,y, in mm")
    parser.add_argument("--width-mm", type=float, required=True, help="track width, in mm")
    parser.add_argument("--layer", default="F.Cu", help="target copper layer, default F.Cu")
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after successful validation")
    args = parser.parse_args()

    if args.width_mm <= 0:
        parser.error("--width-mm must be greater than 0")

    kicad, board = connect_board()
    try:
        track = Track()
        track.start = args.start
        track.end = args.end
        track.width = from_mm(args.width_mm)
        track.layer = resolve_copper_layer(board, args.layer)
        track.net = get_required_net(board, args.net)

        def validate(created):
            if len(created) != 1:
                raise RuntimeError("KiCad did not create exactly one track.")
            if created[0].width != track.width or created[0].net.name != args.net:
                raise RuntimeError("KiCad returned a result that does not match the request.")

        created_track, = commit_or_drop(
            board,
            f"Create track on {args.net}",
            lambda: board.create_items(track),
            validate,
        )

        print(f"Created track: {created_track.id}")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
