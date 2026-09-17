#!/usr/bin/env python3
"""Create one copper zone from a closed polygon via KiCad IPC.

Pass --points as x,y pairs in millimetres separated by semicolons.  This
creates the zone only; use refill_zones.py separately after reviewing it.
"""

from __future__ import annotations

import argparse

from kipy.board_types import Zone
from kipy.common_types import PolygonWithHoles
from kipy.geometry import PolyLine, PolyLineNode
from kipy.util import from_mm

from kipy_common import (
    close_kicad,
    commit_or_drop,
    connect_board,
    get_required_net,
    resolve_copper_layer,
)


def polygon(value: str) -> PolygonWithHoles:
    points = []
    try:
        for token in value.split(";"):
            x_mm, y_mm = (float(part.strip()) for part in token.split(",", 1))
            points.append((x_mm, y_mm))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--points 格式应为 x,y;x,y;x,y，单位 mm") from exc

    if len(points) < 3:
        raise argparse.ArgumentTypeError("铺铜外形至少需要三个不同顶点")
    if points[0] != points[-1]:
        points.append(points[0])

    outline = PolyLine()
    for x_mm, y_mm in points:
        outline.append(PolyLineNode.from_xy(from_mm(x_mm), from_mm(y_mm)))
    result = PolygonWithHoles()
    result.outline = outline
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--net", required=True, help="已存在的 PCB 网络名")
    parser.add_argument("--layer", default="F.Cu", help="目标铜层，默认 F.Cu")
    parser.add_argument("--points", type=polygon, required=True, help="外形顶点 x,y;x,y;...，单位 mm")
    parser.add_argument("--save", action="store_true", help="验证成功后通过 IPC 保存 PCB")
    args = parser.parse_args()

    kicad, board = connect_board()
    try:
        zone = Zone()
        zone.net = get_required_net(board, args.net)
        zone.layers = [resolve_copper_layer(board, args.layer)]
        zone.outline = args.points

        def validate(created):
            if len(created) != 1:
                raise RuntimeError("KiCad 未创建恰好一个区域。")
            if created[0].net is None or created[0].net.name != args.net:
                raise RuntimeError("KiCad 返回的区域网络与请求不一致。")

        created_zone, = commit_or_drop(
            board,
            f"Create {args.net} copper zone",
            lambda: board.create_items(zone),
            validate,
        )
        print(f"已创建未填充的铺铜区域: {created_zone.id}")
        print("审阅外形后，再运行 refill_zones.py 填充区域。")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
