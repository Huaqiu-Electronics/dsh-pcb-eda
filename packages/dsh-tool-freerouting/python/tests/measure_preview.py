"""Measure dedicated real PCB preview refresh and cleanup; never saves live copper."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(root / "python"), str(root / "python/vendor")]
from kipy import KiCad
from kipy.board_types import BoardLayer, Track
from kipy.geometry import Vector2
from windows_resources import sample

result_path = root / ".dsh-host-smoke/preview-pressure-result.json"
result_path.parent.mkdir(parents=True, exist_ok=True)
config_source = Path(os.environ["DSH_IPC_TEST_CONFIG"])
samples = []
with tempfile.TemporaryDirectory(prefix="routing-preview-pressure-") as directory_text:
    directory = Path(directory_text)
    project = directory / "input.kicad_pro"
    project.write_text("{}")
    subprocess.run(
        [
            sys.executable,
            "-B",
            str(root / "python/tests/make_fixture.py"),
            str(directory),
            str(project),
        ],
        check=True,
        timeout=15,
        stdout=subprocess.DEVNULL,
    )
    config = directory / "config/10.0"
    for name in [
        "kicad_common.json",
        "pcbnew.json",
        "fp-lib-table",
        "sym-lib-table",
        "design-block-lib-table",
        "kicad.json",
    ]:
        shutil.copyfile(config_source / name, config / name)
    common = json.loads((config / "kicad_common.json").read_text(encoding="utf-8"))
    common["api"]["enable_server"] = True
    common["auto_backup"]["enabled"] = False
    (config / "kicad_common.json").write_text(json.dumps(common), encoding="utf-8")
    temporary = directory / "tmp"
    temporary.mkdir()
    pcb = directory / "fixture.kicad_pcb"
    disk = hashlib.sha256(pcb.read_bytes()).hexdigest()
    editor = subprocess.Popen(
        [str(Path(sys.executable).parent / "pcbnew.exe"), str(pcb)],
        env={
            **os.environ,
            "KICAD_CONFIG_HOME": str(config.parent),
            "TEMP": str(temporary),
            "TMP": str(temporary),
        },
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        api = KiCad(
            socket_path="ipc://" + str(temporary / "kicad/api.sock"),
            kicad_token="",
            timeout_ms=5000,
        )
        deadline = time.monotonic() + 60
        while True:
            try:
                board = api.get_board()
                assert board.name == "fixture.kicad_pcb"
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.3)
        original = {x.id.value for x in [*board.get_tracks(), *board.get_vias()]}
        net = next(n for n in board.get_nets() if n.name == "GND")
        owned = []
        for count in (128, 512, 1024):
            for refresh in range(8):
                commit = board.begin_commit()
                for i in range(0, len(owned), 256):
                    board.remove_items(owned[i : i + 256])
                items = []
                for i in range(count):
                    track = Track()
                    x = int((1 + (i % 100) * 0.25) * 1e6)
                    y = int((1 + (i // 100) * 0.25 + refresh * 0.001) * 1e6)
                    track.start = Vector2.from_xy(x, y)
                    track.end = Vector2.from_xy(x + 100000, y)
                    track.width = 100000
                    track.layer = BoardLayer.BL_F_Cu
                    track.net = net
                    items.append(track)
                owned = []
                for i in range(0, count, 256):
                    owned.extend(board.create_items(items[i : i + 256]))
                board.push_commit(commit, "DSH isolated preview pressure")
                assert len(board.get_tracks()) == count + 1
                measure = sample([editor.pid, os.getpid()])
                measure["count"] = count
                measure["refresh"] = refresh
                samples.append(measure)
        before_clear = sample([editor.pid, os.getpid()])
        commit = board.begin_commit()
        for i in range(0, len(owned), 256):
            board.remove_items(owned[i : i + 256])
        board.push_commit(commit, "DSH isolated pressure cleanup")
        assert {x.id.value for x in [*board.get_tracks(), *board.get_vias()]} == original
        assert hashlib.sha256(pcb.read_bytes()).hexdigest() == disk
        after_clear = sample([editor.pid, os.getpid()])
        result = {
            "preview_commits": 24,
            "max_preview_tracks": 1024,
            "samples": samples,
            "before_clear": before_clear,
            "after_clear": after_clear,
            "original_copper_preserved": True,
            "disk_unchanged": True,
            "scope": "Real fixture preview replacement and deletion, not all PCB sizes or long-duration undo history",
        }
        result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        maxima = {
            pid: max(p["private"] for s in samples for p in s["processes"] if p["pid"] == pid)
            for pid in [editor.pid, os.getpid()]
        }
        print(
            json.dumps(
                {
                    "passed": True,
                    "commits": 24,
                    "max_private_bytes": maxima,
                    "after_clear": after_clear["processes"],
                }
            )
        )
    finally:
        if editor.poll() is None:
            editor.kill()
        editor.wait(timeout=10)
