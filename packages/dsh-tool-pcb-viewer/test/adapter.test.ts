/**
 * Adapter parity tests — the swap to `@huaqiu/kicad-sexpr-parser` is only safe if
 * the adapter produces the same flat model my verified `parseKicad` produced.
 * Golden values recorded from that validated pipeline.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BoardParser } from '@huaqiu/kicad-sexpr-parser'
import { adaptBoard } from '../src/adapter.js'
import { outlinePolygon } from '../src/pcb/outline.js'

const FIX = path.join(__dirname, 'fixtures')
const load = (name: string) => adaptBoard(new BoardParser().parse(fs.readFileSync(path.join(FIX, name), 'utf8')))

describe('adapter: esp_mcb (before_autoplace)', () => {
  const b = load('esp_mcb.kicad_pcb')

  it('structure counts', () => {
    expect(b.comps.length).toBe(113)
    expect(b.comps.reduce((s, c) => s + c.pads.length, 0)).toBe(353)
    expect(b.outline.length).toBe(8)
    expect(b.cuLayers).toEqual(['F.Cu', 'B.Cu'])
  })

  it('K1 relay: position + wide-flat pad span (18.5 × 4.7)', () => {
    const k1 = b.comps.find((c) => c.ref === 'K1')
    expect(k1).toBeTruthy()
    expect(k1!.x).toBeCloseTo(92, 1)
    expect(k1!.y).toBeCloseTo(11, 1)
    const xs = k1!.pads.map((p) => p.x), ys = k1!.pads.map((p) => p.y)
    const sw = Math.max(...xs) - Math.min(...xs)
    const sh = Math.max(...ys) - Math.min(...ys)
    expect(sw).toBeCloseTo(18.5, 1)
    expect(sh).toBeCloseTo(4.7, 1)
  })

  it('rotated connector (CN4): pads spread vertically, not horizontally', () => {
    const cn4 = b.comps.find((c) => c.ref === 'CN4')
    expect(cn4).toBeTruthy()
    const xs = cn4!.pads.map((p) => p.x), ys = cn4!.pads.map((p) => p.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(Math.max(...xs) - Math.min(...xs))
  })

  it('through-hole pads on both sides; SMD pads top only', () => {
    const k1 = b.comps.find((c) => c.ref === 'K1')!
    expect(k1.pads.every((p) => p.th && p.top && p.bottom)).toBe(true)
    const r1 = b.comps.find((c) => c.ref === 'R1')!
    expect(r1.pads.every((p) => !p.th && p.top && !p.bottom)).toBe(true)
  })
})

describe('adapter: esp_mcb routed', () => {
  const b = load('esp_mcb_routed.kicad_pcb')
  it('has the real traces + vias', () => {
    expect(b.traces.length).toBe(891)
    expect(b.vias.length).toBe(94)
  })
})

describe('adapter: other fixtures', () => {
  it('simple_led: traces + one zone + rect outline', () => {
    const b = load('simple_led.kicad_pcb')
    expect(b.comps.length).toBe(13)
    expect(b.traces.length).toBeGreaterThan(50)
    expect(b.zones.length).toBe(1)
    expect(b.outline.filter((o) => o.type === 'line').length).toBe(4)
  })

  it('mini-motor: rounded corners (arcs) in the outline', () => {
    const b = load('mini-motor-controller.kicad_pcb')
    expect(b.comps.length).toBe(39)
    expect(b.outline.some((o) => o.type === 'arc')).toBe(true)
  })

  it('stickhub: 9 board-level silkscreen texts survive (real data, S4 regression)', () => {
    const b = load('stickhub.kicad_pcb')
    expect(b.texts.length).toBe(9)
    expect(b.texts.every((t) => t.layer.includes('SilkS'))).toBe(true)
    for (const t of b.texts) expect(Number.isFinite(t.x) && Number.isFinite(t.y) && t.size > 0).toBe(true)
  })

  it('stickhub: dense board', () => {
    const b = load('stickhub.kicad_pcb')
    expect(b.comps.length).toBeGreaterThanOrEqual(90)
    expect(b.traces.length).toBeGreaterThan(1000)
    expect(b.zones.length).toBeGreaterThanOrEqual(3)
    expect(b.vias.length).toBeGreaterThan(0)
  })

  it('all fixtures: finite pad coords, positive sizes', () => {
    for (const f of fs.readdirSync(FIX)) {
      const b = load(f)
      for (const c of b.comps) {
        expect(Number.isFinite(c.x), `${f}:${c.ref} x`).toBe(true)
        for (const p of c.pads) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y) && p.w > 0 && p.l > 0, `${f}:${c.ref} pad`).toBe(true)
        }
      }
    }
  })
})

describe('adapter: synthetic full-coverage fixture (S1–S5/M1 regression net)', () => {
  const b = load('synth_full.kicad_pcb')

  it('S1: 4-layer board keeps inner copper layers', () => {
    expect(b.cuLayers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
  })

  it('S2: Edge.Cuts gr_rect becomes 4 edges, not a diagonal', () => {
    const lines = b.outline.filter((o) => o.type === 'line')
    // rect (10,10)-(60,40) → exactly its 4 edges (the dangling gr_line moved to synth_line_cuts)
    expect(lines.length).toBe(4)
    const xs = lines.flatMap((o) => o.type === 'line' ? [o.a[0], o.b[0]] : [])
    expect(Math.max(...xs)).toBeCloseTo(60, 3)
    expect(Math.min(...xs)).toBeCloseTo(10, 3)
  })

  it('S3: Edge.Cuts gr_circle survives with r = |end − center|', () => {
    const circles = b.outline.filter((o) => o.type === 'circle')
    expect(circles.length).toBe(1)
    const c = circles[0]!
    expect(c.type).toBe('circle')
    if (c.type === 'circle') {
      expect(c.c).toEqual([20, 20])
      expect(c.r).toBeCloseTo(3, 6)
    }
  })

  it('S4: gr_text on F.SilkS is kept; courtyard text dropped', () => {
    expect(b.texts.length).toBe(1)
    expect(b.texts[0]!.text).toBe('SYNTH')
    expect(b.texts[0]!.layer).toBe('F.SilkS')
    expect(b.texts[0]!.size).toBeCloseTo(1.5, 6)
  })

  it('S5 + M1: zone keeps BOTH polygons; arc vertex filtered (no NaN)', () => {
    expect(b.zones.length).toBe(2)
    const p0 = b.zones[0]!
    // poly0 declared 5 pts: 4 corners + 1 arc → arc filtered → 4 pts
    expect(p0.pts.length).toBe(4)
    for (const pt of p0.pts) {
      expect(Number.isFinite(pt[0]), `x finite ${pt}`).toBe(true)
      expect(Number.isFinite(pt[1]), `y finite ${pt}`).toBe(true)
    }
    expect(b.zones[1]!.pts.length).toBe(4) // second polygon intact
  })

  it('sanity: inner-layer trace + via + pads still land', () => {
    expect(b.traces.length).toBe(2)
    expect(b.traces[1]!.layer).toBe('In1.Cu')
    expect(b.vias.length).toBe(1)
    expect(b.vias[0]!.x).toBeCloseTo(25, 3)
    expect(b.comps[0]!.pads.length).toBe(2)
    expect(b.comps[0]!.pads[0]!.net).toBe('GND') // net number → table lookup
  })
})

describe('adapter: CM5 real 6-layer board (S1/S4/S5 on real data)', () => {
  const b = load('CM5_MINIMA_3.kicad_pcb')

  it('keeps all 6 copper layers', () => {
    expect(b.cuLayers).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'])
  })

  it('board-level texts: CM5 has 131 drawings but ALL on Dwgs.User → correctly zero silk', () => {
    // CM5 把标注全画在 Dwgs.User 层（非丝印），所以板级丝印确实为 0 —— 断言的是「不误收」。
    expect(b.texts.length).toBe(0)
  })

  it('zones: every polygon kept, no NaN points', () => {
    expect(b.zones.length).toBeGreaterThan(0)
    for (const z of b.zones) {
      expect(z.pts.length).toBeGreaterThanOrEqual(3)
      for (const pt of z.pts) expect(Number.isFinite(pt[0]) && Number.isFinite(pt[1])).toBe(true)
    }
  })

  it('outline has real segments; bbox sane', () => {
    expect(b.outline.length).toBeGreaterThan(3)
    expect(b.bbox.x1 - b.bbox.x0).toBeGreaterThan(10)
  })
})

describe('adapter: stitched outline geometry (D2/D3 follow-ups)', () => {
  const signedArea = (pts: [number, number][]) => {
    let a = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!, q = pts[(i + 1) % pts.length]!
      a += p[0] * q[1] - q[0] * p[1]
    }
    return a / 2
  }

  it('synth_full: stitched ring is exactly the rect (area 1500, CCW-positive)', () => {
    const b = load('synth_full.kicad_pcb')
    const pts = outlinePolygon(b)
    expect(signedArea(pts)).toBeCloseTo(1500, 1)
  })

  it('synth_line_cuts: bare gr_line Edge.Cuts stitch into a rect ring (area 15)', () => {
    const b = load('synth_line_cuts.kicad_pcb')
    expect(b.outline.length).toBe(4)
    expect(b.outline.every((o) => o.type === 'line')).toBe(true)
    expect(signedArea(outlinePolygon(b))).toBeCloseTo(15, 6)
  })

  it('CM5: winding now matches the JS reference (positive signed area)', () => {
    const b = load('CM5_MINIMA_3.kicad_pcb')
    expect(signedArea(outlinePolygon(b))).toBeGreaterThan(0)
  })
})
