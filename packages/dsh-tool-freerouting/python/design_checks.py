"""Verify additional KiCad design constraints on new copper before any IPC mutation."""

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import pcbnew
from specctra import Rejected, require
from windows_compute import run_checked


def object_labels(board):
    """Name real board objects, rather than translating KiCad diagnostic strings."""
    objects = list(board.GetTracks()) + list(board.GetDrawings())
    for footprint in board.GetFootprints():
        objects.extend(footprint.Pads())
    labels = {}
    for item in objects:
        if isinstance(item, pcbnew.PCB_TEXT):
            kind = "铜文字" if pcbnew.IsCopperLayer(item.GetLayer()) else "文字"
            label = kind + "「" + item.GetText() + "」"
        elif isinstance(item, pcbnew.PCB_VIA):
            label = "过孔（网络 " + item.GetNetnameMsg() + "）"
        elif isinstance(item, pcbnew.PCB_TRACK):
            label = "走线（网络 " + item.GetNetnameMsg() + "）"
        elif isinstance(item, pcbnew.PAD):
            label = "焊盘 " + item.GetParentFootprint().GetReference() + "-" + item.GetNumber()
        else:
            continue
        labels[item.m_Uuid.AsString()] = label[:1000]
    return labels


def validate_report(report, new_ids, labels=None):
    require(
        isinstance(report, dict) and isinstance(report.get("violations"), list),
        "DESIGN_CHECK_PROTOCOL",
        "原生 DRC 未提供可验证的设计规则结果",
    )
    relevant = []
    for violation in report["violations"]:
        require(
            isinstance(violation, dict) and isinstance(violation.get("items"), list),
            "DESIGN_CHECK_PROTOCOL",
            "原生 DRC 违规对象无法识别",
        )
        require(
            isinstance(violation.get("type"), str), "DESIGN_CHECK_PROTOCOL", "布线规则问题类型缺失"
        )
        ids = {item.get("uuid") for item in violation["items"] if isinstance(item, dict)}
        # Incomplete routing is reported separately, not an invalid transaction.
        # These connectivity diagnostics do not relax width, spacing, hole, edge,
        # annular-ring, layer or other physical design constraints.
        if violation.get("type") in ("track_dangling", "via_dangling"):
            continue
        if not ids & new_ids:
            continue
        items = []
        for item in violation["items"]:
            require(
                isinstance(item, dict) and isinstance(item.get("uuid"), str),
                "DESIGN_CHECK_PROTOCOL",
                "布线规则问题对象无法识别",
            )
            position = item.get("pos", {})
            require(
                isinstance(position, dict)
                and all(
                    isinstance(position.get(axis), (int, float))
                    and not isinstance(position.get(axis), bool)
                    and math.isfinite(position[axis])
                    for axis in ("x", "y")
                ),
                "DESIGN_CHECK_PROTOCOL",
                "布线规则问题位置无法识别",
            )
            items.append(
                {
                    "uuid": item["uuid"],
                    "description": str(item.get("description", ""))[:1000],
                    "x": position["x"],
                    "y": position["y"],
                    "label": (labels or {}).get(item["uuid"], "冲突对象"),
                }
            )
        relevant.append(
            {
                "type": violation["type"],
                "description": str(violation.get("description", ""))[:2000],
                "severity": str(violation.get("severity", "error")),
                "items": items,
            }
        )
    require(
        not relevant or report.get("coordinate_units") == "mm",
        "DESIGN_CHECK_PROTOCOL",
        "布线规则问题坐标单位无法识别",
    )
    return {"count": len(relevant), "violations": relevant[:100], "truncated": len(relevant) > 100}


def validate_new_copper(board, originals, directory):
    new_ids = {
        item.m_Uuid.AsString()
        for item in board.GetTracks()
        if item.m_Uuid.AsString() not in originals
    }
    if not new_ids:
        (directory / "design-check.json").unlink(missing_ok=True)
        return {"count": 0, "violations": [], "truncated": False}
    cli = Path(sys.executable).parent / "kicad-cli.exe"
    require(
        cli.is_file(), "DESIGN_CHECK_MISSING", "缺少所选 KiCad 的原生 DRC，无法验证工程设计规则"
    )
    path = directory / "design-check.kicad_pcb"
    require(
        pcbnew.SaveBoard(str(path), board), "DESIGN_CHECK_FAILED", "无法保存离线设计规则检查副本"
    )
    for extension in (".kicad_pro", ".kicad_dru"):
        source = directory / ("board" + extension)
        if source.is_file():
            shutil.copyfile(source, directory / ("design-check" + extension))
    report = directory / "design-check.json"
    try:
        run_checked(
            [
                str(cli),
                "pcb",
                "drc",
                "--format",
                "json",
                "--severity-all",
                "--output",
                str(report),
                str(path),
            ],
            timeout=90,
            directory=directory,
        )
    except subprocess.TimeoutExpired:
        raise Rejected("DESIGN_CHECK_TIMEOUT", "离线设计规则检查超时，已拒绝回导并保留 SES")
    except subprocess.CalledProcessError:
        raise Rejected("DESIGN_CHECK_FAILED", "原生设计规则检查失败，已拒绝回导并保留 SES")
    require(
        report.is_file() and report.stat().st_size <= 32 * 1024 * 1024,
        "DESIGN_CHECK_FAILED",
        "设计规则检查结果缺失或超过限制",
    )
    return validate_report(
        json.loads(report.read_text(encoding="utf-8")), new_ids, object_labels(board)
    )
