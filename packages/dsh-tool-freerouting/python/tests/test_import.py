import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / "vendor")]
import unittest
from unittest.mock import patch

from ipc_import import overlap, transaction
from kipy.board_types import BoardLayer, Net, Track
from kipy.geometry import Vector2
from specctra import Rejected, parse, ses_geometry


def track():
    item = Track()
    item.net = Net(name="GND")
    item.layer = BoardLayer.BL_F_Cu
    item.start = Vector2.from_xy(1000, 2000)
    item.end = Vector2.from_xy(3000, 2000)
    item.width = 500
    return item


class FakeBoard:
    def __init__(self, mode="ok"):
        self.items, self.mode, self.events, self.committed = [], mode, [], False

    def snapshot(self):
        visible = self.items if self.committed else []
        text = (
            "(kicad_pcb (version 1)"
            + "".join(f'(segment (uuid "{i.id.value}"))' for i in visible)
            + ")"
        )
        return text, {}, {}, "baseline" if not visible else "changed"

    def begin_commit(self):
        self.events.append("begin")
        if self.mode == "begin_lost":
            raise RuntimeError()
        return "commit"

    def create_items(self, batch):
        self.events.append("create")
        for n, item in enumerate(batch):
            copy = Track(item.proto)
            copy.id.value = "new-" + str(n)
            self.items.append(copy)
        if self.mode == "short":
            return []
        if self.mode == "wrong":
            self.items[0].width += 1
        return self.items

    def get_tracks(self):
        return self.items

    def get_vias(self):
        return []

    def push_commit(self, commit, message):
        self.events.append("push")
        if self.mode == "push_lost":
            raise RuntimeError()
        self.committed = True

    def drop_commit(self, commit):
        self.events.append("drop")
        if self.mode == "rollback_lost":
            raise RuntimeError()
        self.items = []


class ImportTests(unittest.TestCase):
    def execute(self, board, digest="baseline"):
        with patch("ipc_import.fingerprint", lambda b: b.snapshot()):
            return transaction(board, [track()], {BoardLayer.BL_F_Cu: "F.Cu"}, digest)

    def test_commit_is_one_undo_transaction(self):
        board = FakeBoard()
        self.assertEqual(self.execute(board), {"outcome": "committed", "tracks": 1, "vias": 0})
        self.assertEqual(board.events, ["begin", "create", "push"])

    def test_changed_board_creates_nothing(self):
        board = FakeBoard()
        with self.assertRaisesRegex(Rejected, "已改变"):
            self.execute(board, "other")
        self.assertEqual(board.events, [])

    def test_partial_and_wrong_creation_roll_back(self):
        for mode in ("short", "wrong"):
            board = FakeBoard(mode)
            with self.assertRaises(Rejected) as error:
                self.execute(board)
            self.assertEqual(error.exception.outcome, "rolled_back")
            self.assertEqual(board.items, [])
            self.assertEqual(board.events[-1], "drop")

    def test_lost_begin_and_commit_responses_are_uncertain(self):
        for mode in ("begin_lost", "push_lost"):
            board = FakeBoard(mode)
            with self.assertRaises(Rejected) as error:
                self.execute(board)
            self.assertEqual(error.exception.code, "IMPORT_UNCERTAIN")
            self.assertNotIn("drop", board.events)

    def test_partial_old_copper_overlap_is_rejected(self):
        a = ("track", "GND", "F.Cu", 500, (0, 0), (10, 0))
        self.assertTrue(overlap(a, ("track", "GND", "F.Cu", 500, (5, 0), (15, 0))))
        self.assertFalse(overlap(a, ("track", "GND", "F.Cu", 500, (10, 0), (15, 0))))

    def test_parser_handles_native_string_quote(self):
        self.assertEqual(parse('(pcb (parser (string_quote ")) (net "a(b)"))')[2][1], "a(b)")

    def test_invalid_ses_mapping_fails(self):
        ses = "(session x (routes (resolution um 10) (library_out) (network_out (net GND (wire (path top_layer 5 10 -20 30 -20))))))"
        geometry = ses_geometry(ses, {"top_layer", "bottom_layer"}, {"GND"})
        self.assertEqual(geometry, [("track", "GND", "top_layer", 500, (1000, 2000), (3000, 2000))])
        with self.assertRaises(Rejected):
            ses_geometry(ses, {"other"}, {"GND"})


if __name__ == "__main__":
    unittest.main()
