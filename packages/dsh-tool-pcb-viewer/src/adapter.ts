/**
 * adapter.ts — convert the published `@huaqiu/kicad-sexpr-parser` model
 * (`I_KicadPCB`, nested protobuf-style) into the viewer's flat `BoardModel`.
 *
 * The renderer never sees the upstream parser's shape; this is the single
 * translation seam. Pad positions are emitted in ABSOLUTE board coordinates
 * (footprint position + rotation applied), matching the coordinate contract
 * the viewer was built and verified against.
 *
 * All upstream types come from the parser's `boardProto` namespace export —
 * never from deep `dist/proto/*` paths (not in the package's exports map).
 * NOTE: this engine is not the default (see ./parse.ts); keep it working and
 * keep it in parity — it is the path we switch back to when it wins on speed.
 *
 * @module @huaqiu/dsh-tool-pcb-viewer/adapter
 */
import { BoardParser, boardProto } from '@huaqiu/kicad-sexpr-parser'
import type {
  BoardModel, BoardComp, BoardPad, BoardTrace, BoardZone, BoardVia, OutlineSeg, BoardText,
} from './model.js'

type I_KicadPCB = boardProto.I_KicadPCB
type I_Footprint = boardProto.I_Footprint
type I_Pad = boardProto.I_Pad

const rad = (deg: number) => (deg * Math.PI) / 180

/** rotate a local point by `deg` (KiCad CCW) then translate by the footprint origin. */
function xform(lx: number, ly: number, fp: { x: number; y: number; rot: number }): [number, number] {
  const r = rad(fp.rot)
  const cs = Math.cos(r)
  const sn = Math.sin(r)
  return [fp.x + lx * cs - ly * sn, fp.y + lx * sn + ly * cs]
}

/**
 * Net name for a pad. Original pipeline priority: pad net NUMBER → top-level net
 * table lookup first, inline name only as a fallback (inline names can be stale).
 */
function padNet(pad: I_Pad, nets: ReadonlyMap<number, string>): string {
  const net = pad.net as { number?: number; name?: string } | undefined
  if (!net) return ''
  if (typeof net.number === 'number') return nets.get(net.number) ?? net.name ?? ''
  return net.name ?? ''
}

function adaptPad(pad: I_Pad, fp: { x: number; y: number; rot: number }, nets: ReadonlyMap<number, string>): BoardPad {
  const lx = pad.at?.position?.x ?? 0
  const ly = pad.at?.position?.y ?? 0
  const padRot = pad.at?.rotation ?? 0
  const [x, y] = xform(lx, ly, fp)
  const totalRot = ((fp.rot + padRot) % 180 + 180) % 180
  const swap = Math.abs(totalRot - 90) < 45
  const w = pad.size?.x ?? 1
  const l = pad.size?.y ?? 1
  const layers = pad.layers ?? []
  const th = pad.type === 'thru_hole'
  return {
    x: +x.toFixed(4),
    y: +y.toFixed(4),
    w: +(swap ? l : w).toFixed(4),
    l: +(swap ? w : l).toFixed(4),
    shape: pad.shape ?? 'rect',
    net: padNet(pad, nets),
    top: th || layers.includes('F.Cu') || layers.includes('*.Cu'),
    bottom: th || layers.includes('B.Cu') || layers.includes('*.Cu'),
    th,
  }
}

function adaptFootprint(fp: I_Footprint, nets: ReadonlyMap<number, string>): BoardComp {
  const props = fp.properties ?? {}
  const ref =
    props.Reference ??
    (fp.properties_kicad_8 ?? []).find((p) => p?.name === 'Reference')?.value ??
    ''
  const x = fp.at?.position?.x ?? 0
  const y = fp.at?.position?.y ?? 0
  const rot = fp.at?.rotation ?? 0
  return {
    ref,
    fp: fp.library_link ?? '',
    x: +x.toFixed(4),
    y: +y.toFixed(4),
    rot: +rot.toFixed(2),
    layer: fp.layer ?? 'F.Cu',
    pads: (fp.pads ?? []).map((p) => adaptPad(p, { x, y, rot }, nets)),
  }
}

/**
 * Edge.Cuts → outline segments. Upstream drawing discriminators (verified
 * against the parser's real key sets):
 *   gr_line   → start/end,            NO fill key
 *   gr_rect   → start/end + fill      (rect → 4 edges, same vertex order as the JS parser)
 *   gr_arc    → start/mid/end
 *   gr_circle → center/end            (radius = |end − center|; there is NO `radius` field)
 */
function adaptOutline(drawings: NonNullable<I_KicadPCB['drawings']>): OutlineSeg[] {
  const out: OutlineSeg[] = []
  for (const d of drawings ?? []) {
    if (!d) continue
    const g = d as boardProto.I_Line | boardProto.I_Arc | boardProto.I_Circle | boardProto.I_Rect | boardProto.I_Poly
    if (g.layer !== 'Edge.Cuts') continue
    if ('center' in g && 'end' in g) {
      // gr_circle
      const c = g.center, e = g.end
      out.push({ type: 'circle', c: [c.x, c.y], r: Math.hypot(e.x - c.x, e.y - c.y) })
    } else if ('mid' in g && 'start' in g && 'end' in g) {
      // gr_arc
      out.push({ type: 'arc', a: [g.start.x, g.start.y], m: [g.mid.x, g.mid.y], b: [g.end.x, g.end.y] })
    } else if ('start' in g && 'end' in g) {
      const a = g.start, b = g.end
      if ('fill' in g) {
        // gr_rect (fill key distinguishes it from gr_line) → 4 edges
        out.push(
          { type: 'line', a: [a.x, a.y], b: [b.x, a.y] },
          { type: 'line', a: [b.x, a.y], b: [b.x, b.y] },
          { type: 'line', a: [b.x, b.y], b: [a.x, b.y] },
          { type: 'line', a: [a.x, b.y], b: [a.x, a.y] },
        )
      } else {
        // gr_line
        out.push({ type: 'line', a: [a.x, a.y], b: [b.x, b.y] })
      }
    }
  }
  return out
}

/**
 * Board-level silkscreen text (gr_text only). I_Text.layer is an OBJECT
 * `{ name, knockout }` — not a string. Dimensions (I_Dimension) nest their text
 * under `.gr_text` and never carry a top-level `text` string, but we exclude
 * them defensively anyway.
 */
function adaptTexts(drawings: NonNullable<I_KicadPCB['drawings']>): BoardText[] {
  const out: BoardText[] = []
  for (const d of drawings ?? []) {
    if (!d) continue
    if ('gr_text' in d) continue // I_Dimension — its text lives nested, not a board-level silk item
    if (!('text' in d) || typeof d.text !== 'string' || !d.text) continue
    const g = d as boardProto.I_GrText
    const layer = typeof g.layer === 'string' ? g.layer : g.layer?.name ?? ''
    if (!layer.includes('SilkS')) continue
    out.push({
      text: g.text,
      x: g.at?.position?.x ?? 0,
      y: g.at?.position?.y ?? 0,
      rot: g.at?.rotation ?? 0,
      size: g.effects?.font?.size?.x ?? 1,
      layer,
    })
  }
  return out
}

/** copper layer names in stack order: F.Cu, In1..InN, B.Cu. (I_Layer.canonical_name — snake_case!) */
function cuLayerOrder(layers: I_KicadPCB['layers']): string[] {
  const names = (layers ?? [])
    .map((l) => l?.canonical_name ?? '')
    .filter((n): n is string => typeof n === 'string' && n.endsWith('.Cu'))
  const rank = (s: string) => (s === 'F.Cu' ? 0 : s === 'B.Cu' ? 100 : 1 + (parseInt(s.replace(/\D+/g, ''), 10) || 0))
  names.sort((a, b) => rank(a) - rank(b))
  return names.length >= 2 ? names : ['F.Cu', 'B.Cu']
}

/**
 * Adapt a parsed `.kicad_pcb` (`I_KicadPCB`) into the flat board model.
 * Semantic parity with the retired parseKicad pipeline is enforced by
 * test/adapter.test.ts (golden values from real fixtures).
 */
export function adaptBoard(board: I_KicadPCB): BoardModel {
  const nets = new Map<number, string>()
  for (const n of board.nets ?? []) if (n && typeof n.number === 'number') nets.set(n.number, n.name ?? '')

  const comps = (board.footprints ?? []).map((fp) => adaptFootprint(fp, nets))

  const traces: BoardTrace[] = (board.segments ?? []).map((s) => {
    if ('mid' in s) {
      return { pts: [[s.start.x, s.start.y], [s.mid.x, s.mid.y], [s.end.x, s.end.y]], w: s.width ?? 0.25, layer: s.layer ?? 'F.Cu', arc: true }
    }
    return { pts: [[s.start.x, s.start.y], [s.end.x, s.end.y]], w: s.width ?? 0.25, layer: s.layer ?? 'F.Cu' }
  })

  // zones: EVERY polygon child becomes a zone (not just the first); arc
  // vertices are filtered (the JS parser's `xy[0]==='xy'` test) — otherwise a
  // NaN coordinate would nuke the whole pour on the canvas.
  const zones: BoardZone[] = []
  for (const z of board.zones ?? []) {
    for (const poly of z.polygons ?? []) {
      const pts: [number, number][] = []
      for (const p of poly?.pts ?? []) {
        if (typeof (p as { x?: unknown }).x === 'number' && typeof (p as { y?: unknown }).y === 'number') {
          const pt = p as { x: number; y: number }
          pts.push([pt.x, pt.y])
        }
      }
      if (pts.length >= 3) {
        zones.push({
          pts,
          layer: z.layer ?? 'F.Cu',
          layers: z.layers ?? (z.layer ? [z.layer] : ['F.Cu']),
          net: z.net_name ?? '',
        })
      }
    }
  }

  const vias: BoardVia[] = (board.vias ?? []).map((v) => ({
    x: +(v.at?.position?.x ?? 0).toFixed(3),
    y: +(v.at?.position?.y ?? 0).toFixed(3),
    size: v.size ?? 0.8,
    drill: v.drill ?? 0.4,
  }))

  const outline = adaptOutline(board.drawings ?? [])
  const texts = adaptTexts(board.drawings ?? [])

  // bbox: outline extents, else pads/extents fallback
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const eat = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  if (outline.length) {
    for (const o of outline) {
      if (o.type === 'circle') { eat(o.c[0] - o.r, o.c[1] - o.r); eat(o.c[0] + o.r, o.c[1] + o.r) }
      else { eat(o.a[0], o.a[1]); eat(o.b[0], o.b[1]); if (o.type === 'arc') eat(o.m[0], o.m[1]) }
    }
  } else {
    for (const c of comps) for (const p of c.pads) eat(p.x, p.y)
    if (x0 === Infinity) { x0 = 0; y0 = 0; x1 = 10; y1 = 10 }
    x0 -= 3; y0 -= 3; x1 += 3; y1 += 3
  }

  return { outline, bbox: { x0, y0, x1, y1 }, cuLayers: cuLayerOrder(board.layers), comps, traces, zones, vias, texts }
}

export { BoardParser }
