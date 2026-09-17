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
    parser.add_argument("--net", required=True, help="已存在的 PCB 网络名")
    parser.add_argument("--x-mm", type=float, required=True, help="X 坐标，单位 mm")
    parser.add_argument("--y-mm", type=float, required=True, help="Y 坐标，单位 mm")
    parser.add_argument("--diameter-mm", type=float, required=True, help="外径，单位 mm")
    parser.add_argument("--drill-mm", type=float, required=True, help="钻孔直径，单位 mm")
    parser.add_argument("--save", action="store_true", help="验证成功后通过 IPC 保存 PCB")
    args = parser.parse_args()

    if args.drill_mm <= 0 or args.diameter_mm <= args.drill_mm:
        parser.error("必须满足 0 < --drill-mm < --diameter-mm")

    kicad, board = connect_board()
    try:
        via = Via()
        via.position = Vector2.from_xy(from_mm(args.x_mm), from_mm(args.y_mm))
        via.diameter = from_mm(args.diameter_mm)
        via.drill_diameter = from_mm(args.drill_mm)
        via.net = get_required_net(board, args.net)

        def validate(created):
            if len(created) != 1:
                raise RuntimeError("KiCad 未创建恰好一个过孔。")
            if created[0].net.name != args.net:
                raise RuntimeError("KiCad 返回的创建结果与请求不一致。")

        created_via, = commit_or_drop(
            board,
            f"Create via on {args.net}",
            lambda: board.create_items(via),
            validate,
        )

        print(f"已创建 via: {created_via.id}")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
