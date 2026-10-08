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
            "kicad-python does not match the connected KiCad's API version; use the matching official package."
        )

    board = kicad.get_board()
    if board is None:
        raise RuntimeError("No PCB is open; please open a .kicad_pcb in PCB Editor first.")

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
    raise ValueError(f"Net {name!r} does not exist in the PCB; please sync nets from the schematic first.")


def resolve_copper_layer(board, name: str):
    """Resolve a current-board copper layer, with a safe F.Cu/B.Cu legacy fallback."""
    if hasattr(board, "get_layer_by_name"):
        layer = board.get_layer_by_name(name)
        if layer != BoardLayer.BL_UNDEFINED:
            if layer in board.get_enabled_layers():
                return layer
            raise ValueError(f"Layer {name!r} is not enabled in the current PCB.")

    standard_layers = {
        "F.Cu": BoardLayer.BL_F_Cu,
        "B.Cu": BoardLayer.BL_B_Cu,
    }
    try:
        layer = standard_layers[name]
    except KeyError as exc:
        raise ValueError(
            f"Cannot resolve layer {name!r} in this KiCad version; use F.Cu/B.Cu or upgrade."
        ) from exc

    if hasattr(board, "get_enabled_layers") and layer not in board.get_enabled_layers():
        raise ValueError(f"Layer {name!r} is not enabled in the current PCB.")
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
