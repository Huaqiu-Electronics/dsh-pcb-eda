#!/usr/bin/env python3
"""Read-only diagnostic for a KiCad IPC connection.

Use before a write script.  It does not edit or save the current PCB.
"""

from __future__ import annotations

import sys


def main() -> int:
    try:
        from kipy import KiCad
    except ModuleNotFoundError:
        print("未找到 kicad-python/kipy。请使用 KiCad IPC 插件环境或安装匹配的官方包。")
        return 2

    kicad = None
    try:
        kicad = KiCad(timeout_ms=5000)
        if not kicad.check_version():
            print("已连接，但 kicad-python 与 KiCad API 版本不匹配。")
            return 3

        board = kicad.get_board()
        if board is None:
            print("已连接 KiCad API，但 PCB Editor 中没有打开 .kicad_pcb。")
            return 4

        print(f"已连接 KiCad {kicad.get_version()}。")
        print(f"当前 PCB: {board.name}")
        return 0
    except Exception as exc:
        print(f"无法连接 KiCad IPC API: {exc}")
        print("请确认：")
        print("  1. 已打开 PCB Editor（仅打开项目管理器还不够）。")
        print("  2. 在 KiCad 的 偏好设置 → 插件 中启用了 API 服务，并已重启 PCB Editor。")
        print("  3. 若在 DSH 中执行，当前任务拥有 Full Access；非 Full Access 无法访问 KiCad 命名管道。")
        return 1
    finally:
        if kicad is not None:
            close = getattr(kicad, "close", None)
            if callable(close):
                close()


if __name__ == "__main__":
    sys.exit(main())
