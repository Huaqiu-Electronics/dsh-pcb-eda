/**
 * Engine parity — the package has TWO parse engines producing one BoardModel:
 *   - src/pcb/parseKicad.ts  (default, linear)
 *   - src/adapter.ts         (@huaqiu/kicad-sexpr-parser, far slower on big boards)
 * src/parse.ts switches between them in one line, so they MUST stay identical.
 * This suite fails loudly if either engine drifts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BoardParser } from '@huaqiu/kicad-sexpr-parser'
import { adaptBoard } from '../src/adapter.js'
import { parseKicad } from '../src/pcb/parseKicad.js'
import type { BoardModel } from '../src/model.js'
import { outlinePolygon } from '../src/pcb/outline.js'

const FIX = path.join(__dirname, 'fixtures')
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8')

/** structural digest, tolerant to float formatting only */
function digest(b: BoardModel) {
  return {
    cuLayers: b.cuLayers,
    // Both engines collect Edge.Cuts / traces in DOCUMENT order, so this is an
    // exact ordered comparison (it caught a real divergence: parseKicad used to
    // collect per-kind, which also flipped the stitched ring's direction).
    outline: b.outline.map((o) => o.type === 'circle'
      ? `circle:${o.c}:${o.r}`
      : o.type === 'arc' ? `arc:${o.a}:${o.m}:${o.b}` : `line:${o.a}:${o.b}`),
    comps: b.comps.map((c) => [c.ref, c.fp, c.layer, c.x, c.y, c.rot, c.pads.length]),
    pads: b.comps.flatMap((c) => c.pads.map((p) => [p.x, p.y, p.w, p.l, p.shape, p.net, p.top, p.bottom, p.th])),
    traces: b.traces.map((t) => [t.layer, t.w, t.arc === true, t.pts.length]),
    zones: b.zones.map((z) => [z.layer, z.net, z.pts.length]),
    vias: b.vias.map((v) => [v.x, v.y, v.size, v.drill]),
    texts: b.texts.map((t) => [t.text, t.layer, t.x, t.y, t.size]),
    bbox: [b.bbox.x0, b.bbox.y0, b.bbox.x1, b.bbox.y1],
  }
}

const FIXTURES = [
  'simple_led.kicad_pcb',
  'mini-motor-controller.kicad_pcb',
  'esp_mcb.kicad_pcb',
  'esp_mcb_routed.kicad_pcb',
  'stickhub.kicad_pcb',
  'synth_full.kicad_pcb',
  'synth_line_cuts.kicad_pcb',
]

describe('parse engines stay in lockstep', () => {
  for (const f of FIXTURES) {
    it(`${f}: parseKicad === adapter`, () => {
      const text = read(f)
      expect(digest(parseKicad(text))).toEqual(digest(adaptBoard(new BoardParser().parse(text))))
    })

    it(`${f}: stitched outline ring is identical`, () => {
      const text = read(f)
      const ringA = outlinePolygon(parseKicad(text))
      const ringB = outlinePolygon(adaptBoard(new BoardParser().parse(text)))
      expect(ringB.length).toBe(ringA.length)
      // same ring, possibly starting at a different vertex → rotate to align
      const start = ringB.findIndex((p) => Math.abs(p[0] - ringA[0]![0]) < 1e-9 && Math.abs(p[1] - ringA[0]![1]) < 1e-9)
      expect(start, 'ring start vertex must exist in the other ring').toBeGreaterThanOrEqual(0)
      for (let i = 0; i < ringA.length; i++) {
        const p = ringA[i]!
        const q = ringB[(start + i) % ringB.length]!
        expect(Math.abs(p[0] - q[0])).toBeLessThan(1e-9)
        expect(Math.abs(p[1] - q[1])).toBeLessThan(1e-9)
      }
    })
  }
})
