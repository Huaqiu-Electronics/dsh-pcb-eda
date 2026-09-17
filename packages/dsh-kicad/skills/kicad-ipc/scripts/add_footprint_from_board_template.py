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
        raise RuntimeError(f"source reference {reference!r} 匹配到 {len(matches)} 个封装。")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-reference", required=True, help="作为完整定义模板的现有 reference")
    parser.add_argument("--new-reference", required=True, help="新封装的唯一 reference")
    parser.add_argument("--dx-mm", type=float, required=True, help="相对模板的 X 位移，单位 mm")
    parser.add_argument("--dy-mm", type=float, required=True, help="相对模板的 Y 位移，单位 mm")
    parser.add_argument("--save", action="store_true", help="验证成功后通过 IPC 保存 PCB")
    args = parser.parse_args()
    if args.source_reference == args.new_reference:
        parser.error("--new-reference 必须不同于 --source-reference")

    kicad, board = connect_board()
    try:
        if any(fp.reference_field.text.value == args.new_reference for fp in board.get_footprints()):
            raise RuntimeError(f"reference {args.new_reference!r} 已存在；未创建封装。")

        source = get_unique_footprint(board, args.source_reference)
        new_footprint = source.clone()
        new_footprint.position += Vector2.from_xy_mm(args.dx_mm, args.dy_mm)
        new_footprint.reference_field.text.value = args.new_reference

        def validate(created):
            if len(created) != 1:
                raise RuntimeError("KiCad 未创建恰好一个封装。")
            if created[0].reference_field.text.value != args.new_reference:
                raise RuntimeError("KiCad 返回的封装 reference 与请求不一致。")

        created, = commit_or_drop(
            board,
            f"Create footprint {args.new_reference} from {args.source_reference}",
            lambda: board.create_items(new_footprint),
            validate,
        )
        print(f"已创建 {created.reference_field.text.value}: {created.id}")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
