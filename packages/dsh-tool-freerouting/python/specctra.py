"""Bounded Specctra parsing and strict validation before the native SES importer."""

import re
from decimal import Decimal, InvalidOperation


class Rejected(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(condition, code, message):
    if not condition:
        raise Rejected(code, message)


def parse(text):
    require(len(text.encode("utf-8")) <= 32 * 1024 * 1024, "INPUT_LIMIT", "输入超过 32 MB")
    tokens = re.finditer(r'\s+|\(|\)|(?<=string_quote )"|"(?:\\.|[^"\\])*"|[^\s()"]+', text)
    root, stack, end = [], [], 0
    for match in tokens:
        require(not text[end : match.start()].strip(), "INVALID_SEXPR", "无效 s-expression")
        end = match.end()
        value = match.group()
        if value.isspace():
            continue
        if value == "(":
            node = []
            (stack[-1] if stack else root).append(node)
            stack.append(node)
            require(len(stack) <= 128, "INPUT_LIMIT", "s-expression 嵌套过深")
        elif value == ")":
            require(bool(stack), "INVALID_SEXPR", "括号不匹配")
            stack.pop()
        else:
            require(bool(stack), "INVALID_SEXPR", "根节点必须是列表")
            if value.startswith('"') and len(value) > 1:
                value = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            stack[-1].append(value)
    require(
        not stack and not text[end:].strip() and len(root) == 1,
        "INVALID_SEXPR",
        "不完整的 s-expression",
    )
    return root[0]


def children(node, name):
    return [value for value in node if isinstance(value, list) and value and value[0] == name]


def one(node, name):
    found = children(node, name)
    require(len(found) == 1, "UNSUPPORTED_SPECCTRA", "必须恰好存在一个 " + name)
    return found[0]


def nm(value, multiplier):
    try:
        result = Decimal(value) * multiplier
        require(
            result.is_finite() and result == result.to_integral_value() and abs(result) < 2**31,
            "INVALID_COORDINATE",
            "坐标或尺寸不能精确映射为 KiCad 纳米坐标",
        )
        return int(result)
    except InvalidOperation:
        raise Rejected("INVALID_COORDINATE", "无效坐标或尺寸")


def verify_dsn(text, rules, original_count):
    root = parse(text)
    unit = one(root, "unit")[1]
    require(unit == "um", "RULE_FIDELITY", "仅支持原生 um DSN")
    network = one(root, "network")
    exported = {}
    for node in children(network, "class"):
        rule = one(node, "rule")
        width = nm(one(rule, "width")[1], 1000)
        clearance = nm(one(rule, "clearance")[1], 1000)
        via = one(one(node, "circuit"), "use_via")[1]
        match = re.fullmatch(r"Via\[0-1\]_(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)_um", via)
        require(bool(match), "RULE_FIDELITY", "仅支持通孔默认 padstack")
        value = [width, clearance, nm(match[1], 1000), nm(match[2], 1000)]
        for net in node[2:]:
            if isinstance(net, str):
                exported[net] = value
    require(
        all(exported.get(net) == value for net, value in rules.items() if net),
        "RULE_FIDELITY",
        "DSN 与编辑器的有效网络类规则不一致",
    )
    wiring = one(root, "wiring")
    copper = children(wiring, "wire") + children(wiring, "via")
    require(
        len(copper) == original_count
        and all(one(c, "type")[1] in ("fix", "protect") for c in copper),
        "ORIGINAL_COPPER_UNPROTECTED",
        "DSN 未完整保护原有走线和过孔",
    )


def ses_geometry(text, layer_names, net_names, *, allow_duplicates=False):
    root = parse(text)
    require(root[0] == "session", "INVALID_SES", "不是 SES 会话")
    routes = one(root, "routes")
    resolution = one(routes, "resolution")
    require(len(resolution) == 3 and resolution[1] == "um", "UNSUPPORTED_SES", "仅支持 um SES")
    divisor = Decimal(resolution[2])
    require(divisor.is_finite() and divisor > 0, "INVALID_SES", "无效 SES 分辨率")
    scale = Decimal(1000) / divisor
    padstacks = {}
    for pad in children(one(routes, "library_out"), "padstack"):
        circles = [one(shape, "circle") for shape in children(pad, "shape")]
        require(
            len(circles) == len(layer_names) and {c[1] for c in circles} == set(layer_names),
            "UNSUPPORTED_VIA",
            "仅支持覆盖所有铜层的通孔",
        )
        sizes = {nm(c[2], scale) for c in circles}
        require(
            all(
                len(c) in (3, 5)
                and (len(c) == 3 or (nm(c[3], scale) == 0 and nm(c[4], scale) == 0))
                for c in circles
            ),
            "UNSUPPORTED_VIA",
            "不支持偏移或非标准通孔形状",
        )
        match = re.fullmatch(r"Via\[0-1\]_(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)_um", pad[1])
        require(len(sizes) == 1 and match is not None, "UNSUPPORTED_VIA", "无法可靠解析通孔尺寸")
        diameter, drill = nm(match[1], 1000), nm(match[2], 1000)
        require(
            sizes == {diameter} and 0 < drill < diameter,
            "UNSUPPORTED_VIA",
            "通孔尺寸与 padstack 不一致",
        )
        padstacks[pad[1]] = (diameter, drill)
    geometry = []
    for net in children(one(routes, "network_out"), "net"):
        require(net[1] in net_names, "NET_MAPPING", "SES 含未知网络")
        for item in net[2:]:
            require(
                isinstance(item, list) and item and item[0] in ("wire", "via"),
                "UNSUPPORTED_SES",
                "SES 含不支持的网络对象",
            )
            if item[0] == "wire":
                path = one(item, "path")
                require(
                    path[1] in layer_names and len(path) >= 7 and (len(path) - 3) % 2 == 0,
                    "LAYER_MAPPING",
                    "SES 层或路径无效",
                )
                width = nm(path[2], scale)
                require(width > 0, "INVALID_SES", "走线宽度必须大于零")
                points = [
                    (nm(path[i], scale), -nm(path[i + 1], scale)) for i in range(3, len(path), 2)
                ]
                for a, b in zip(points, points[1:]):
                    # Native KiCad retains a standalone point track's copper
                    # footprint. Keep its geometry; repeated points in a longer
                    # route remain unsupported (ADR 023).
                    require(a != b or len(points) == 2, "INVALID_SES", "SES 路径含重复端点")
                    geometry.append(("track", net[1], path[1], width, *sorted((a, b))))
            else:
                require(
                    len(item) >= 4 and item[1] in padstacks, "UNSUPPORTED_VIA", "SES 含未知通孔"
                )
                geometry.append(
                    ("via", net[1], nm(item[2], scale), -nm(item[3], scale), *padstacks[item[1]])
                )
    require(len(geometry) <= 100000, "INPUT_LIMIT", "SES 对象超过十万个")
    require(
        allow_duplicates or len(geometry) == len(set(geometry)),
        "DUPLICATE_COPPER",
        "SES 含重复铜对象",
    )
    return geometry


def copper_spans(text):
    """Keep untouched SES syntax, including native string_quote declarations."""
    stack, copper, resolution, library = [], [], "", ""
    pattern = r'\s+|\(|\)|(?<=string_quote )"|"(?:\\.|[^"\\])*"|[^\s()"]+'
    for match in re.finditer(pattern, text):
        token = match.group()
        if token.isspace():
            continue
        if token == "(":
            stack.append({"start": match.start(), "atoms": []})
        elif token == ")":
            frame = stack.pop()
            atoms = frame["atoms"]
            heads = [parent["atoms"][0] for parent in stack if parent["atoms"]]
            raw = text[frame["start"] : match.end()]
            if atoms and atoms[0] == "resolution" and heads and heads[-1] == "routes":
                resolution = raw
            elif atoms and atoms[0] == "library_out":
                library = raw
            elif (
                atoms
                and atoms[0] in ("wire", "via")
                and heads[-3:] == ["routes", "network_out", "net"]
            ):
                net = next(
                    parent["atoms"][1]
                    for parent in reversed(stack)
                    if parent["atoms"] and parent["atoms"][0] == "net"
                )
                copper.append((frame["start"], match.end(), net, raw))
        else:
            if token.startswith('"') and len(token) > 1:
                token = token[1:-1].replace('\\"', '"').replace("\\\\", "\\")
            stack[-1]["atoms"].append(token)
    return resolution, library, copper


def unique_wire_runs(raw, keep):
    """Split around removed segments; never join across a removed edge."""
    path = re.search(r'\(path\s+(?:"(?:\\.|[^"\\])*"|[^\s()]+)\s+[^\s()]+\s+[^()]*\)', raw)
    require(path is not None, "UNSUPPORTED_SES", "无法定位 SES 直线路径")
    atoms = re.findall(r'"(?:\\.|[^"\\])*"|[^\s()]+', path.group())
    points = [atoms[i : i + 2] for i in range(3, len(atoms), 2)]
    require(len(points) == len(keep) + 1, "SES_MAPPING", "路径线段数量不一致")
    runs, start = [], None
    for index, retained in enumerate([*keep, False]):
        if retained and start is None:
            start = index
        elif not retained and start is not None:
            coordinates = " ".join(value for point in points[start : index + 1] for value in point)
            replacement = f"(path {atoms[1]} {atoms[2]} {coordinates})"
            runs.append(raw[: path.start()] + replacement + raw[path.end() :])
            start = None
    return "\n".join(runs)


def without_original_ses(text, originals, layer_names, net_names):
    """Normalize exact duplicate copper, then remove complete original echoes.

    FreeRouting can emit the same branch edge twice (FR-IPC-SES-01). Only
    identical net/layer/width/endpoints or identical through-vias are collapsed.
    Partial overlap and mixed original/new paths remain unsupported. The raw SES
    stays downloadable; only the offline native import copy is rewritten.
    """
    expected = ses_geometry(text, layer_names, net_names, allow_duplicates=True)
    if not originals and len(expected) == len(set(expected)):
        return text, expected
    resolution, library, copper = copper_spans(text)
    original_set, seen, edits = set(originals), set(), []
    for start, end, net, raw in copper:
        quoted_net = '"' + net.replace("\\", "\\\\").replace('"', '\\"') + '"'
        single = f"(session probe (routes {resolution} {library} (network_out (net {quoted_net} {raw}))))"
        items = ses_geometry(single, layer_names, net_names, allow_duplicates=True)
        matches = [item in original_set for item in items]
        require(
            not any(matches) or all(matches),
            "ORIGINAL_COPPER_AMBIGUOUS",
            "同一路径混合原铜和新铜，无法可靠分离，拒绝回导",
        )
        keep = []
        for item in items:
            keep.append(item not in original_set and item not in seen)
            seen.add(item)
        if all(keep):
            continue
        replacement = unique_wire_runs(raw, keep) if parse(raw)[0] == "wire" else ""
        edits.append((start, end, replacement))
    chunks, cursor = [], 0
    for start, end, replacement in edits:
        chunks.extend((text[cursor:start], replacement))
        cursor = end
    chunks.append(text[cursor:])
    text = "".join(chunks)
    actual = ses_geometry(text, layer_names, net_names)
    require(
        set(actual) == set(expected) - original_set, "SES_MAPPING", "SES 规范化改变了唯一铜几何"
    )
    return text, actual
