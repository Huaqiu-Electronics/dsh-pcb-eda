"""Refresh the KiCad 10 canvas after verified copper changes.

push_commit updates the board and counters but the exercised Windows 10.0.6
canvas can remain stale until F5. This action redraws only; it never saves,
changes geometry, or adds an undo record. A refresh failure is a display warning,
not an uncertain board transaction. See ADR-012 for the observed before/after.
"""

from kipy.proto.common.commands.editor_commands_pb2 import RAS_OK

DISPLAY_WARNING = "走线数据已更新，但画面未能自动刷新；请在 KiCad 中按 F5 刷新后检查"


def refresh_editor(api):
    try:
        if api.run_action("common.Control.zoomRedraw").status == RAS_OK:
            return {}
    except Exception:
        # Copper was already verified. Do not misreport a redraw failure as a
        # failed import, retry the commit, or discard confirmed board changes.
        pass
    return {"displayWarning": DISPLAY_WARNING}
