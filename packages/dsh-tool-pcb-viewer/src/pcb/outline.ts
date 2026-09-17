// Turn a parsed Edge.Cuts outline into a flattened polygon (mm, board coords).
// Shared by the 3D shape builder; tolerant of unordered segments and arcs.
//
// Edge.Cuts circles are NOT stitched into the main ring (splicing a closed
// circle into an open chain self-intersects). They are separate subpaths:
//   - board ring + circles  → circles are HOLES (cutouts)
//   - circles only          → the largest circle IS the board, the rest are holes
import type { BoardModel, OutlineSeg } from '../model.js'

/** A 2D point in board millimetres, kept as a tuple to survive round-trips. */
type Pt = [number, number]

type CircleSeg = Extract<OutlineSeg, { type: 'circle' }>

/** Board outline geometry: the outer ring plus any holes (circular cutouts). */
export interface OutlineParts {
  /** Outer boundary, CCW (positive signed area). Same semantics as before. */
  ring: Pt[]
  /** Inner boundaries to punch out, wound CW (opposite the ring). */
  holes: Pt[][]
}

/** Samples a full circle. `ccw` picks the ring (true) or hole (false) winding. */
function circlePts(cx: number, cy: number, r: number, n = 48, ccw = true): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const t = ((ccw ? 1 : -1) * 2 * Math.PI * i) / n
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)])
  }
  return pts
}

const holeOf = (c: CircleSeg): Pt[] => circlePts(c.c[0], c.c[1], c.r, 48, false)

/** Outer ring only — the long-standing signature, kept for existing callers. */
export function outlinePolygon(board: BoardModel): [number, number][] {
  return outlineParts(board).ring
}

export function outlineParts(board: BoardModel): OutlineParts {
  const B = board.bbox
  const segs = (board.outline || []).filter((s): s is Exclude<OutlineSeg, CircleSeg> => s.type !== 'circle')
  const circles = (board.outline || []).filter((s): s is CircleSeg => s.type === 'circle')
  const bboxRing = (): Pt[] => [[B.x0, B.y0], [B.x1, B.y0], [B.x1, B.y1], [B.x0, B.y1]]
  if (!segs.length) {
    if (circles.length) {
      // Pure-circle board: the biggest circle is the board itself, not a hole.
      const [main, ...rest] = [...circles].sort((a, b) => b.r - a.r)
      if (main) return { ring: circlePts(main.c[0], main.c[1], main.r, 48, true), holes: rest.map(holeOf) }
    }
    return { ring: bboxRing(), holes: [] }
  }

  // arc → point list (start→mid→end through a circle)
  const arcPts = (a: Pt, m: Pt, b: Pt, n = 16): Pt[] => {
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
    if (Math.abs(d) < 1e-9) return [a, b]
    const ux = ((a[0] ** 2 + a[1] ** 2) * (m[1] - b[1]) + (m[0] ** 2 + m[1] ** 2) * (b[1] - a[1]) + (b[0] ** 2 + b[1] ** 2) * (a[1] - m[1])) / d
    const uy = ((a[0] ** 2 + a[1] ** 2) * (b[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (a[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (m[0] - a[0])) / d
    const r = Math.hypot(a[0] - ux, a[1] - uy)
    const a0 = Math.atan2(a[1] - uy, a[0] - ux)
    const am = Math.atan2(m[1] - uy, m[0] - ux)
    const a1 = Math.atan2(b[1] - uy, b[0] - ux)
    // direction: sweep from a0 to a1 passing through am
    const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    const ccw = norm(a1 - a0)
    const mid = norm(am - a0)
    const pts: Pt[] = []
    if (mid <= ccw) { for (let i = 0; i <= n; i++) { const t = a0 + (ccw * i) / n; pts.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]) } }
    else { const cw = norm(a0 - a1); for (let i = 0; i <= n; i++) { const t = a0 - (cw * i) / n; pts.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]) } }
    return pts
  }

  // normalize segments to polyline point-lists
  const polys = segs.map((s) => (s.type === 'arc' ? arcPts(s.a, s.m, s.b) : [s.a, s.b]))

  // stitch by nearest endpoints
  const first = polys.shift()
  if (!first) return { ring: bboxRing(), holes: circles.map(holeOf) }
  const chain: Pt[] = first.slice()
  const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1])
  let guard = 0
  while (polys.length && guard++ < 500) {
    const tail = chain[chain.length - 1]
    if (!tail) break
    let bi = -1, bd = Infinity, flip = false
    for (let i = 0; i < polys.length; i++) {
      const p = polys[i]
      if (!p) continue
      const p0 = p[0]
      const pl = p[p.length - 1]
      if (!p0 || !pl) continue
      const d1 = dist(tail, p0), d2 = dist(tail, pl)
      if (d1 < bd) { bd = d1; bi = i; flip = false }
      if (d2 < bd) { bd = d2; bi = i; flip = true }
    }
    const p = polys.splice(bi, 1)[0]
    if (!p) break
    const seq = flip ? p.slice().reverse() : p
    for (let i = (bd < 0.01 ? 1 : 0); i < seq.length; i++) { const q = seq[i]; if (q) chain.push(q) }
  }
  // winding normalization: the stitched ring always comes out CCW (positive
  // signed area). The greedy chain direction depends on which segment was
  // first, so collection order (doc order vs per-kind batches) used to decide
  // the ring's orientation — normalize it away.
  let area = 0
  for (let i = 0; i < chain.length; i++) {
    const a = chain[i]
    const b = chain[(i + 1) % chain.length]
    if (!a || !b) continue
    area += a[0] * b[1] - b[0] * a[1]
  }
  if (area < 0) chain.reverse()
  return { ring: chain, holes: circles.map(holeOf) }
}
