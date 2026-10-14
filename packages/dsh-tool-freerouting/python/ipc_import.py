"""Import only verified new copper; all live changes belong to one undo transaction."""

import json
import time
from collections import Counter
from pathlib import Path

import pcbnew
from design_checks import validate_new_copper
from ipc_context import connect, fingerprint
from ipc_display import refresh_editor
from kipy.board_types import BoardLayer, Track, Via, ZoneType
from kipy.client import ApiError
from kipy.geometry import Vector2
from kipy.proto.common import ApiStatusCode
from specctra import Rejected, children, parse, require, without_original_ses


def native_geometry(item, board):
    net = item.GetNetname()
    if isinstance(item, pcbnew.PCB_VIA):
        p = item.GetPosition()
        require(item.GetViaType() == pcbnew.VIATYPE_THROUGH, "VIA_UNSUPPORTED", "仅支持通孔")
        return ("via", net, p.x, p.y, item.GetWidth(pcbnew.F_Cu), item.GetDrillValue())
    require(type(item) is pcbnew.PCB_TRACK, "TRACK_UNSUPPORTED", "仅支持直线走线")
    a, b = item.GetStart(), item.GetEnd()
    return (
        "track",
        net,
        board.GetLayerName(item.GetLayer()),
        item.GetWidth(),
        *sorted(((a.x, a.y), (b.x, b.y))),
    )


def ipc_geometry(item, layer_names):
    if isinstance(item, Via):
        return (
            "via",
            item.net.name,
            item.position.x,
            item.position.y,
            item.diameter,
            item.drill_diameter,
        )
    require(type(item) is Track, "TRACK_UNSUPPORTED", "仅支持直线走线")
    return (
        "track",
        item.net.name,
        layer_names[item.layer],
        item.width,
        *sorted(((item.start.x, item.start.y), (item.end.x, item.end.y))),
    )


def overlap(a: tuple, b: tuple) -> bool:
    if a[0] == b[0] == "via":
        return a[2:4] == b[2:4]
    if a[0] != "track" or b[0] != "track" or a[2] != b[2]:
        return False
    p, q, r, s = a[4], a[5], b[4], b[5]

    def cross(x, y, z):
        return (y[0] - x[0]) * (z[1] - x[1]) - (y[1] - x[1]) * (z[0] - x[0])

    if cross(p, q, r) or cross(p, q, s):
        return False
    axis = 0 if p[0] != q[0] else 1
    return max(min(p[axis], q[axis]), min(r[axis], s[axis])) < min(
        max(p[axis], q[axis]), max(r[axis], s[axis])
    )


def candidate(request, live, check_design=True, session_filename="board.ses"):
    directory = Path(request["directory"])
    board = pcbnew.LoadBoard(str(directory / "board.kicad_pcb"))

    def placement():
        return sorted(
            (
                fp.GetReference(),
                fp.GetPosition().x,
                fp.GetPosition().y,
                fp.GetOrientationDegrees(),
                fp.GetLayer(),
            )
            for fp in board.GetFootprints()
        )

    original_placement = placement()
    originals = [native_geometry(item, board) for item in board.GetTracks()]
    original_ids = {item.m_Uuid.AsString() for item in board.GetTracks()}
    layer_names = {board.GetLayerName(i) for i in board.GetEnabledLayers().CuStack()}
    nets = {net.name: net for net in live.get_nets()}
    sanitized, expected = without_original_ses(
        (directory / session_filename).read_text(encoding="utf-8"),
        originals,
        layer_names,
        set(nets),
    )
    native_session = directory / "board-new.ses"
    native_session.write_text(sanitized, encoding="utf-8")
    # KiCad exports locked original copper as DSN `fix`; the exercised JAR omits
    # system-fixed objects from SES. Exact originals are filtered if returned;
    # partial overlap is rejected rather than deleting or modifying original copper.
    for item in board.GetTracks():
        item.SetLocked(True)
    require(
        pcbnew.ImportSpecctraSES(board, str(native_session)),
        "SES_IMPORT_FAILED",
        "原生 SES 解析失败",
    )
    require(
        placement() == original_placement,
        "PLACEMENT_CHANGED",
        "SES 改变了封装位置、旋转或铜层，拒绝回导",
    )
    imported = list(board.GetTracks())
    require(
        Counter(native_geometry(item, board) for item in imported)
        == Counter(expected) + Counter(originals),
        "SES_MAPPING",
        "SES 与原生导入结果的数量、网络、层、坐标或尺寸不一致",
    )
    layers = {
        board.GetLayerName(i): BoardLayer.Value("BL_" + pcbnew.LSET.Name(i).replace(".", "_"))
        for i in board.GetEnabledLayers().CuStack()
    }
    selected = set(request["nets"])
    result = []
    for item in imported:
        geometry = native_geometry(item, board)
        if geometry in originals:
            continue
        require(geometry[1] in selected, "NET_SCOPE", "SES 新增铜超出指定布线网络")
        require(
            not any(overlap(geometry, old) for old in originals),
            "ORIGINAL_COPPER_OVERLAP",
            "SES 与原铜部分重叠，无法可靠区分；已拒绝回导",
        )
        if isinstance(item, pcbnew.PCB_VIA):
            created = Via()
            created.position = Vector2.from_xy(item.GetPosition().x, item.GetPosition().y)
            created.diameter = item.GetWidth(pcbnew.F_Cu)
            created.drill_diameter = item.GetDrillValue()
        else:
            created = Track()
            created.start = Vector2.from_xy(item.GetStart().x, item.GetStart().y)
            created.end = Vector2.from_xy(item.GetEnd().x, item.GetEnd().y)
            created.width = item.GetWidth()
            created.layer = layers[board.GetLayerName(item.GetLayer())]
        created.net = nets[geometry[1]]
        result.append(created)
    report = validate_new_copper(board, original_ids, directory) if check_design else None
    return result, {value: key for key, value in layers.items()}, report


def without_created(text, ids):
    root = parse(text)
    remaining = []
    removed = 0
    for item in root:
        if isinstance(item, list) and item and item[0] in ("segment", "via"):
            uuids = children(item, "uuid")
            if len(uuids) == 1 and uuids[0][1] in ids:
                removed += 1
                continue
        remaining.append(item)
    require(removed == len(ids), "CREATE_VERIFICATION", "快照中的实际新增对象数量不匹配")
    return remaining


def transaction(board, items, layer_names, expected_digest):
    baseline = fingerprint(board)
    require(baseline[3] == expected_digest, "BOARD_CHANGED", "板子或工程规则已改变，请重新布线")
    if not items:
        return {"outcome": "unchanged", "tracks": 0, "vias": 0}
    commit = None
    pushing = False
    try:
        commit = board.begin_commit()
        require(fingerprint(board)[3] == expected_digest, "BOARD_CHANGED", "开始回导时板子发生变化")
        created = []
        for start in range(0, len(items), 256):
            batch = items[start : start + 256]
            actual = board.create_items(batch)
            require(len(actual) == len(batch), "CREATE_VERIFICATION", "实际创建数量少于请求数量")
            require(
                Counter(ipc_geometry(i, layer_names) for i in actual)
                == Counter(ipc_geometry(i, layer_names) for i in batch),
                "CREATE_VERIFICATION",
                "创建响应的网络、层、坐标或尺寸不一致",
            )
            created.extend(actual)
        ids = {item.id.value for item in created}
        require(len(ids) == len(items), "CREATE_VERIFICATION", "创建响应含重复对象 ID")
        # KiCad 10 stages new objects outside the board until push_commit. The
        # create response verifies staged objects; the live snapshot must still
        # match the baseline immediately before committing.
        require(
            fingerprint(board)[3] == expected_digest, "BOARD_CHANGED", "回导期间板子或规则发生变化"
        )
        pushing = True
        board.push_commit(commit, "DSH FreeRouting: new tracks and vias")
        current = fingerprint(board)
        require(
            without_created(current[0], ids) == parse(baseline[0])
            and current[1:3] == baseline[1:3],
            "IMPORT_UNCERTAIN",
            "提交后板子或规则与预期不一致",
        )
        actual = list(board.get_tracks()) + list(board.get_vias())
        actual = [item for item in actual if item.id.value in ids]
        require(
            len(actual) == len(items)
            and Counter(ipc_geometry(i, layer_names) for i in actual)
            == Counter(ipc_geometry(i, layer_names) for i in items),
            "IMPORT_UNCERTAIN",
            "提交后实际新增对象与请求不一致",
        )
        return {
            "outcome": "committed",
            "tracks": sum(isinstance(i, Track) for i in items),
            "vias": sum(isinstance(i, Via) for i in items),
        }
    except Exception as cause:
        if commit is None:
            # begin_commit may have reached KiCad even when its response was lost.
            raise Rejected("IMPORT_UNCERTAIN", "回导状态待确认：无法确认事务是否已开启") from cause
        if pushing:
            raise Rejected("IMPORT_UNCERTAIN", "回导状态待确认：提交响应未能确认") from cause
        try:
            board.drop_commit(commit)
            require(
                fingerprint(board)[3] == expected_digest, "IMPORT_UNCERTAIN", "回滚后快照不一致"
            )
        except Exception as rollback:
            raise Rejected(
                "IMPORT_UNCERTAIN", "回导状态待确认：无法确认回滚，请检查板子"
            ) from rollback
        if isinstance(cause, Rejected):
            cause.outcome = "rolled_back"
            raise cause
        failure = Rejected("CREATE_FAILED", "创建失败，本轮改动已回滚")
        failure.outcome = "rolled_back"
        raise failure from cause


def reviewed_candidate(request):
    api, board, _ = connect(request)
    manifest = json.loads(
        (Path(request["directory"]) / "manifest.json").read_text(encoding="utf-8")
    )
    require(
        fingerprint(board)[3] == manifest["fingerprint"],
        "BOARD_CHANGED",
        "板子已改变，已保留 SES，请重新布线",
    )
    items, layers, report = candidate(request, board)
    return board, items, layers, report, manifest["fingerprint"], api


def review_session(request: dict) -> dict:
    _, _, _, report, _, _ = reviewed_candidate(request)
    return report


def import_session(request: dict) -> dict:
    import os

    from windows_api import close
    from windows_compute import owner_process, pin_owner

    if os.environ.get("DSH_COMPUTE_OWNER"):
        pin_owner()
    board, items, layers, report, digest, api = reviewed_candidate(request)
    # Only a successfully executed second routing attempt enables this policy.
    # Mapping, original-copper protection, snapshot and transaction checks stay strict.
    manifest = json.loads(
        (Path(request["directory"]) / "manifest.json").read_text(encoding="utf-8")
    )
    require(
        not report["count"]
        or (
            request.get("allowDesignViolations") is True and manifest.get("repairAttempted") is True
        ),
        "DESIGN_REPAIR_REQUIRED",
        "布线规则问题需要先自动处理并重新布线一次",
    )
    if os.environ.get("DSH_COMPUTE_OWNER"):
        # Before begin_commit only; a begun transaction is allowed to settle.
        close(owner_process(json.loads(os.environ["DSH_COMPUTE_OWNER"])))
    result = transaction(board, items, layers, digest)
    return {**result, "designReport": report, **refresh_editor(api)}


def fill(request: dict) -> dict:
    _, board, _ = connect(request)
    zones = [zone for zone in board.get_zones() if zone.type == ZoneType.ZT_COPPER]
    if not zones:
        return {"zonesFilled": 0, "skipped": True}
    # kipy 0.8.0's blocking refill loop does not increment its elapsed counter.
    # Use its nonblocking command and a bounded poll until the editor responds.
    board.refill_zones(block=False)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        time.sleep(0.25)
        try:
            actual = {zone.id.value: zone for zone in board.get_zones()}
            require(
                all(zone.id.value in actual and actual[zone.id.value].filled for zone in zones),
                "ZONE_FILL_FAILED",
                "已有 zone 未能全部确认填充，请手动检查",
            )
            return {"zonesFilled": len(zones), "skipped": False}
        except ApiError as cause:
            if cause.code != ApiStatusCode.AS_BUSY:
                raise
        except OSError:
            pass
    raise Rejected("ZONE_FILL_TIMEOUT", "铺铜未能在 90 秒内确认完成，请手动检查")
