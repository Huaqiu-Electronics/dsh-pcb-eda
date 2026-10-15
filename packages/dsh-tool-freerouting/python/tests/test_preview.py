"""Owned preview replacement must never remove pre-existing copper or hide uncertainty."""

import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / "vendor")]
from ipc_preview import read_state, replace_preview, verify_original
from kipy.board_types import BoardLayer, Track
from specctra import Rejected
from test_import import track

LAYERS = {BoardLayer.BL_F_Cu: "F.Cu"}


class PreviewBoard:
    def __init__(self):
        original = track()
        original.id.value = "original-track"
        self.visible = [original]
        self.added, self.removed = [], []
        self.sequence = 0
        self.failure = ""

    def snapshot(self):
        text = (
            "(kicad_pcb (version 1)"
            + "".join(f'(segment (uuid "{i.id.value}") (width {i.width}))' for i in self.visible)
            + ")"
        )
        digest = hashlib.sha256(text.encode())
        digest.update(b"{}")
        return text, {}, {}, digest.hexdigest()

    def get_tracks(self):
        return self.visible

    def get_vias(self):
        return []

    def begin_commit(self):
        self.added, self.removed = [], []
        return "commit"

    def remove_items(self, items):
        self.removed.extend(i.id.value for i in items)

    def create_items(self, items):
        result = []
        for old in items:
            self.sequence += 1
            new = Track(copy.deepcopy(old.proto))
            new.id.value = f"preview-{self.sequence}"
            result.append(new)
        self.added.extend(result)
        return [] if self.failure == "short" else result

    def push_commit(self, commit, message):
        if self.failure != "deletion_missing":
            self.visible = [i for i in self.visible if i.id.value not in self.removed]
        self.visible.extend(self.added)
        if self.failure == "response_lost":
            raise OSError("lost response")

    def drop_commit(self, commit):
        if self.failure == "drop_lost":
            raise OSError("drop response lost")
        self.added, self.removed = [], []


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.request = {"directory": self.directory.name}
        self.board = PreviewBoard()
        self.baseline = self.board.snapshot()
        Path(self.directory.name, "board.kicad_pcb").write_text(self.baseline[0], encoding="utf8")
        Path(self.directory.name, "manifest.json").write_text(
            json.dumps({"fingerprint": self.baseline[3]})
        )
        self.patcher = patch("ipc_preview.fingerprint", lambda board: board.snapshot())
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def replace(self, items):
        return replace_preview(self.request, self.board, items, LAYERS, read_state(self.request))

    def test_repeated_refresh_and_clear_preserve_original_ids_and_geometry(self):
        original = self.board.visible[0].proto.SerializeToString()
        self.replace([track()])
        first = read_state(self.request)
        self.replace([track(), track()])
        second = read_state(self.request)
        self.assertTrue(set(first["ids"]).isdisjoint(second["ids"]))
        self.assertEqual(len(self.board.visible), 3)
        self.assertEqual(self.board.visible[0].proto.SerializeToString(), original)
        verify_original(self.request, self.board, second, LAYERS)
        self.replace([])
        self.assertEqual(self.board.snapshot(), self.baseline)
        self.assertEqual(read_state(self.request)["ids"], [])

    def test_failed_refresh_restores_previous_preview_and_journal(self):
        self.replace([track()])
        previous = self.board.snapshot()
        state = read_state(self.request)
        self.board.failure = "short"
        with self.assertRaises(Rejected) as failure:
            self.replace([track(), track()])
        self.assertEqual(failure.exception.outcome, "rolled_back")
        self.assertEqual(self.board.snapshot(), previous)
        self.assertEqual(read_state(self.request), state)

    def test_lost_commit_or_incomplete_delete_is_uncertain(self):
        for mode in ("response_lost", "deletion_missing"):
            with self.subTest(mode=mode):
                self.board.failure = ""
                self.replace([track()])
                self.board.failure = mode
                with self.assertRaises(Rejected) as failure:
                    self.replace([track()])
                self.assertEqual(failure.exception.code, "IMPORT_UNCERTAIN")
                self.board = PreviewBoard()
                Path(self.directory.name, "preview-items.json").unlink()

    def test_user_modification_rejects_update_but_cleanup_preserves_it(self):
        self.replace([track()])
        self.board.visible[0].width += 100
        with self.assertRaises(Rejected) as failure:
            verify_original(self.request, self.board, read_state(self.request), LAYERS)
        self.assertEqual(failure.exception.code, "BOARD_CHANGED")
        self.replace([])
        self.assertEqual(len(self.board.visible), 1)
        self.assertEqual(self.board.visible[0].width, track().width + 100)

    def test_user_modification_of_owned_copper_cannot_be_deleted(self):
        self.replace([track()])
        self.board.visible[-1].width += 100
        with self.assertRaises(Rejected) as failure:
            self.replace([])
        self.assertEqual(failure.exception.code, "BOARD_CHANGED")
        self.assertEqual(len(self.board.visible), 2)


if __name__ == "__main__":
    unittest.main()
