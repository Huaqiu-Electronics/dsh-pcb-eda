#!/usr/bin/env python3
"""Fill existing copper zones on the open PCB via KiCad IPC."""

from __future__ import annotations

import argparse

from kipy_common import close_kicad, connect_board


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--save", action="store_true", help="填充完成后通过 IPC 保存 PCB")
    args = parser.parse_args()

    kicad, board = connect_board(timeout_ms=30000)
    try:
        zones = list(board.get_zones())
        if not zones:
            print("当前 PCB 没有区域，无需填充。")
            return

        board.refill_zones(block=True, max_poll_seconds=120.0)
        print(f"已请求并等待 {len(zones)} 个区域填充完成。")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
