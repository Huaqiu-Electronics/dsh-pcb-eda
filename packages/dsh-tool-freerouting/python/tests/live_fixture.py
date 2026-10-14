"""Explicit integration check on the generated fixture only, never the user's open PCB."""

import json
import subprocess
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / "vendor")]
from ipc_context import connect, fingerprint
from ipc_import import fill, transaction
from kipy.board_types import BoardLayer, Net, Track, Via, Zone
from kipy.geometry import PolygonWithHoles, PolyLine, PolyLineNode, Vector2
from specctra import Rejected


def candidate(request, _board):
    # Reusing KiCad's native LoadBoard/SES cache can corrupt native state. The
    # product uses one command per helper, so this integration bench does too.
    process = subprocess.run(
        [sys.executable, "-B", str(Path(__file__).with_name("candidate_probe.py"))],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        timeout=110,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if process.returncode != 0:
        raise AssertionError("native probe failed: " + process.stderr[-2000:])
    output = json.loads(process.stdout)
    if not output["ok"]:
        raise Rejected(output["code"], output["message"])
    items = []
    for data in output["items"]:
        item = {"Track": Track, "Via": Via}[data["type"]]()
        item.proto.ParseFromString(bytes.fromhex(data["proto"]))
        items.append(item)
    return items, dict(output["layers"])


def main():
    directory = Path(sys.argv[1]).resolve()
    request = {
        "socket": sys.argv[2],
        "directory": str(directory),
        "clientName": "dsh-isolated-integration",
        "nets": ["GND"],
    }
    api, board, path = connect(request)
    assert Path(path).name == "fixture.kicad_pcb" and Path(path).parent == directory.parent
    baseline = fingerprint(board)
    disk_before = Path(path).read_bytes()
    original_ids = {i.id.value for i in [*board.get_tracks(), *board.get_vias()]}
    original_protos = {
        i.id.value: i.proto.SerializeToString(deterministic=True)
        for i in [*board.get_tracks(), *board.get_vias()]
    }
    ses_path = directory / "board.ses"
    original_ses = ses_path.read_text()

    def add_copper(text):
        return original_ses.replace("(net GND", "(net GND " + text, 1)

    try:
        ses_path.write_text(add_copper('(via "Via[0-1]_600:300_um" 200000 -100000)'))
        items, layers = candidate(request, board)
    finally:
        ses_path.write_text(original_ses)
    outcome = transaction(board, items, layers, baseline[3])
    assert outcome == {"outcome": "committed", "tracks": 1, "vias": 1}
    all_items = [*board.get_tracks(), *board.get_vias()]
    assert len(all_items) == len(original_ids) + len(items)
    assert all(
        i.proto.SerializeToString(deterministic=True) == original_protos[i.id.value]
        for i in all_items
        if i.id.value in original_ids
    )
    assert Path(path).read_bytes() == disk_before
    print("PASS: mapped new tracks/via; originals intact; disk not saved")
    api.run_action("common.Interactive.undo")
    assert fingerprint(board)[3] == baseline[3]
    print("PASS: one undo restores exact snapshot")
    assert fill(request) == {"zonesFilled": 0, "skipped": True}

    try:
        ses_path.write_text(
            add_copper(
                "(wire (path F.Cu 8000 50000 -100000 100000 -100000)) "
                '(via "Via[0-1]_1600:600_um" 100000 -100000)'
            )
        )
        assert len(candidate(request, board)[0]) == 1
        ses_path.write_text(add_copper("(wire (path F.Cu 8000 50000 -100000 75000 -100000))"))
        try:
            candidate(request, board)
            raise AssertionError("partial original overlap accepted")
        except Rejected as error:
            assert error.code == "ORIGINAL_COPPER_OVERLAP"
    finally:
        ses_path.write_text(original_ses)
    print("PASS: exact original copper filtered; partial overlap rejected")

    class PartialCreation:
        def __getattr__(self, name):
            return getattr(board, name)

        def create_items(self, batch):
            board.create_items(batch)
            return []

    try:
        transaction(PartialCreation(), items, layers, baseline[3])
        raise AssertionError("partial creation accepted")
    except Rejected as error:
        assert error.code == "CREATE_VERIFICATION" and error.outcome == "rolled_back"
    assert fingerprint(board)[3] == baseline[3]
    print("PASS: live partial creation rolls back exactly")
    track = board.get_tracks()[0]
    track.width += 1000
    board.update_items([track])
    try:
        transaction(board, items, layers, baseline[3])
        raise AssertionError("changed board accepted")
    except Rejected as error:
        assert error.code == "BOARD_CHANGED"
    finally:
        api.run_action("common.Interactive.undo")
    assert fingerprint(board)[3] == baseline[3]
    print("PASS: any board change rejects import; no-zone skip explicit")

    zone = Zone()
    zone.net = Net(name="GND")
    zone.layers = [BoardLayer.BL_B_Cu]
    zone.clearance = 250000
    polygon, line = PolygonWithHoles(), PolyLine()
    for x, y in [(1, 1), (29, 1), (29, 19), (1, 19)]:
        node = PolyLineNode()
        node.point = Vector2.from_xy_mm(x, y)
        line.append(node)
    polygon.outline = line
    zone.outline = polygon
    commit = board.begin_commit()
    zones = board.create_items([zone])
    board.push_commit(commit, "isolated fixture zone")
    try:
        assert fill(request) == {"zonesFilled": 1, "skipped": False}
        assert board.get_zones()[0].filled
        assert Path(path).read_bytes() == disk_before
    finally:
        board.remove_items(zones)
    assert len(board.get_zones()) == 0
    print("PASS: refill existing zone; no automatic board save")


if __name__ == "__main__":
    main()
