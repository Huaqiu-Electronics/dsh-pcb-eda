"""One native SES conversion per process, matching the shipped helper lifecycle."""

import json
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).parents[1]), str(Path(__file__).parents[1] / "vendor")]
from ipc_context import connect
from ipc_import import candidate
from specctra import Rejected

try:
    request = json.loads(sys.stdin.read())
    _, board, path = connect(request)
    assert Path(path).name == "fixture.kicad_pcb"
    items, layers, _ = candidate(request, board)
    output = {
        "ok": True,
        "items": [
            {"type": type(item).__name__, "proto": item.proto.SerializeToString().hex()}
            for item in items
        ],
        "layers": list(layers.items()),
    }
except Rejected as error:
    output = {"ok": False, "code": error.code, "message": str(error)}
print(json.dumps(output))
