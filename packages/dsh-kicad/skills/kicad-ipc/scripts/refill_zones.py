#!/usr/bin/env python3
"""Fill existing copper zones on the open PCB via KiCad IPC."""

from __future__ import annotations

import argparse

from kipy_common import close_kicad, connect_board


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--save", action="store_true", help="save the PCB over IPC after filling")
    args = parser.parse_args()

    kicad, board = connect_board(timeout_ms=30000)
    try:
        zones = list(board.get_zones())
        if not zones:
            print("The current PCB has no zones; nothing to fill.")
            return

        board.refill_zones(block=True, max_poll_seconds=120.0)
        print(f"Requested and waited for {len(zones)} zones to finish filling.")
        if args.save:
            board.save()
            print("Saved PCB over IPC.")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
