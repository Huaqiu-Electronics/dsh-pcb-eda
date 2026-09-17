// ---------------------------------------------------------------------------
// parseKicad.ts — parse a .kicad_pcb file (KiCad 7/8/9/10) into the board model
// the renderer consumes. Self-contained: no dependencies, works in browser and
// Node.
//
//   const board = parseKicad(fileText)  →  BoardModel
//
// Why this parser is the default engine: it stays linear as board size grows.
// The upstream path (./adapter.ts) scales worse on multi-megabyte boards, so it
// is kept as an alternative rather than the default. Both produce the same
// BoardModel and test/parity.test.ts keeps them in lockstep, which makes
// re-evaluating the choice a one-line edit in ./parse.ts.
// ---------------------------------------------------------------------------
import type { BoardModel, BoardComp, BoardPad, BoardTrace, BoardZone, BoardVia, OutlineSeg, BoardText } from '../model.js'

type Sexp = string | Sexp[]

// ---------- S-expression tokenizer + parser ----------
function tokenize(src: string): string[] {
  const toks: string[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === ';') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '(' || c === ')') { toks.push(c); i++; continue }
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          // KiCad escapes: \n \t \" \\ — decode them like the upstream parser does
          // (the old literal-copy behaviour turned "\n" into "n").
          const e = src[j + 1]
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : (e ?? '')
          j += 2
          continue
        }
        s += src[j]!
        j++
      }
      toks.push('"' + s); i = j + 1; continue
    }
    // bare atom
    let j = i
    while (j < n && !' \t\n\r()'.includes(src[j]!)) j++
    toks.push(src.slice(i, j)); i = j
  }
  return toks
}

function parseSexp(toks: string[]): Sexp {
  let pos = 0
  function parse(): Sexp {
    if (toks[pos] === '(') {
      pos++
      const list: Sexp[] = []
      while (pos < toks.length && toks[pos] !== ')') list.push(parse())
      pos++ // consume ')'
      return list
    }
    return toks[pos++] ?? ''
  }
  const roots: Sexp[] = []
  while (pos < toks.length) roots.push(parse())
  return roots[0] ?? []
}

// ---------- helpers ----------
const num = (v: Sexp | undefined): number => (typeof v === 'string' ? parseFloat(v) : NaN)
const atom = (v: Sexp | undefined): string => (typeof v === 'string' ? v.replace(/^"/, '') : '')
/** find first child list whose head matches */
function child(list: Sexp[], head: string): Sexp[] | null {
  for (const c of list) if (Array.isArray(c) && c[0] === head) return c
  return null
}
function children(list: Sexp[], head: string): Sexp[][] {
  const out: Sexp[][] = []
  for (const c of list) if (Array.isArray(c) && c[0] === head) out.push(c)
  return out
}
/** (at x y [rot]) → {x,y,rot} */
function parseAt(node: Sexp[] | null): { x: number; y: number; rot: number } {
  if (!node) return { x: 0, y: 0, rot: 0 }
  return { x: num(node[1]), y: num(node[2]), rot: node[3] !== undefined ? num(node[3]) : 0 }
}
const rad = (d: number) => (d * Math.PI) / 180
/** rotate local point by deg then translate */
function xform(lx: number, ly: number, fp: { x: number; y: number; rot: number }): [number, number] {
  const r = rad(fp.rot), cs = Math.cos(r), sn = Math.sin(r)
  return [fp.x + lx * cs - ly * sn, fp.y + lx * sn + ly * cs]
}

// ---------- main ----------
export function parseKicad(src: string): BoardModel {
  const root = parseSexp(tokenize(src))
  if (!Array.isArray(root)) throw new Error('not a valid .kicad_pcb')

  // --- net id → name map (top-level (net id "name")) ---
  const netName = new Map<number, string>()
  for (const n of children(root, 'net')) netName.set(num(n[1]), atom(n[2]))

  // --- copper layer order ---
  let cuLayers: string[] = []
  const layersNode = child(root, 'layers')
  if (layersNode) {
    for (const L of layersNode.slice(1)) {
      const nm = Array.isArray(L) ? atom(L[1]) : ''
      if (nm.endsWith('.Cu')) cuLayers.push(nm)
    }
  }
  // canonical order: F.Cu, In1..InN, B.Cu
  cuLayers.sort((a, b) => {
    const rank = (s: string) => (s === 'F.Cu' ? 0 : s === 'B.Cu' ? 100 : 1 + (parseInt(s.replace(/\D+/g, '')) || 0))
    return rank(a) - rank(b)
  })
  if (cuLayers.length < 2) cuLayers = ['F.Cu', 'B.Cu']

  // --- board outline (Edge.Cuts graphics) ---
  const outline: OutlineSeg[] = []
  const collectCuts = (nodes: Sexp[][], kind: 'line' | 'arc' | 'rect' | 'circle') => {
    for (const g of nodes) {
      const layerN = child(g, 'layer')
      if (!layerN || atom(layerN[1]) !== 'Edge.Cuts') continue
      if (kind === 'line') {
        const st = child(g, 'start')!, en = child(g, 'end')!
        outline.push({ type: 'line', a: [num(st[1]), num(st[2])], b: [num(en[1]), num(en[2])] })
      } else if (kind === 'arc') {
        const st = child(g, 'start')!, md = child(g, 'mid')!, en = child(g, 'end')!
        outline.push({ type: 'arc', a: [num(st[1]), num(st[2])], m: [num(md[1]), num(md[2])], b: [num(en[1]), num(en[2])] })
      } else if (kind === 'rect') {
        const st = child(g, 'start')!, en = child(g, 'end')!
        const a: [number, number] = [num(st[1]), num(st[2])]
        const b: [number, number] = [num(en[1]), num(en[2])]
        outline.push(
          { type: 'line', a, b: [b[0], a[1]] },
          { type: 'line', a: [b[0], a[1]], b },
          { type: 'line', a: b, b: [a[0], b[1]] },
          { type: 'line', a: [a[0], b[1]], b: a },
        )
      } else {
        const cN = child(g, 'center')!, eN = child(g, 'end')!
        const c: [number, number] = [num(cN[1]), num(cN[2])]
        const e: [number, number] = [num(eN[1]), num(eN[2])]
        outline.push({ type: 'circle', c, r: Math.hypot(e[0] - c[0], e[1] - c[1]) })
      }
    }
  }
  // document order (not per-kind): the stitching downstream is order-sensitive,
  // and this keeps both parse engines feeding it identical input.
  for (const node of root) {
    if (!Array.isArray(node)) continue
    if (node[0] === 'gr_line') collectCuts([node], 'line')
    else if (node[0] === 'gr_arc') collectCuts([node], 'arc')
    else if (node[0] === 'gr_rect') collectCuts([node], 'rect')
    else if (node[0] === 'gr_circle') collectCuts([node], 'circle')
  }

  // --- footprints ---
  const comps: BoardComp[] = []
  for (const fpNode of children(root, 'footprint')) {
    const fp = atom(fpNode[1])
    const layerNode = child(fpNode, 'layer')
    const layer = layerNode ? atom(layerNode[1]) : 'F.Cu'
    const at = parseAt(child(fpNode, 'at'))
    // reference
    let ref = ''
    for (const p of children(fpNode, 'property')) if (atom(p[1]) === 'Reference') ref = atom(p[2])
    if (!ref) { const fpText = child(fpNode, 'fp_text'); if (fpText && atom(fpText[1]) === 'reference') ref = atom(fpText[2]) }

    const pads: BoardPad[] = []
    for (const pad of children(fpNode, 'pad')) {
      const pAt = parseAt(child(pad, 'at'))
      const sizeN = child(pad, 'size')
      const w = sizeN ? num(sizeN[1]) : 1
      const l = sizeN ? num(sizeN[2]) : 1
      const layersN = child(pad, 'layers')
      const layers = layersN ? layersN.slice(1).map(atom) : []
      const netN = child(pad, 'net')
      const net = netN ? (netName.get(num(netN[1])) ?? atom(netN[2]) ?? '') : ''
      const th = pad[2] === 'thru_hole'
      const shape = typeof pad[3] === 'string' ? pad[3] : 'rect'
      // absolute position: pad local (possibly with own rotation) transformed by footprint
      const [ax, ay] = xform(pAt.x, pAt.y, at)
      // pad own rotation + footprint rotation decides w/l orientation
      const totalRot = at.rot + pAt.rot
      const swap = Math.abs(((totalRot % 180) + 180) % 180 - 90) < 45
      pads.push({
        x: +ax.toFixed(4), y: +ay.toFixed(4),
        w: +(swap ? l : w).toFixed(4), l: +(swap ? w : l).toFixed(4),
        shape, net,
        top: th || layers.includes('F.Cu') || layers.includes('*.Cu'),
        bottom: th || layers.includes('B.Cu') || layers.includes('*.Cu'),
        th,
      })
    }
    comps.push({ ref, x: +at.x.toFixed(4), y: +at.y.toFixed(4), rot: +at.rot.toFixed(2), layer, fp, pads })
  }

  // --- track segments (document order: segments and arcs interleaved, matching
  // the upstream parser and the file's own draw order) ---
  const traces: BoardTrace[] = []
  for (const node of root) {
    if (!Array.isArray(node)) continue
    if (node[0] === 'segment') {
      const st = child(node, 'start')!, en = child(node, 'end')!
      const layerN = child(node, 'layer')
      const widthN = child(node, 'width')
      traces.push({
        pts: [[num(st[1]), num(st[2])], [num(en[1]), num(en[2])]],
        w: widthN ? num(widthN[1]) : 0.25,
        layer: layerN ? atom(layerN[1]) : 'F.Cu',
      })
    } else if (node[0] === 'arc') {
      const st = child(node, 'start')!, mid = child(node, 'mid')!, en = child(node, 'end')!
      const layerN = child(node, 'layer')
      const widthN = child(node, 'width')
      traces.push({
        arc: true,
        pts: [[num(st[1]), num(st[2])], [num(mid[1]), num(mid[2])], [num(en[1]), num(en[2])]],
        w: widthN ? num(widthN[1]) : 0.25,
        layer: layerN ? atom(layerN[1]) : 'F.Cu',
      })
    }
  }

  // --- zones (copper pours) ---
  const zones: BoardZone[] = []
  for (const z of children(root, 'zone')) {
    const layerN = child(z, 'layer')
    const layersN = child(z, 'layers')
    const netN = child(z, 'net_name')
    const layerNames = layersN ? layersN.slice(1).map(atom) : [layerN ? atom(layerN[1]) : 'F.Cu']
    for (const poly of children(z, 'polygon')) {
      const ptsN = child(poly, 'pts')
      if (!ptsN) continue
      const pts: [number, number][] = []
      for (const xy of ptsN.slice(1)) {
        if (Array.isArray(xy) && xy[0] === 'xy') pts.push([num(xy[1]), num(xy[2])])
      }
      if (pts.length >= 3) zones.push({ pts, layer: layerNames[0] ?? 'F.Cu', layers: layerNames, net: netN ? atom(netN[1]) : '' })
    }
  }

  // --- vias ---
  const vias: BoardVia[] = []
  for (const v of children(root, 'via')) {
    const at = parseAt(child(v, 'at'))
    const sizeN = child(v, 'size')
    const drillN = child(v, 'drill')
    vias.push({
      x: +at.x.toFixed(3), y: +at.y.toFixed(3),
      size: sizeN ? num(sizeN[1]) : 0.8,
      drill: drillN ? num(drillN[1]) : 0.4,
    })
  }

  // --- silkscreen text on the board (gr_text on *.SilkS) ---
  const texts: BoardText[] = []
  for (const t of children(root, 'gr_text')) {
    const layerN = child(t, 'layer')
    const lyr = layerN ? atom(layerN[1]) : ''
    if (!lyr.includes('SilkS')) continue
    const at = parseAt(child(t, 'at'))
    const effects = child(t, 'effects')
    const font = effects ? child(effects, 'font') : null
    const sizeN = font ? child(font, 'size') : null
    texts.push({ text: atom(t[1]), x: at.x, y: at.y, rot: at.rot, size: sizeN ? num(sizeN[1]) : 1, layer: lyr })
  }

  // --- bbox: prefer outline, else pads/extents ---
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const eat = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  if (outline.length) {
    for (const o of outline) {
      if (o.type === 'circle') { eat(o.c[0] - o.r, o.c[1] - o.r); eat(o.c[0] + o.r, o.c[1] + o.r) }
      else { eat(o.a[0], o.a[1]); eat(o.b[0], o.b[1]); if (o.type === 'arc') eat(o.m[0], o.m[1]) }
    }
  } else {
    for (const c of comps) for (const p of c.pads) eat(p.x, p.y)
    x0 -= 3; y0 -= 3; x1 += 3; y1 += 3
  }

  return { outline, bbox: { x0, y0, x1, y1 }, cuLayers, comps, traces, zones, vias, texts }
}
