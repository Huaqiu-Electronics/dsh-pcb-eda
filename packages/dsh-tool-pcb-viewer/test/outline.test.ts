/**
 * F1 — Edge.Cuts circles must render: a circular board is a disc (not its bbox
 * rectangle), and a circle inside a board ring is a cutout (a real hole).
 *
 * The invariant that protects every existing board: when Edge.Cuts carries no
 * circle, `ring` is point-for-point what `outlinePolygon` has always returned
 * and `holes` is empty — so the three consumers (canvas clip, THREE extrusion,
 * 2D view) see exactly what they saw before.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseBoard } from '../src/parse.js'
import { outlineParts, outlinePolygon } from '../src/pcb/outline.js'

/** Minimal structural view of the indexed geometry the area probe walks. */
interface THREE_Geo {
  index?: { count: number; getX(i: number): number } | null
  attributes?: { position?: { getX(i: number): number; getY(i: number): number } }
}

const FIX = path.join(__dirname, 'fixtures')
const load = (name: string) => parseBoard(fs.readFileSync(path.join(FIX, name), 'utf8'))

type Pt = [number, number]
/** min/max distance from `c` — a true circle sample has min ≈ max ≈ r. */
function radiusRange(pts: Pt[], c: Pt): [number, number] {
  const rs = pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]))
  return [Math.min(...rs), Math.max(...rs)]
}
function signedArea(pts: Pt[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

describe('F1: circle-only Edge.Cuts → a disc, not the bbox rectangle', () => {
  const parts = outlineParts(load('synth_circle_only.kicad_pcb'))

  it('the ring is a sampled circle, not a 4-point rectangle', () => {
    expect(parts.ring.length).toBeGreaterThan(16)
    // the pre-fix behaviour was exactly the 4-corner bbox rect
    expect(parts.ring).not.toEqual([[10, 10], [30, 10], [30, 30], [10, 30]])
  })

  it('every ring point sits on r = 10 about (20,20)', () => {
    const [min, max] = radiusRange(parts.ring, [20, 20])
    expect(min).toBeCloseTo(10, 1)
    expect(max).toBeCloseTo(10, 1)
  })

  it('encloses the disc area, and is wound CCW like every other ring', () => {
    // The ring is an inscribed n-gon, so its area is (n/2)·r²·sin(2π/n) — a hair
    // under πr². Assert the exact polygon area, and that it is within 1% of the
    // true disc (i.e. the sampling is fine enough to read as a circle).
    const n = parts.ring.length
    const exact = (n / 2) * 100 * Math.sin((2 * Math.PI) / n)
    expect(signedArea(parts.ring)).toBeCloseTo(exact, 6)
    expect(signedArea(parts.ring)).toBeGreaterThan(Math.PI * 100 * 0.99)
    expect(signedArea(parts.ring)).toBeGreaterThan(0)
  })

  it('the board circle is the body, so there are no holes', () => {
    expect(parts.holes).toEqual([])
  })
})

describe('F1: board ring + inner circle → a real cutout', () => {
  const parts = outlineParts(load('synth_circle_cutout.kicad_pcb'))

  it('the outer ring is untouched by the fix (the 4-line rect, closing point included)', () => {
    // 5 points, not 4: the stitcher appends the closing vertex. This is the
    // long-standing ring shape and the fix must not alter it.
    expect(parts.ring).toEqual([[10, 10], [40, 10], [40, 40], [10, 40], [10, 10]])
  })

  it('the circle becomes exactly one hole', () => {
    expect(parts.holes.length).toBe(1)
    expect(parts.holes[0]!.length).toBeGreaterThan(16)
  })

  it('the hole sits on r = 3 about (25,25)', () => {
    const [min, max] = radiusRange(parts.holes[0]! as Pt[], [25, 25])
    expect(min).toBeCloseTo(3, 1)
    expect(max).toBeCloseTo(3, 1)
  })

  it('the hole is wound opposite the ring (CW vs CCW)', () => {
    expect(signedArea(parts.ring)).toBeGreaterThan(0)
    expect(signedArea(parts.holes[0]! as Pt[])).toBeLessThan(0)
  })
})

describe('F1: circle-free boards are bit-for-bit unaffected', () => {
  // Real boards + the synthetic line-only fixtures. None has an Edge.Cuts
  // circle, so all three consumers must see the identical ring they saw before.
  const RINGS: Record<string, number> = {
    'CM5_MINIMA_3.kicad_pcb': 241,
    'stickhub.kicad_pcb': 141,
    'esp_mcb_routed.kicad_pcb': 69,
    'esp_mcb.kicad_pcb': 69,
    'mini-motor-controller.kicad_pcb': 69,
    'simple_led.kicad_pcb': 5,
    'synth_line_cuts.kicad_pcb': 5,
  }

  for (const [name, len] of Object.entries(RINGS)) {
    it(`${name}: no holes, ring stays ${len} points, still CCW`, () => {
      const b = load(name)
      expect(b.outline.some((o) => o.type === 'circle')).toBe(false)
      const parts = outlineParts(b)
      expect(parts.holes).toEqual([])
      expect(parts.ring.length).toBe(len)
      expect(signedArea(parts.ring as Pt[])).toBeGreaterThan(0)
    })
  }

  it('outlinePolygon() stays the compatible alias for parts.ring', () => {
    for (const name of Object.keys(RINGS)) {
      const b = load(name)
      expect(outlinePolygon(b)).toEqual(outlineParts(b).ring)
    }
  })
})

describe('F1 end-to-end: the hole reaches the built 3D geometry', () => {
  // outlineParts alone proves nothing if buildBoard ignores `holes`. Measure the
  // triangulated board face: a punched hole shows up as missing area.
  const faceArea = async (name: string): Promise<number> => {
    const { buildBoard } = await import('../src/scene/buildBoard.js')
    const built = buildBoard(load(name), { textures: false })
    let best = 0
    built.group.traverse((o) => {
      const mesh = o as unknown as { isMesh?: boolean; geometry?: THREE_Geo }
      const g = mesh.geometry
      if (!mesh.isMesh || !g?.index || !g.attributes?.position) return
      const pos = g.attributes.position, idx = g.index
      let a = 0
      for (let i = 0; i < idx.count; i += 3) {
        const A = idx.getX(i), B = idx.getX(i + 1), C = idx.getX(i + 2)
        const ax = pos.getX(A), ay = pos.getY(A)
        a += Math.abs((pos.getX(B) - ax) * (pos.getY(C) - ay) - (pos.getX(C) - ax) * (pos.getY(B) - ay)) / 2
      }
      if (a > best) best = a
    })
    built.dispose()
    return best
  }

  it('cutout board: the r=3 hole is missing from the board face', async () => {
    const area = await faceArea('synth_circle_cutout.kicad_pcb')
    const ngon = (48 / 2) * 9 * Math.sin((2 * Math.PI) / 48) // the sampled hole
    expect(area).toBeCloseTo(30 * 30 - ngon, 2)
    expect(area).toBeLessThan(30 * 30) // i.e. not a solid slab
  })

  it('circle-only board: the face is a disc, not its 20×20 bbox square', async () => {
    const area = await faceArea('synth_circle_only.kicad_pcb')
    expect(area).toBeCloseTo((48 / 2) * 100 * Math.sin((2 * Math.PI) / 48), 2)
    expect(area).toBeLessThan(400)
  })

  it('a real board (stickhub) keeps exactly its pre-fix face area', async () => {
    expect(await faceArea('stickhub.kicad_pcb')).toBeCloseTo(605.2818, 3)
  })
})
