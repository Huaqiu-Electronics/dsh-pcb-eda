import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / "vendor")]
import pcbnew
from ipc_import import import_session
from routing_repair import add_text_obstacles
from specctra import Rejected, children, one, parse


class RepairTests(unittest.TestCase):
    def test_rotated_copper_text_is_covered_and_original_dsn_bytes_are_preserved(self):
        board = pcbnew.BOARD()
        board.SetLayerName(pcbnew.F_Cu, "top_layer")
        copper = pcbnew.PCB_TEXT(board)
        copper.SetText("I2C PROM")
        copper.SetLayer(pcbnew.F_Cu)
        copper.SetPosition(pcbnew.VECTOR2I(12000000, 34000000))
        copper.SetTextAngle(pcbnew.EDA_ANGLE(37, pcbnew.DEGREES_T))
        board.Add(copper)
        silk = pcbnew.PCB_TEXT(board)
        silk.SetLayer(pcbnew.F_SilkS)
        silk.SetText("silk")
        board.Add(silk)
        source = '(pcb "path (structure fake)" (parser (string_quote ")) (unit um) (structure (layer top_layer)) (wiring))'
        text, count = add_text_obstacles(source, board)
        self.assertEqual(count, 1)
        structure = one(parse(text), "structure")
        obstacle = children(structure, "keepout")[0]
        self.assertEqual(obstacle[2][1], "top_layer")
        values = list(map(float, obstacle[2][2:]))
        box = copper.GetBoundingBox()
        self.assertLessEqual(values[0] * 1000, box.GetX())
        self.assertLessEqual(values[1] * 1000, -box.GetY() - box.GetHeight())
        self.assertGreaterEqual(values[2] * 1000, box.GetX() + box.GetWidth())
        self.assertGreaterEqual(values[3] * 1000, -box.GetY())
        prefix = text.index("\n    (keepout")
        end = text.index(" (layer top_layer)", prefix)
        self.assertEqual(text[:prefix] + text[end:], source)
        self.assertEqual(copper.GetLayer(), pcbnew.F_Cu)
        with self.assertRaises(Rejected):
            add_text_obstacles(source, board, [silk.m_Uuid.AsString()])

    def test_rule_override_requires_repair_and_retains_transaction_guards(self):
        for prepared, allow, accepted in (
            (False, True, False),
            (True, False, False),
            (True, True, True),
        ):
            with tempfile.TemporaryDirectory() as tmp:
                Path(tmp, "manifest.json").write_text(json.dumps({"repairAttempted": prepared}))
                with (
                    patch("ipc_import.refresh_editor", return_value={}) as redraw,
                    patch(
                        "ipc_import.reviewed_candidate",
                        return_value=("board", ["items"], {}, {"count": 1}, "digest", "api"),
                    ),
                    patch(
                        "ipc_import.transaction", return_value={"outcome": "committed"}
                    ) as transaction,
                ):
                    request = {"directory": tmp, "allowDesignViolations": allow}
                    if accepted:
                        self.assertEqual(import_session(request)["outcome"], "committed")
                        transaction.assert_called_once_with("board", ["items"], {}, "digest")
                        redraw.assert_called_once_with("api")
                    else:
                        with self.assertRaises(Rejected) as error:
                            import_session(request)
                        self.assertEqual(error.exception.code, "DESIGN_REPAIR_REQUIRED")
                        transaction.assert_not_called()
                        redraw.assert_not_called()
