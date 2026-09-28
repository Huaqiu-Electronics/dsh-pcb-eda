#!/usr/bin/env python3
"""Delete exactly the currently selected KiCad items via IPC."""

from __future__ import annotations

import argparse

from kipy_common import close_kicad, commit_or_drop, connect_board


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="confirm deletion of all objects in the current selection")
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after deletion")
    args = parser.parse_args()
    if not args.yes:
        parser.error("deletion requires passing --yes explicitly")

    kicad, board = connect_board()
    try:
        targets = list(board.get_selection())
        if not targets:
            raise RuntimeError("KiCad currently has no selection; no changes made.")

        print(f"About to delete {len(targets)} objects in the current selection.")
        commit_or_drop(
            board,
            f"Delete {len(targets)} selected items",
            lambda: board.remove_items(targets),
        )
        print("Deleted objects in the current selection.")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
