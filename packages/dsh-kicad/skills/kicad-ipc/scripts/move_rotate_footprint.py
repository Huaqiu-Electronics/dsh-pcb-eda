#!/usr/bin/env python3
"""Move and/or rotate one existing footprint via KiCad IPC."""

from __future__ import annotations

import argparse

from kipy.geometry import Angle, Vector2

from kipy_common import close_kicad, commit_or_drop, connect_board


def get_footprint(board, reference: str):
    matches = [
        footprint
        for footprint in board.get_footprints()
        if footprint.reference_field.text.value == reference
    ]
    if len(matches) != 1:
        raise RuntimeError(f"reference {reference!r} 匹配到 {len(matches)} 个封装；未做修改。")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, help="目标封装 reference，例如 R1")
    parser.add_argument("--dx-mm", type=float, default=0.0, help="X 位移，单位 mm")
    parser.add_argument("--dy-mm", type=float, default=0.0, help="Y 位移，单位 mm")
    parser.add_argument("--rotation-deg", type=float, default=0.0, help="增量旋转角度，单位度")
    parser.add_argument("--save", action="store_true", help="验证成功后通过 IPC 保存 PCB")
    args = parser.parse_args()
    if args.dx_mm == 0 and args.dy_mm == 0 and args.rotation_deg == 0:
        parser.error("至少指定一个位移或旋转参数")

    kicad, board = connect_board()
    try:
        footprint = get_footprint(board, args.reference)
        old_position = footprint.position
        old_orientation = footprint.orientation
        footprint.position += Vector2.from_xy_mm(args.dx_mm, args.dy_mm)
        footprint.orientation += Angle.from_degrees(args.rotation_deg)

        def validate(updated):
            if len(updated) != 1:
                raise RuntimeError("KiCad 未更新恰好一个封装。")
            if updated[0].position == old_position and updated[0].orientation == old_orientation:
                raise RuntimeError("KiCad 没有应用封装变换。")

        updated, = commit_or_drop(
            board,
            f"Move/rotate footprint {args.reference}",
            lambda: board.update_items(footprint),
            validate,
        )
        print(f"已更新 {args.reference}: position={updated.position}, orientation={updated.orientation}")
        if args.save:
            board.save()
            print("已通过 IPC 保存 PCB。")
    finally:
        close_kicad(kicad)


if __name__ == "__main__":
    main()
