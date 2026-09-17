#!/usr/bin/env python3
"""Update the width of currently selected straight or arc tracks via IPC."""

from __future__ import annotations

import argparse

from kipy.board_types import ArcTrack, Track
from kipy.util import from_mm

from kipy_common import close_kicad, commit_or_drop, connect_board


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width-mm", type=float, required=True, help="目标线宽，单位 mm")
    parser.add_argument("--save", action="store_true", help="验证成功后通过 IPC 保存 PCB")
    args = parser.parse_args()
    if args.width_mm <= 0:
        parser.error("--width-mm 必须大于 0")

    kicad, board = connect_board()
    try:
        targets = [item for item in board.get_selection() if isinstance(item, (Track, ArcTrack))]
        if not targets:
            raise RuntimeError("当前 KiCad 选择中没有直线或圆弧走线；未做任何修改。")

        requested_width = from_mm(args.width_mm)
        for target in targets:
            target.width = requested_width

        def validate(updated):
            if len(updated) != len(targets):
                raise RuntimeError("KiCad 未更新全部目标走线。")
            if any(item.width != requested_width for item in updated):
                raise RuntimeError("KiCad 未接受全部目标线宽。")

        updated = commit_or_drop(
            board,
            f"Set width of {len(targets)} selected tracks",
            lambda: board.update_items(targets),
            validate,
        )

        print(f"已更新 {len(updated)} 条选中走线。")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
