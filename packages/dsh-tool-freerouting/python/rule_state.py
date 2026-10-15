"""Capture complete IPC netclass state and reject constraints DSN cannot express."""

import json
import re

from specctra import parse, require


def check_custom_rules(data):
    text = data.decode("utf-8-sig")
    # KiCad .dru comments use #. Preserve quoted strings before stripping comments.
    text = re.sub(
        r'"(?:\\.|[^"\\])*"|#[^\r\n]*',
        lambda m: m.group() if m.group().startswith('"') else "",
        text,
    )
    nodes = parse("(" + text + ")")
    require(
        all(isinstance(node, list) and node and node[0] == "version" for node in nodes),
        "CUSTOM_RULES_UNSUPPORTED",
        "首期不支持自定义 .kicad_dru 规则",
    )


def reject_diff_pairs(names):
    """Stop ordinary routing for recognized or suspected differential pairs.

    Naming is a capability guard, not proof of circuit purpose. USB aliases
    with a branch suffix are not recognized by KiCad's native suffix matcher.
    EDAOL-1465 tracks explicit pair constraints and a verified external solver.
    """
    names = set(names)
    complements = {"P": "N", "N": "P", "+": "-", "-": "+"}
    usb_complements = {"P": ("M", "N"), "PLUS": ("MINUS",), "+": ("-",)}
    for name in sorted(names):
        others = []
        # Keep KiCad 10 BOARD::MatchDpSuffix behavior, including indexed pairs.
        match = re.fullmatch(r"(.*)([PN+-])([0-9_]*)", name)
        if match:
            others.append(match[1] + complements[match[2]] + match[3])
        usb = re.fullmatch(
            r"((?:.*[/_-])?USB[0-9]*[_-]D)(PLUS|P|\+)((?:_[A-Za-z0-9_]+|[0-9_]*)?)",
            name,
            re.IGNORECASE,
        )
        if usb:
            for polarity in usb_complements[usb[2].upper()]:
                if usb[2].islower():
                    polarity = polarity.lower()
                others.append(usb[1] + polarity + usb[3])
        for other in others:
            require(
                other not in names,
                "DIFF_PAIR_UNSUPPORTED",
                "板子包含差分信号 "
                + name
                + " / "
                + other
                + "；当前布线引擎不能保证两根线成对布线，已停止本次布线，尚未添加新走线。",
            )


def reject_auto_teardrops(text, project_data):
    # KiCad regenerates teardrop zones when committing tracks. Those zones
    # cannot be owned/rolled back as tracks; never ignore them in fingerprints.
    # Pad/via enablement is in the current editor snapshot. Project options for
    # pad/via shapes are defaults, not enablement (and are true on plain boards).
    def enabled(node):
        if not isinstance(node, list):
            return False
        if node and node[0] == "teardrops" and ["enabled", "yes"] in node:
            return True
        return any(enabled(child) for child in node if isinstance(child, list))

    require(
        not enabled(parse(text)),
        "AUTO_TEARDROPS_UNSUPPORTED",
        "板子开启了自动泪滴补铜，当前自动布线暂不支持；尚未添加新走线。",
    )
    try:
        project = json.loads(project_data.decode("utf-8-sig"))
        options = project["board"]["design_settings"]["teardrop_options"]
        valid = (
            isinstance(options, list)
            and len(options) == 1
            and isinstance(options[0], dict)
            and type(options[0].get("td_ontrackend")) is bool
        )
    except (ValueError, KeyError, TypeError):
        valid = False
    require(
        valid,
        "PROJECT_RULES_UNVERIFIABLE",
        "无法确认工程的泪滴补铜设置，尚未添加新走线；请检查工程设置后再试。",
    )
    require(
        not options[0]["td_ontrackend"],
        "AUTO_TEARDROPS_UNSUPPORTED",
        "工程选择了走线间泪滴补铜，当前自动布线暂不支持；尚未添加新走线。",
    )


def check_board_minimums(settings, rules):
    # First-release policy: diagnose contradictory preferences without rewriting
    # the project or blocking routing. Final native DRC still reports actual
    # violations through the existing one-repair/partial-result workflow.
    minimums = [
        settings.m_TrackMinWidth,
        settings.m_MinClearance,
        settings.m_ViasMinSize,
        settings.m_MinThroughDrill,
    ]
    require(
        all(type(v) is int and v >= 0 for v in minimums)
        and type(settings.m_ViasMinAnnularWidth) is int
        and settings.m_ViasMinAnnularWidth >= 0,
        "PROJECT_RULES_UNVERIFIABLE",
        "无法核对电路板的最小线宽、间距和过孔尺寸。",
    )
    warnings = []
    labels = ("线宽", "间距", "过孔直径", "过孔孔径")
    for name, values in rules.items():
        if not name:
            continue
        for label, actual, minimum in zip(labels, values, minimums):
            if actual < minimum:
                warnings.append(
                    f"网络 {name} 的{label}为 {actual / 1e6:g} mm，小于电路板要求的 {minimum / 1e6:g} mm；按当前网络设置继续布线，最终检查会报告实际问题。"
                )
        annulus = (values[2] - values[3]) / 2
        if annulus < settings.m_ViasMinAnnularWidth:
            warnings.append(
                f"网络 {name} 的过孔铜环为 {annulus / 1e6:g} mm，小于电路板要求的 {settings.m_ViasMinAnnularWidth / 1e6:g} mm；按当前网络设置继续布线，最终检查会报告实际问题。"
            )
    return warnings


def netclass_state(board):
    classes = board.get_netclass_for_nets(board.get_nets())
    routing = {}
    for net, rule in classes.items():
        p = rule.proto.board
        require(
            p.HasField("track_width")
            and p.HasField("clearance")
            and p.HasField("via_stack")
            and len(p.via_stack.copper_layers) == 1,
            "RULE_FIDELITY",
            "有效网络类缺少走线或通孔规则",
        )
        routing[net] = [
            p.track_width.value_nm,
            p.clearance.value_nm,
            p.via_stack.copper_layers[0].size.x_nm,
            p.via_stack.drill.diameter.x_nm,
        ]
    return {
        "routing": routing,
        "effective": {
            name: rule.proto.SerializeToString(deterministic=True).hex()
            for name, rule in classes.items()
        },
        "project": sorted(
            rule.proto.SerializeToString(deterministic=True).hex()
            for rule in board.get_project().get_net_classes()
        ),
    }
