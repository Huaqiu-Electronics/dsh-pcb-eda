#!/usr/bin/env python3
"""Update the width of currently selected straight or arc tracks via IPC."""

from __future__ import annotations

import argparse

from kipy.board_types import ArcTrack, Track
from kipy.util import from_mm

from kipy_common import close_kicad, commit_or_drop, connect_board


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width-mm", type=float, required=True, help="target track width, in mm")
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after successful validation")
    args = parser.parse_args()
    if args.width_mm <= 0:
        parser.error("--width-mm must be greater than 0")

    kicad, board = connect_board()
    try:
        targets = [item for item in board.get_selection() if isinstance(item, (Track, ArcTrack))]
        if not targets:
            raise RuntimeError("The current KiCad selection has no straight or arc tracks; no changes made.")

        requested_width = from_mm(args.width_mm)
        for target in targets:
            target.width = requested_width

        def validate(updated):
            if len(updated) != len(targets):
                raise RuntimeError("KiCad did not update all target tracks.")
            if any(item.width != requested_width for item in updated):
                raise RuntimeError("KiCad did not accept all target widths.")

        updated = commit_or_drop(
            board,
            f"Set width of {len(targets)} selected tracks",
            lambda: board.update_items(targets),
            validate,
        )

        print(f"Updated {len(updated)} selected tracks.")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
