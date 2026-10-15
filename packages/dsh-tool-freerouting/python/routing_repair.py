"""Add conservative copper-text obstacles to routing data; never edit the live PCB."""

import json
import re
from pathlib import Path

import pcbnew
from ipc_context import connect, fingerprint
from specctra import one, parse, require, verify_dsn


def structure_offset(text):
    # Preserve native quoted paths, parser settings, rules and original copper verbatim.
    depth = 0
    expect_head = False
    for match in re.finditer(r'\s+|\(|\)|(?<=string_quote )"|"(?:\\.|[^"\\])*"|[^\s()"]+', text):
        token = match.group()
        if token.isspace():
            continue
        if token == "(":
            depth += 1
            expect_head = True
        elif token == ")":
            depth -= 1
            expect_head = False
        else:
            if expect_head and depth == 2 and token == "structure":
                return match.end()
            expect_head = False
    require(False, "REPAIR_DATA_INVALID", "布线资料缺少可验证的板层结构")


def add_text_obstacles(text, board, selected=None):
    root = parse(text)
    require(one(root, "unit")[1] == "um", "REPAIR_DATA_INVALID", "布线资料坐标单位无法识别")
    one(root, "structure")
    texts = {
        item.m_Uuid.AsString(): item
        for item in board.GetDrawings()
        if isinstance(item, pcbnew.PCB_TEXT) and pcbnew.IsCopperLayer(item.GetLayer())
    }
    require(
        selected is None
        or (isinstance(selected, list) and all(isinstance(value, str) for value in selected)),
        "REPAIR_DATA_INVALID",
        "避让对象列表无效",
    )
    require(
        selected is None or set(selected) <= texts.keys(),
        "REPAIR_OBJECT_UNSUPPORTED",
        "指定对象不是原板上的铜文字，无法自动增加避让范围",
    )
    chosen = texts.keys() if selected is None else dict.fromkeys(selected)
    obstacles = []
    for identifier in chosen:
        item = texts[identifier]
        box = item.GetBoundingBox()
        require(
            box.GetWidth() > 0 and box.GetHeight() > 0,
            "REPAIR_GEOMETRY_INVALID",
            "铜文字避让范围无法确定",
        )
        x1, x2 = sorted((box.GetX(), box.GetX() + box.GetWidth()))
        y1, y2 = sorted((-box.GetY(), -(box.GetY() + box.GetHeight())))
        layer = json.dumps(board.GetLayerName(item.GetLayer()), ensure_ascii=False)
        values = " ".join(format(value / 1000, ".3f") for value in (x1, y1, x2, y2))
        obstacles.append(f'\n    (keepout "DSH-text-{identifier}" (rect {layer} {values}))')
    offset = structure_offset(text)
    repaired = text[:offset] + "".join(obstacles) + text[offset:]
    parse(repaired)
    return repaired, len(obstacles)


def repair_dsn(request: dict) -> dict:
    _, live, _ = connect(request)
    directory = Path(request["directory"])
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(
        not manifest.get("repairAttempted"),
        "REPAIR_ALREADY_ATTEMPTED",
        "本次任务已自动重新布线一次",
    )
    require(
        fingerprint(live)[3] == manifest["fingerprint"], "BOARD_CHANGED", "板子已改变，请重新布线"
    )
    board = pcbnew.LoadBoard(str(directory / "board.kicad_pcb"))
    path = directory / "board.dsn"
    text, count = add_text_obstacles(
        path.read_text(encoding="utf-8"), board, request.get("avoidObjectIds")
    )
    verify_dsn(text, fingerprint(live)[2]["routing"], len(list(board.GetTracks())))
    require(
        fingerprint(live)[3] == manifest["fingerprint"], "BOARD_CHANGED", "自动处理期间板子发生变化"
    )
    path.write_text(text, encoding="utf-8")
    manifest["repairAttempted"] = True
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return {"obstacles": count}
