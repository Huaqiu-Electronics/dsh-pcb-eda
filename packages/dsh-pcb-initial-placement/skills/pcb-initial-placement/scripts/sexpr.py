"""Minimal s-expression reader for KiCad files, offset aware.

Only what the placement task needs:
  * parse the file into nested lists of strings (SNode)
  * locate every top-level `(footprint ...)` block and the byte span of its
    depth-1 `(at x y [rot])` token, so positions can be rewritten textually
    while every other byte of the file stays untouched.
"""
from __future__ import annotations

import re

TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|\(|\)|[^\s()"]+')


class SNode:
    __slots__ = ("items", "start", "end")

    def __init__(self, items, start=None, end=None):
        self.items = items
        self.start = start
        self.end = end

    @property
    def head(self):
        return self.items[0] if self.items and isinstance(self.items[0], str) else None

    def kids(self, head=None):
        for it in self.items:
            if isinstance(it, SNode) and (head is None or it.head == head):
                yield it

    def first(self, head):
        for it in self.items:
            if isinstance(it, SNode) and it.head == head:
                return it
        return None

    def atoms(self):
        return [it for it in self.items if isinstance(it, str)]

    def nums(self):
        out = []
        for it in self.items[1:]:
            if isinstance(it, str):
                try:
                    out.append(float(it))
                except ValueError:
                    break
            else:
                break
        return out

    def __repr__(self):
        return f"<{self.head} {self.atoms()[1:3]}>"


def parse(text: str) -> list[SNode]:
    """Parse text into a list of top-level SNode."""
    stack: list[list] = [[]]
    starts: list[int] = [0]
    for m in TOKEN.finditer(text):
        tok = m.group(0)
        if tok == "(":
            stack.append([])
            starts.append(m.start())
        elif tok == ")":
            items = stack.pop()
            st = starts.pop()
            stack[-1].append(SNode(items, st, m.end()))
        else:
            stack[-1].append(tok)
    return [it for it in stack[0] if isinstance(it, SNode)]


def root(text: str) -> SNode:
    tops = parse(text)
    for n in tops:
        if n.head == "kicad_pcb":
            return n
    raise ValueError("no (kicad_pcb ...) root found")


def footprints(text: str) -> list[SNode]:
    """All `(footprint ...)` blocks of the board, with offsets."""
    return list(root(text).kids("footprint"))


def edge_cuts(text: str) -> list[SNode]:
    out = []
    for kind in ("gr_line", "gr_rect", "gr_arc", "gr_circle", "gr_poly", "gr_curve"):
        for g in root(text).kids(kind):
            lay = g.first("layer")
            if lay and len(lay.atoms()) > 1 and lay.atoms()[1].strip('"') == "Edge.Cuts":
                out.append(g)
    return out


def net_name(pad: SNode) -> str:
    """Net name of a ``(pad ...)``, tolerating both board dialects.

    KiCad normally writes ``(net 12 "GND")`` - a numeric code followed by the name - but
    boards that went through an importer, or that were written by an older/other tool,
    carry the bare name only: ``(net "GND")``.  Reading position 2 unconditionally
    yields ``""`` for every pad on such a board, which silently turns a 111-net design
    into a 0-net design and makes every connectivity-based grouping step meaningless.
    So: take the first non-numeric atom, and treat a net with no name as unnamed.
    """
    net = pad.first("net")
    if net is None:
        return ""
    atoms = net.atoms()
    if len(atoms) >= 3 and atoms[1].isdigit():
        return atoms[2].strip('"')
    for a in atoms[1:]:
        s = a.strip('"')
        if not s.isdigit():
            return s
    return ""


def property_value(fp: SNode, name: str):
    """KiCad 8/9 store reference/value as (property "Reference" "R1" ...)."""
    for p in fp.kids("property"):
        a = p.atoms()
        if len(a) >= 3 and a[1] == f'"{name}"':
            return a[2].strip('"')
    for t in fp.kids("fp_text"):
        a = t.atoms()
        if len(a) >= 3 and a[1] == name:
            return a[2].strip('"')
    return None


def local_bbox(fp: SNode):
    """Occupied area of one footprint in its own frame (before rotation)."""
    xs, ys = [], []
    for pad in fp.kids("pad"):
        at = pad.first("at")
        if at is None:
            continue
        n = at.nums()
        if len(n) < 2:
            continue
        w = h = 0.0
        for key, dst in (("size", "wh"), ("drill", None)):
            pass
        size = pad.first("size")
        if size is not None:
            sn = size.nums()
            if len(sn) >= 2:
                w, h = sn[0], sn[1]
        xs += [n[0] - w / 2, n[0] + w / 2]
        ys += [n[1] - h / 2, n[1] + h / 2]
    for kind in ("fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"):
        for g in fp.kids(kind):
            layer = g.first("layer")
            lname = layer.atoms()[1].strip('"') if layer and len(layer.atoms()) > 1 else ""
            if not (lname.endswith("CrtYd") or lname.endswith("Fab")):
                continue
            for key in ("start", "end", "center", "mid"):
                for s in g.kids(key):
                    n = s.nums()
                    if len(n) >= 2:
                        xs.append(n[0])
                        ys.append(n[1])
            for s in g.kids("xy"):
                n = s.nums()
                if len(n) >= 2:
                    xs.append(n[0])
                    ys.append(n[1])
            for s in g.kids("pts"):
                for xy in s.kids("xy"):
                    n = xy.nums()
                    if len(n) >= 2:
                        xs.append(n[0])
                        ys.append(n[1])
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)
