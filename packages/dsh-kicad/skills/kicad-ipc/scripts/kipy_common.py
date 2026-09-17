"""Shared helpers for the KiCad IPC CRUD script templates.

Run the sibling scripts with the Python environment that contains the official
``kicad-python`` package.  This module deliberately has no pcbnew fallback.
"""

from __future__ import annotations

from kipy import KiCad
from kipy.board_types import BoardLayer


def connect_board(timeout_ms: int = 5000):
    """Return a checked KiCad connection and the currently open PCB board."""
    kicad = KiCad(timeout_ms=timeout_ms)

    if not kicad.check_version():
        raise RuntimeError(
            "kicad-python 与已连接 KiCad 的 API 版本不匹配；请使用匹配的官方包。"
        )

    board = kicad.get_board()
    if board is None:
        raise RuntimeError("没有打开的 PCB；请先在 PCB Editor 中打开 .kicad_pcb。")

    return kicad, board


def close_kicad(kicad) -> None:
    """Close newer clients without breaking KiCad 10 / kicad-python 0.8 clients."""
    close = getattr(kicad, "close", None)
    if callable(close):
        close()


def get_required_net(board, name: str):
    """Resolve an existing board net by exact name; never invent a replacement."""
    for net in board.get_nets():
        if net.name == name:
            return net
    raise ValueError(f"PCB 中不存在网络 {name!r}；请先从原理图同步网络。")


def resolve_copper_layer(board, name: str):
    """Resolve a current-board copper layer, with a safe F.Cu/B.Cu legacy fallback."""
    if hasattr(board, "get_layer_by_name"):
        layer = board.get_layer_by_name(name)
        if layer != BoardLayer.BL_UNDEFINED:
            if layer in board.get_enabled_layers():
                return layer
            raise ValueError(f"层 {name!r} 未在当前 PCB 中启用。")

    standard_layers = {
        "F.Cu": BoardLayer.BL_F_Cu,
        "B.Cu": BoardLayer.BL_B_Cu,
    }
    try:
        layer = standard_layers[name]
    except KeyError as exc:
        raise ValueError(
            f"无法在此 KiCad 版本解析层 {name!r}；请使用 F.Cu/B.Cu 或升级。"
        ) from exc

    if hasattr(board, "get_enabled_layers") and layer not in board.get_enabled_layers():
        raise ValueError(f"层 {name!r} 未在当前 PCB 中启用。")
    return layer


def commit_or_drop(board, message: str, operation, validate=None):
    """Run an operation and optional result check in one KiCad undo transaction."""
    commit = board.begin_commit()
    try:
        result = operation()
        if validate is not None:
            validate(result)
        board.push_commit(commit, message)
        return result
    except Exception:
        board.drop_commit(commit)
        raise
