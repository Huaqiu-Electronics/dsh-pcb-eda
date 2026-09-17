#!/usr/bin/env python3
"""Run a non-persistent live IPC smoke test against the open PCB.

The test performs real API creates, updates, a footprint clone, a copper-zone
create, and a delete inside one unpushed KiCad commit, then drops that commit.
It never calls save().  Use only on a board whose unsaved edits you have
reviewed: dropping a commit does not protect unrelated unsaved GUI changes.
"""

from __future__ import annotations

from kipy.board_types import BoardLayer, Track, Via, Zone
from kipy.common_types import PolygonWithHoles
from kipy.geometry import Angle, PolyLine, PolyLineNode, Vector2
from kipy.util import from_mm

from kipy_common import close_kicad, connect_board


def main() -> None:
    kicad, board = connect_board(timeout_ms=10000)
    commit = None
    try:
        nets = {net.name: net for net in board.get_nets()}
        if "GND" not in nets:
            raise RuntimeError("烟测要求当前板已有 GND 网络。")
        source = board.get_footprints()[0]
        before = (len(board.get_tracks()), len(board.get_vias()), len(board.get_zones()), len(board.get_footprints()))

        commit = board.begin_commit()

        track = Track()
        track.start = Vector2.from_xy_mm(1.0, 1.0)
        track.end = Vector2.from_xy_mm(2.0, 1.0)
        track.width = from_mm(0.25)
        track.layer = BoardLayer.BL_F_Cu
        track.net = nets["GND"]
        created_track, = board.create_items(track)
        assert created_track.net.name == "GND"

        created_track.width = from_mm(0.30)
        updated_track, = board.update_items(created_track)
        assert updated_track.width == from_mm(0.30)

        via = Via()
        via.position = Vector2.from_xy_mm(1.5, 1.0)
        via.diameter = from_mm(0.8)
        via.drill_diameter = from_mm(0.4)
        via.net = nets["GND"]
        created_via, = board.create_items(via)
        assert created_via.net.name == "GND"

        source.position += Vector2.from_xy_mm(0.1, 0.1)
        source.orientation += Angle.from_degrees(5)
        updated_footprint, = board.update_items(source)
        assert updated_footprint.id == source.id

        clone = updated_footprint.clone()
        clone.position += Vector2.from_xy_mm(1.0, 1.0)
        clone.reference_field.text.value = "__IPC_SMOKE_TEST__"
        created_footprint, = board.create_items(clone)
        assert created_footprint.reference_field.text.value == "__IPC_SMOKE_TEST__"

        outline = PolyLine()
        for x_mm, y_mm in ((3.0, 1.0), (4.0, 1.0), (4.0, 2.0), (3.0, 2.0), (3.0, 1.0)):
            outline.append(PolyLineNode.from_xy(from_mm(x_mm), from_mm(y_mm)))
        polygon = PolygonWithHoles()
        polygon.outline = outline
        zone = Zone()
        zone.net = nets["GND"]
        zone.layers = [BoardLayer.BL_F_Cu]
        zone.outline = polygon
        created_zone, = board.create_items(zone)
        assert created_zone.net is not None and created_zone.net.name == "GND"

        board.remove_items(updated_track)
        board.drop_commit(commit)
        commit = None

        after = (len(board.get_tracks()), len(board.get_vias()), len(board.get_zones()), len(board.get_footprints()))
        if after != before:
            raise RuntimeError(f"drop_commit 后对象数量不匹配：before={before}, after={after}")
        print("IPC live smoke test passed; all temporary changes were dropped and not saved.")
    finally:
        if commit is not None:
            board.drop_commit(commit)
        close_kicad(kicad)


if __name__ == "__main__":
    main()
