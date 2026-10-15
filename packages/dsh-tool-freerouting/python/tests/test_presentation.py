"""Board-object labels preserve hardware names and original native diagnostics."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pcbnew
from design_checks import object_labels, validate_report


class PresentationTests(unittest.TestCase):
    def test_labels_come_from_real_board_objects(self):
        board = pcbnew.BOARD()
        net = pcbnew.NETINFO_ITEM(board, "/VPP{slash}MCLR", 1)
        board.Add(net)
        text = pcbnew.PCB_TEXT(board)
        text.SetText("I2C PROM")
        text.SetLayer(pcbnew.F_Cu)
        board.Add(text)
        track = pcbnew.PCB_TRACK(board)
        track.SetNet(net)
        board.Add(track)
        footprint = pcbnew.FOOTPRINT(board)
        footprint.SetReference("J1")
        pad = pcbnew.PAD(footprint)
        pad.SetNumber("1")
        footprint.Add(pad)
        board.Add(footprint)
        labels = object_labels(board)
        self.assertEqual(labels[text.m_Uuid.AsString()], "铜文字「I2C PROM」")
        self.assertEqual(labels[track.m_Uuid.AsString()], "走线（网络 [/VPP/MCLR]）")
        self.assertEqual(labels[pad.m_Uuid.AsString()], "焊盘 J1-1")
        issue = {
            "type": "clearance",
            "description": "native DRC 0.2 mm",
            "items": [
                {
                    "uuid": text.m_Uuid.AsString(),
                    "description": "Text I2C PROM on F.Cu",
                    "pos": {"x": 1, "y": 2},
                }
            ],
        }
        report = validate_report(
            {"coordinate_units": "mm", "violations": [issue]}, {text.m_Uuid.AsString()}, labels
        )
        item = report["violations"][0]["items"][0]
        self.assertEqual(item["label"], "铜文字「I2C PROM」")
        self.assertEqual(item["description"], "Text I2C PROM on F.Cu")
        self.assertEqual(item["x"], 1)


if __name__ == "__main__":
    unittest.main()
