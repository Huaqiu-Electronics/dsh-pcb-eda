#!/usr/bin/env python3
"""Create a new footprint by cloning a named on-board footprint via KiCad IPC.

This preserves the complete footprint definition without editing a .kicad_pcb
file.  It deliberately uses the public clone() API so KiCad generates a new
top-level UUID.  It is not a replacement for a future direct library-placement
API.
"""

from __future__ import annotations

import argparse

from kipy.geometry import Vector2

from kipy_common import close_kicad, commit_or_drop, connect_board


def get_unique_footprint(board, reference: str):
    matches = [
        footprint
        for footprint in board.get_footprints()
        if footprint.reference_field.text.value == reference
    ]
    if len(matches) != 1:
        raise RuntimeError(f"source reference {reference!r} matched {len(matches)} footprints.")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-reference", required=True, help="existing reference to use as the full-definition template")
    parser.add_argument("--new-reference", required=True, help="unique reference for the new footprint")
    parser.add_argument("--dx-mm", type=float, required=True, help="X offset relative to the template, in mm")
    parser.add_argument("--dy-mm", type=float, required=True, help="Y offset relative to the template, in mm")
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after successful validation")
    args = parser.parse_args()
    if args.source_reference == args.new_reference:
        parser.error("--new-reference must differ from --source-reference")

    kicad, board = connect_board()
    try:
        if any(fp.reference_field.text.value == args.new_reference for fp in board.get_footprints()):
            raise RuntimeError(f"reference {args.new_reference!r} already exists; no footprint created.")

        source = get_unique_footprint(board, args.source_reference)
        new_footprint = source.clone()
        new_footprint.position += Vector2.from_xy_mm(args.dx_mm, args.dy_mm)
        new_footprint.reference_field.text.value = args.new_reference

        def validate(created):
            if len(created) != 1:
                raise RuntimeError("KiCad did not create exactly one footprint.")
            if created[0].reference_field.text.value != args.new_reference:
                raise RuntimeError("KiCad returned a footprint reference that does not match the request.")

        created, = commit_or_drop(
            board,
            f"Create footprint {args.new_reference} from {args.source_reference}",
            lambda: board.create_items(new_footprint),
            validate,
        )
        print(f"Created {created.reference_field.text.value}: {created.id}")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
