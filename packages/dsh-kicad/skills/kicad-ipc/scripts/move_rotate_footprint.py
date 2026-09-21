#!/usr/bin/env python3
"""Move and/or rotate one existing footprint via KiCad IPC."""

from __future__ import annotations

import argparse

from kipy.geometry import Angle, Vector2

from kipy_common import close_kicad, commit_or_drop, connect_board


def get_footprint(board, reference: str):
    matches = [
        footprint
        for footprint in board.get_footprints()
        if footprint.reference_field.text.value == reference
    ]
    if len(matches) != 1:
        raise RuntimeError(f"reference {reference!r} matched {len(matches)} footprints; no changes made.")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, help="target footprint reference, e.g. R1")
    parser.add_argument("--dx-mm", type=float, default=0.0, help="X offset, in mm")
    parser.add_argument("--dy-mm", type=float, default=0.0, help="Y offset, in mm")
    parser.add_argument("--rotation-deg", type=float, default=0.0, help="incremental rotation angle, in degrees")
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after successful validation")
    args = parser.parse_args()
    if args.dx_mm == 0 and args.dy_mm == 0 and args.rotation_deg == 0:
        parser.error("specify at least one offset or rotation parameter")

    kicad, board = connect_board()
    try:
        footprint = get_footprint(board, args.reference)
        old_position = footprint.position
        old_orientation = footprint.orientation
        footprint.position += Vector2.from_xy_mm(args.dx_mm, args.dy_mm)
        footprint.orientation += Angle.from_degrees(args.rotation_deg)

        def validate(updated):
            if len(updated) != 1:
                raise RuntimeError("KiCad did not update exactly one footprint.")
            if updated[0].position == old_position and updated[0].orientation == old_orientation:
                raise RuntimeError("KiCad did not apply the footprint transform.")

        updated, = commit_or_drop(
            board,
            f"Move/rotate footprint {args.reference}",
            lambda: board.update_items(footprint),
            validate,
        )
        print(f"Updated {args.reference}: position={updated.position}, orientation={updated.orientation}")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
