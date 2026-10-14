"""Visible, temporary copper owned by one routing run. Never touch original items.

KiCad 10 only displays pushed commits. Preview updates therefore have undo history.
Clear previews before the final import so one undo of that import restores the board.
"""

import hashlib
import json
from collections import Counter
from pathlib import Path

import pcbnew
from ipc_context import connect, fingerprint
from ipc_display import refresh_editor
from ipc_import import candidate, ipc_geometry, without_created
from kipy.board_types import BoardLayer, Track, Via
from specctra import Rejected, parse, require


def state_path(request):
    return Path(request["directory"]) / "preview-items.json"


def read_state(request):
    path = state_path(request)
    return (
        json.loads(path.read_text(encoding="utf8"))
        if path.exists()
        else {"ids": [], "geometry": []}
    )


def write_state(request, state):
    path = state_path(request)
    pending = path.with_suffix(".next")
    pending.write_text(json.dumps(state), encoding="utf8")
    pending.replace(path)


def geometry_key(item, layers):
    return json.dumps(ipc_geometry(item, layers))


def owned_items(board, state, layers):
    ids = set(state["ids"])
    items = [item for item in [*board.get_tracks(), *board.get_vias()] if item.id.value in ids]
    require(
        len(items) == len(ids)
        and Counter(geometry_key(item, layers) for item in items) == Counter(state["geometry"]),
        "BOARD_CHANGED",
        "本轮预览走线被修改，请检查板子后再继续",
    )
    return items


def verify_original(request, board, state, layers):
    current = fingerprint(board)
    original = (Path(request["directory"]) / "board.kicad_pcb").read_text(encoding="utf8")
    manifest = json.loads((Path(request["directory"]) / "manifest.json").read_text(encoding="utf8"))
    owned_items(board, state, layers)
    require(
        without_created(current[0], set(state["ids"])) == parse(original),
        "BOARD_CHANGED",
        "板子已改变，已停止布线，请重新布线",
    )
    digest = hashlib.sha256(original.encode())
    for key, data in sorted(current[1].items()):
        digest.update(key.encode())
        digest.update(data)
    digest.update(json.dumps(current[2], sort_keys=True).encode())
    require(
        digest.hexdigest() == manifest["fingerprint"],
        "BOARD_CHANGED",
        "板子工程规则已改变，请重新布线",
    )


def replace_preview(request, board, items, layers, state):
    """Replace only owned copper; verify staged deletion, creation and live geometry."""
    baseline = fingerprint(board)
    old_items = owned_items(board, state, layers)
    if not old_items and not items:
        return {"outcome": "unchanged", "tracks": 0, "vias": 0}
    commit, pushing = None, False
    try:
        commit = board.begin_commit()
        require(fingerprint(board)[3] == baseline[3], "BOARD_CHANGED", "更新预览前板子发生变化")
        for start in range(0, len(old_items), 256):
            board.remove_items(old_items[start : start + 256])
        created = []
        for start in range(0, len(items), 256):
            batch = items[start : start + 256]
            actual = board.create_items(batch)
            require(
                len(actual) == len(batch)
                and Counter(geometry_key(i, layers) for i in actual)
                == Counter(geometry_key(i, layers) for i in batch),
                "CREATE_VERIFICATION",
                "预览走线创建数量或位置不一致",
            )
            created.extend(actual)
        ids = {item.id.value for item in created}
        require(len(ids) == len(items), "CREATE_VERIFICATION", "预览走线创建标识不一致")
        # Deletions are staged too on the exercised KiCad 10: the visible board
        # must still exactly match the pre-update snapshot before pushing.
        require(fingerprint(board)[3] == baseline[3], "BOARD_CHANGED", "更新预览期间板子发生变化")
        next_state = {
            "ids": sorted(ids),
            "geometry": [geometry_key(item, layers) for item in created],
        }
        write_state(request, next_state)
        pushing = True
        board.push_commit(
            commit,
            "DSH FreeRouting: temporary routing preview"
            if items
            else "DSH FreeRouting: clear temporary routing preview",
        )
        current = fingerprint(board)
        require(
            without_created(current[0], ids) == without_created(baseline[0], set(state["ids"]))
            and current[1:3] == baseline[1:3],
            "IMPORT_UNCERTAIN",
            "预览更新状态待确认，请检查板子",
        )
        owned_items(board, next_state, layers)
        actual_ids = {item.id.value for item in [*board.get_tracks(), *board.get_vias()]}
        require(
            not (actual_ids & set(state["ids"])),
            "IMPORT_UNCERTAIN",
            "旧预览未能完整清理，请检查板子",
        )
        return {
            "outcome": "committed",
            "tracks": sum(isinstance(i, Track) for i in items),
            "vias": sum(isinstance(i, Via) for i in items),
        }
    except Exception as cause:
        if commit is None or pushing:
            raise Rejected("IMPORT_UNCERTAIN", "预览更新状态待确认，请检查板子后再继续") from cause
        try:
            board.drop_commit(commit)
            require(
                fingerprint(board)[3] == baseline[3], "IMPORT_UNCERTAIN", "预览回滚后板子内容不一致"
            )
            write_state(request, state)
        except Exception as rollback:
            raise Rejected("IMPORT_UNCERTAIN", "无法确认预览回滚，请检查板子后再继续") from rollback
        if isinstance(cause, Rejected):
            cause.outcome = "rolled_back"
            raise cause
        failure = Rejected("CREATE_FAILED", "预览更新失败，本次更新已撤销")
        failure.outcome = "rolled_back"
        raise failure from cause


def preview_session(request: dict) -> dict:
    api, board, _ = connect(request)
    state = read_state(request)
    # candidate verifies original copper, placement and network/layer/coordinate
    # mapping. Only preview skips offline DRC; the final review stays mandatory.
    items, layers, _ = candidate(request, board, check_design=False, session_filename="preview.ses")
    verify_original(request, board, state, layers)
    result = replace_preview(request, board, items, layers, state)
    return {**result, **refresh_editor(api)}


def clear_preview(request: dict) -> dict:
    api, board, _ = connect(request)
    state = read_state(request)
    if not state["ids"]:
        return {"cleared": True}
    # Cleanup may follow a user edit. Preserve all other edits; only remove our
    # known objects if their exact geometry still matches the recorded preview.
    native = pcbnew.LoadBoard(str(Path(request["directory"]) / "board.kicad_pcb"))
    layers = {
        BoardLayer.Value("BL_" + pcbnew.LSET.Name(i).replace(".", "_")): native.GetLayerName(i)
        for i in native.GetEnabledLayers().CuStack()
    }
    replace_preview(request, board, [], layers, state)
    return {"cleared": True, **refresh_editor(api)}
