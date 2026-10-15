"""Create an isolated saved board; does not operate on any open user board."""

import json
import sys
from pathlib import Path

import pcbnew

directory = Path(sys.argv[1]).resolve()
directory.mkdir(parents=True, exist_ok=True)
project = json.loads(Path(sys.argv[2]).read_text())
(directory / "fixture.kicad_pro").write_text(json.dumps(project))
board = pcbnew.BOARD()
net = pcbnew.NETINFO_ITEM(board, "GND", 1)
board.Add(net)


def point(x, y):
    return pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))


for number, x in enumerate((5, 25), 1):
    fp = pcbnew.FOOTPRINT(board)
    library_id = pcbnew.LIB_ID("Fixture", "Connector")
    fp.SetFPID(library_id)
    fp.SetReference("J" + str(number))
    fp.SetPosition(point(x, 10))
    pad = pcbnew.PAD(fp)
    pad.SetNumber("1")
    pad.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
    pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
    pad.SetSize(point(2, 2))
    pad.SetDrillSize(point(1, 1))
    pad.SetLayerSet(pcbnew.LSET.AllCuMask())
    pad.SetPosition(point(x, 10))
    pad.SetNet(net)
    fp.Add(pad)
    board.Add(fp)
for a, b in (((0, 0), (30, 0)), ((30, 0), (30, 20)), ((30, 20), (0, 20)), ((0, 20), (0, 0))):
    edge = pcbnew.PCB_SHAPE(board)
    edge.SetShape(pcbnew.SHAPE_T_SEGMENT)
    edge.SetLayer(pcbnew.Edge_Cuts)
    edge.SetStart(point(*a))
    edge.SetEnd(point(*b))
    edge.SetWidth(pcbnew.FromMM(0.05))
    board.Add(edge)
track = pcbnew.PCB_TRACK(board)
track.SetStart(point(5, 10))
track.SetEnd(point(10, 10))
track.SetLayer(pcbnew.F_Cu)
track.SetWidth(pcbnew.FromMM(0.8))
track.SetNet(net)
board.Add(track)
via = pcbnew.PCB_VIA(board)
via.SetPosition(point(10, 10))
via.SetWidth(pcbnew.FromMM(1.6))
via.SetDrill(pcbnew.FromMM(0.6))
via.SetViaType(pcbnew.VIATYPE_THROUGH)
via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
via.SetNet(net)
board.Add(via)
pcbnew.SaveBoard(str(directory / "fixture.kicad_pcb"), board)
config = directory / "config" / "10.0"
config.mkdir(parents=True, exist_ok=True)
(config / "kicad_common.json").write_text(
    json.dumps({"api": {"enable_server": True}, "auto_backup": {"enabled": False}})
)
print("fixture ready: 2 pads, 1 original track, 1 original via")
