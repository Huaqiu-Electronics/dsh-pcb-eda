#!/usr/bin/env python3
"""Delete exactly the currently selected KiCad items via IPC."""

from __future__ import annotations

import argparse

from kipy_common import close_kicad, commit_or_drop, connect_board


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="确认删除当前选择中的所有对象")
    parser.add_argument("--save", action="store_true", help="删除后通过 IPC 保存 PCB")
    args = parser.parse_args()
    if not args.yes:
        parser.error("删除需要显式传入 --yes")

    kicad, board = connect_board()
    try:
        targets = list(board.get_selection())
        if not targets:
            raise RuntimeError("KiCad 当前没有选择对象；未做任何修改。")

        print(f"即将删除当前选择中的 {len(targets)} 个对象。")
        commit_or_drop(
            board,
            f"Delete {len(targets)} selected items",
            lambda: board.remove_items(targets),
        )
        print("已删除当前选择中的对象。")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
