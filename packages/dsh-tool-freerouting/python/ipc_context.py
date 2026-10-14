"""Snapshot the live editor and validate its effective rules against offline export."""

import hashlib
import json
import os
import re
from pathlib import Path

import pcbnew
from instance_identity import identity
from kipy import KiCad
from kipy.board_types import ArcTrack
from rule_state import (
    check_board_minimums,
    check_custom_rules,
    netclass_state,
    reject_auto_teardrops,
    reject_diff_pairs,
)
from specctra import require, verify_dsn


def connect(request: dict):
    instance = identity(request["socket"])
    if request.get("instance"):
        require(instance == request["instance"], "INSTANCE_CHANGED", "目标 KiCad 实例已退出或重启")
    api = KiCad(
        socket_path=request["socket"],
        client_name=request.get("clientName", "dsh-preflight"),
        kicad_token=request.get("token", ""),
        timeout_ms=10000,
    )
    version = api.get_version()
    require(
        version.major == 10 and version.minor == 0 and version.patch >= 6,
        "KICAD_VERSION_UNSUPPORTED",
        "当前 helper 要求 KiCad 10.0.6 或更新的 10.0 补丁版本",
    )
    binary = Path(api.get_kicad_binary_path("pcbnew")).resolve()
    require(
        binary.parent == Path(os.sys.executable).resolve().parent,
        "KICAD_PYTHON_MISMATCH",
        "Python 不属于所选 KiCad 实例",
    )
    board = api.get_board()
    path = Path(board.document.project.path) / board.name
    require(path.is_absolute() and path.is_file(), "BOARD_NOT_SAVED", "板子必须至少保存过一次")
    if request.get("boardPath"):
        require(
            os.path.normcase(str(path.resolve())) == os.path.normcase(request["boardPath"]),
            "BOARD_CHANGED",
            "目标实例当前板子已改变",
        )
    return api, board, str(path.resolve())


def discover(request: dict) -> dict:
    if request.get("socket"):
        candidates = [request["socket"]]
    else:
        candidates = [
            "ipc://" + p
            for p in os.listdir("\\\\.\\pipe\\")
            if "kicad" in p.lower() and re.search(r"api(?:-\d+)?\.sock$", p.lower())
        ]
    found = []
    for socket in sorted(set(candidates)):
        try:
            api = KiCad(socket_path=socket, kicad_token=request.get("token", ""), timeout_ms=2000)
            api.ping()
            found.append(socket)
        except Exception:
            pass
    require(
        len(found) <= 1,
        "INSTANCE_SELECTION_REQUIRED",
        "多个可连接 KiCad 实例；请明确配置 kicadApiSocket",
    )
    require(len(found) == 1, "KICAD_UNAVAILABLE", "未找到可连接的 KiCad 10 PCB；请开启 IPC API")
    api, _, path = connect({**request, "socket": found[0]})
    return {
        "socket": found[0],
        "boardPath": path,
        "version": api.get_version().full_version,
        "instance": identity(found[0]),
    }


def rule_files(board):
    project = board.document.project
    base = Path(project.path) / project.name
    result = {}
    for extension in (".kicad_pro", ".kicad_dru"):
        path = Path(str(base) + extension)
        result[extension] = path.read_bytes() if path.is_file() else b""
    require(
        bool(result[".kicad_pro"]),
        "PROJECT_RULES_MISSING",
        "缺少工程规则文件，不能保证 DSN 规则保真",
    )
    check_custom_rules(result[".kicad_dru"])
    return result


def effective_rules(board):
    return netclass_state(board)["routing"]


def fingerprint(board):
    text = board.get_as_string()
    require(
        text == board.get_as_string(), "UNSTABLE_SNAPSHOT", "板子快照序列化不稳定或编辑器正在改变"
    )
    files = rule_files(board)
    rules = netclass_state(board)
    h = hashlib.sha256(text.encode())
    for key, data in sorted(files.items()):
        h.update(key.encode())
        h.update(data)
    h.update(json.dumps(rules, sort_keys=True).encode())
    return text, files, rules, h.hexdigest()


def export(request: dict) -> dict:
    require(
        (Path(os.sys.executable).parent / "kicad-cli.exe").is_file(),
        "DESIGN_CHECK_MISSING",
        "缺少所选 KiCad 的原生 DRC，无法验证工程设计规则",
    )
    _, live, path = connect(request)
    require(
        not any(isinstance(t, ArcTrack) for t in live.get_tracks()),
        "ARC_UNSUPPORTED",
        "首期不支持原有圆弧走线",
    )
    text, files, state, digest = fingerprint(live)
    reject_auto_teardrops(text, files[".kicad_pro"])
    rules = state["routing"]
    reject_diff_pairs(rules)
    directory = Path(request["directory"])
    board_path = directory / "board.kicad_pcb"
    board_path.write_text(text, encoding="utf-8")
    for extension, data in files.items():
        if data:
            (directory / ("board" + extension)).write_bytes(data)
    native = pcbnew.LoadBoard(str(board_path))
    require(native is not None, "BOARD_LOAD_FAILED", "原生 KiCad 无法加载 IPC 快照")
    for name, expected in rules.items():
        c = native.GetDesignSettings().m_NetSettings.GetEffectiveNetClass(name)
        require(
            [c.GetTrackWidth(), c.GetClearance(), c.GetViaDiameter(), c.GetViaDrill()] == expected,
            "RULE_FIDELITY",
            "磁盘工程规则与当前编辑器网络类不一致，请先保存工程设置",
        )
    warnings = check_board_minimums(native.GetDesignSettings(), rules)
    originals = list(native.GetTracks())
    require(
        all(
            not isinstance(t, pcbnew.PCB_VIA) or t.GetViaType() == pcbnew.VIATYPE_THROUGH
            for t in originals
        ),
        "VIA_UNSUPPORTED",
        "首期仅支持原有通孔",
    )
    for item in originals:
        item.SetLocked(True)
    require(
        pcbnew.ExportSpecctraDSN(native, str(directory / "board.dsn")),
        "DSN_EXPORT_FAILED",
        "原生 DSN 导出失败",
    )
    verify_dsn((directory / "board.dsn").read_text(encoding="utf-8"), rules, len(originals))
    require(fingerprint(live)[3] == digest, "BOARD_CHANGED", "导出期间板子内容发生变化")
    (directory / "manifest.json").write_text(
        json.dumps({"fingerprint": digest, "boardPath": path}), encoding="utf-8"
    )
    return {"exported": True, "warnings": warnings}
