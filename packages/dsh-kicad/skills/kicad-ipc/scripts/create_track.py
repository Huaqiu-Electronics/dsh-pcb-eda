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
        raise argparse.ArgumentTypeError("坐标必须是 x,y（单位 mm），例如 10,20") from exc
    return Vector2.from_xy(from_mm(x_mm), from_mm(y_mm))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--net", required=True, help="已存在的 PCB 网络名")
    parser.add_argument("--start", type=point, required=True, help="起点 x,y，单位 mm")
    parser.add_argument("--end", type=point, required=True, help="终点 x,y，单位 mm")
    parser.add_argument("--width-mm", type=float, required=True, help="线宽，单位 mm")
    parser.add_argument("--layer", default="F.Cu", help="目标铜层，默认 F.Cu")
    parser.add_argument("--save", action="store_true", help="验证成功后通过 IPC 保存 PCB")
    args = parser.parse_args()

    if args.width_mm <= 0:
        parser.error("--width-mm 必须大于 0")

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
                raise RuntimeError("KiCad 未创建恰好一条走线。")
            if created[0].width != track.width or created[0].net.name != args.net:
                raise RuntimeError("KiCad 返回的创建结果与请求不一致。")

        created_track, = commit_or_drop(
            board,
            f"Create track on {args.net}",
            lambda: board.create_items(track),
            validate,
        )

        print(f"已创建 track: {created_track.id}")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
