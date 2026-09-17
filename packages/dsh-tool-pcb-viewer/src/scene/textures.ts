// ---------------------------------------------------------------------------
// textures.ts — procedural board-surface texture generation for the PCB
// renderer. Driven entirely by parsed board data (BoardModel); nothing is
// hardcoded to a specific board.
//
//   const t = makeBoardTextures(board)
//   → { maskTop, maskBot, copperTop, copperBot, inner: Map<layerName, texture>, W, H, outlinePath, S }
//
// Coordinate mapping (verified — do not change):
//   px(x) = (x - bbox.x0) * S          canvas x  (mm → px)
//   py(y) = (y - bbox.y0) * S          canvas y (input data is pre-mirrored in Y)
// Every layer canvas is the same size and uses this mapping, so all layers
// align pixel-for-pixel. The board outline is clipped on every canvas so no
// artwork bleeds past the edge.
//
// Pure three.js + canvas 2D. Runs in the browser; in Node (no DOM) a tiny
// canvas shim lets module import and smoke tests succeed without rendering.
// ---------------------------------------------------------------------------

// Path2D stub for Node (no DOM).
if (typeof (globalThis as { Path2D?: unknown }).Path2D === 'undefined') {
  ;(globalThis as Record<string, unknown>).Path2D = class {
    moveTo() {} lineTo() {} arc() {} ellipse() {} rect() {} closePath() {}
  }
}

import * as THREE from 'three'
import { outlineParts } from '../pcb/outline.js'
import type { BoardModel, BoardPad } from '../model.js'

const MAX_CANVAS = 4096 // hard cap on canvas dimension (px)

type Pt = [number, number]
type Ctx = CanvasRenderingContext2D

// A minimal canvas stand-in with the 2D API surface this module uses.
interface ShimCanvas { width: number; height: number; getContext(id: string): Ctx }

// ---------- canvas factory (browser native, Node shim fallback) ----------
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  w = Math.max(1, Math.round(w))
  h = Math.max(1, Math.round(h))
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  // Headless fallback: drawing calls no-op; geometry/size are still correct so
  // tests can assert on them.
  const noop = () => {}
  const grad = { addColorStop: noop }
  const ctx = {
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, ellipse: noop, rect: noop, fillRect: noop, strokeRect: noop, clearRect: noop,
    fill: noop, stroke: noop, clip: noop, translate: noop, rotate: noop, scale: noop,
    fillText: noop, strokeText: noop, setLineDash: noop, putImageData: noop,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    createImageData: (ww: number, hh: number) => ({ data: new Uint8ClampedArray(Math.max(1, ww * hh * 4)), width: ww, height: hh }),
    getImageData: (_x: number, _y: number, ww: number, hh: number) => ({ data: new Uint8ClampedArray(Math.max(1, ww * hh * 4)), width: ww, height: hh }),
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    textAlign: 'center', textBaseline: 'middle', font: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
  }
  const shim: ShimCanvas = { width: w, height: h, getContext: () => ctx as unknown as Ctx }
  return shim as unknown as HTMLCanvasElement
}

// ---------- deterministic pseudo-random (stable textures across reloads) ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- geometry helpers ----------
const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1])

// Circle through three points (start, mid, end). Returns {cx, cy, r} or null if
// the points are collinear / degenerate.
function circleThrough3(a: Pt, m: Pt, b: Pt): { cx: number; cy: number; r: number } | null {
  const ax = a[0], ay = a[1], mx = m[0], my = m[1], bx = b[0], by = b[1]
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
  if (!isFinite(d) || Math.abs(d) < 1e-9) return null
  const a2 = ax * ax + ay * ay, m2 = mx * mx + my * my, b2 = bx * bx + by * by
  const ux = (a2 * (my - by) + m2 * (by - ay) + b2 * (ay - my)) / d
  const uy = (a2 * (bx - mx) + m2 * (ax - bx) + b2 * (mx - ax)) / d
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) }
}

// Append arc a→m→b (all in canvas px coords) to path using the 3-point circle.
// Works with any object exposing lineTo(x, y): Path2D or a 2D context mid-path.
function appendArcCanvas(path: { lineTo(x: number, y: number): void }, a: Pt, m: Pt, b: Pt, n = 12): void {
  const c = circleThrough3(a, m, b)
  if (!c) { path.lineTo(b[0], b[1]); return } // degenerate (collinear): straight to end
  const ang = (p: Pt) => Math.atan2(p[1] - c.cy, p[0] - c.cx)
  const a0 = ang(a), am0 = ang(m)
  let am = am0
  let a1 = ang(b)
  while (am < a0 - Math.PI) am += 2 * Math.PI
  while (am > a0 + Math.PI) am -= 2 * Math.PI
  let delta = a1 - a0
  while (delta <= -Math.PI) delta += 2 * Math.PI
  while (delta > Math.PI) delta -= 2 * Math.PI
  if (Math.abs(am - a0) > Math.abs(am - (a0 + delta))) delta += delta < 0 ? 2 * Math.PI : -2 * Math.PI
  for (let i = 1; i <= n; i++) {
    const t = a0 + (delta * i) / n
    path.lineTo(c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t))
  }
}

// ---------- per-layer drawing (each wrapped so one bad path can't kill the build) ----------
function safe(label: string, fn: () => void): void {
  try { fn() } catch (e) { console.warn(`[textures] ${label}:`, e instanceof Error ? e.message : e) }
}

function padDiagonal(p: BoardPad): number { return Math.hypot(p.w || 0, p.l || 0) }

type Side = 'top' | 'bot'

// Pads on one side. `color` = fill; rim is a thin darker stroke.
function drawPads(ctx: Ctx, board: BoardModel, side: Side, color: string, growMm: number, S: number): void {
  const px = (x: number) => (x - board.bbox.x0) * S
  const py = (y: number) => (y - board.bbox.y0) * S
  const grow = growMm * S
  for (const c of board.comps || []) {
    for (const p of c.pads || []) {
      // top pads on maskTop, bottom on maskBot; through-hole pads on both
      if (side === 'top' && !(p.top || p.th)) continue
      if (side === 'bot' && !(p.bottom || p.th)) continue
      const x = px(p.x), y = py(p.y)
      const w = Math.max((p.w || 1) * S, 2) + grow * 2
      const l = Math.max((p.l || 1) * S, 2) + grow * 2
      ctx.fillStyle = color
      ctx.strokeStyle = 'rgba(60,40,10,0.55)'
      ctx.lineWidth = 1
      if (p.shape === 'circle') {
        const r = Math.max(w, l) / 2
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      } else if (p.shape === 'oval') {
        ctx.beginPath(); ctx.ellipse(x, y, w / 2, l / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      } else {
        ctx.fillRect(x - w / 2, y - l / 2, w, l)
        ctx.strokeRect(x - w / 2, y - l / 2, w, l)
      }
    }
  }
}

// Soft radial halos under each pad = the shiny solder fillet.
function drawSolderFillets(ctx: Ctx, board: BoardModel, side: Side, S: number): void {
  const px = (x: number) => (x - board.bbox.x0) * S
  const py = (y: number) => (y - board.bbox.y0) * S
  for (const c of board.comps || []) {
    for (const p of c.pads || []) {
      if (side === 'top' && !(p.top || p.th)) continue
      if (side === 'bot' && !(p.bottom || p.th)) continue
      const x = px(p.x), y = py(p.y)
      // tight, subtle sheen ring — big fuzzy halos make the board look dirty
      const r = Math.max(padDiagonal(p) * 0.55, 0.5) * S
      const g = ctx.createRadialGradient(x, y, r * 0.45, x, y, r)
      g.addColorStop(0, 'rgba(214,224,232,0.0)')
      g.addColorStop(0.72, 'rgba(214,224,232,0.26)')
      g.addColorStop(1, 'rgba(214,224,232,0)')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
    }
  }
}

// Silkscreen: board texts + per-component reference designators.
function drawSilk(ctx: Ctx, board: BoardModel, side: Side, S: number): void {
  const px = (x: number) => (x - board.bbox.x0) * S
  const py = (y: number) => (y - board.bbox.y0) * S
  const layerName = side === 'top' ? 'F.SilkS' : 'B.SilkS'
  ctx.fillStyle = 'rgba(240,245,248,0.92)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  safe(`silkscreen texts (${side})`, () => {
    for (const t of board.texts || []) {
      if ((t.layer || '') !== layerName) continue
      const sizePx = Math.max((t.size || 1) * S, 4)
      ctx.save()
      ctx.translate(px(t.x), py(t.y))
      // The canvas' vertical axis maps to the board flipped, so glyphs must be
      // pre-flipped on the canvas (scale(1,-1)) to read upright on the board.
      ctx.scale(1, -1)
      ctx.rotate(-((t.rot || 0) * Math.PI) / 180)
      ctx.font = `600 ${Math.round(sizePx)}px ui-monospace, Menlo, monospace`
      ctx.fillText(t.text || '', 0, 0)
      ctx.restore()
    }
  })

  safe(`silkscreen refs (${side})`, () => {
    const refSize = Math.max(1 * S, 5) // ~1 mm font
    for (const c of board.comps || []) {
      if (!c.ref) continue
      const isTopComp = (c.layer || 'F.Cu') !== 'B.Cu'
      if (side === 'top' && !isTopComp) continue
      if (side === 'bot' && isTopComp) continue
      if (/^M[23]/.test(c.fp || '')) continue // skip mounting-hardware refs
      ctx.save()
      ctx.translate(px(c.x), py(c.y))
      ctx.scale(1, -1) // see note above — pre-flip glyphs
      ctx.rotate(-((c.rot || 0) * Math.PI) / 180)
      ctx.font = `600 ${Math.round(refSize)}px ui-monospace, Menlo, monospace`
      ctx.fillText(c.ref, 0, -Math.max(2.5, refSize * 0.9))
      ctx.restore()
    }
  })
}

// Traces on one copper layer: polylines + arcs, round caps/joins.
function drawTraces(ctx: Ctx, board: BoardModel, layer: string, color: string, S: number): void {
  const px = (x: number) => (x - board.bbox.x0) * S
  const py = (y: number) => (y - board.bbox.y0) * S
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const t of board.traces || []) {
    if ((t.layer || '') !== layer) continue
    safe(`trace (${layer})`, () => {
      ctx.lineWidth = Math.max((t.w || 0.25) * S, 1.5)
      ctx.beginPath()
      if (t.arc && t.pts && t.pts.length === 3) {
        const a: Pt = [px(t.pts[0]![0]), py(t.pts[0]![1])]
        const m: Pt = [px(t.pts[1]![0]), py(t.pts[1]![1])]
        const b: Pt = [px(t.pts[2]![0]), py(t.pts[2]![1])]
        ctx.moveTo(a[0], a[1])
        appendArcCanvas(ctx, a, m, b, 8) // ctx works as a path sink (lineTo)
      } else {
        const pts = t.pts || []
        if (!pts.length) return
        ctx.moveTo(px(pts[0]![0]), py(pts[0]![1]))
        for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i]![0]), py(pts[i]![1]))
      }
      ctx.stroke()
    })
  }
}

// Copper zones (pours) on one layer.
function drawZones(ctx: Ctx, board: BoardModel, layer: string, S: number): void {
  const px = (x: number) => (x - board.bbox.x0) * S
  const py = (y: number) => (y - board.bbox.y0) * S
  ctx.fillStyle = 'rgba(190,120,50,0.55)'
  for (const z of board.zones || []) {
    if ((z.layer || '') !== layer) continue
    safe(`zone (${layer})`, () => {
      const pts = z.pts || []
      if (pts.length < 3) return
      ctx.beginPath()
      ctx.moveTo(px(pts[0]![0]), py(pts[0]![1]))
      for (let i = 1; i < pts.length; i++) ctx.lineTo(px(pts[i]![0]), py(pts[i]![1]))
      ctx.closePath()
      ctx.fill()
    })
  }
}

// Vias: ring + drill hole. Drawn on both copper faces.
function drawVias(ctx: Ctx, board: BoardModel, S: number): void {
  const px = (x: number) => (x - board.bbox.x0) * S
  const py = (y: number) => (y - board.bbox.y0) * S
  for (const v of board.vias || []) {
    safe('via', () => {
      const x = px(v.x), y = py(v.y)
      ctx.fillStyle = '#b87333'
      ctx.beginPath(); ctx.arc(x, y, Math.max((v.size || 0.8) / 2 * S, 1.5), 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#2a1a0e'
      ctx.beginPath(); ctx.arc(x, y, Math.max((v.drill || v.size * 0.5) / 2 * S, 0.75), 0, Math.PI * 2); ctx.fill()
    })
  }
}

// Faint copper mottling so the base doesn't read as flat color.
function drawCopperNoise(ctx: Ctx, w: number, h: number, rng: () => number, alpha = 0.08): void {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 2 * alpha * 255
    d[i] = Math.max(0, Math.min(255, (d[i] ?? 0) + n))
    d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] ?? 0) + n * 0.85))
    d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] ?? 0) + n * 0.6))
  }
  ctx.putImageData(img, 0, 0)
}

// ---------- texture assembly ----------
function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function makeMaskCanvas(board: BoardModel, side: Side, W: number, H: number, S: number, outlinePath: Path2D | null): HTMLCanvasElement {
  const canvas = makeCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  ctx.save()
  if (outlinePath) { ctx.beginPath(); ctx.clip(outlinePath, 'evenodd') }

  // deep green base with a vertical gradient for subtle depth
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, '#0f5e30')
  g.addColorStop(1, '#0b512a')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  // real solder mask is slightly translucent — traces ghost through as faint shadows
  safe(`mask trace ghost (${side})`, () => drawTraces(ctx, board, side === 'top' ? 'F.Cu' : 'B.Cu', 'rgba(6,26,14,0.35)', S))

  safe(`mask fillets (${side})`, () => drawSolderFillets(ctx, board, side, S))
  safe(`mask pads (${side})`, () => drawPads(ctx, board, side, '#cda94e', 0.08, S))
  safe(`mask silk (${side})`, () => drawSilk(ctx, board, side, S))

  ctx.restore()
  return canvas
}

function makeCopperCanvas(board: BoardModel, layer: string, W: number, H: number, S: number, outlinePath: Path2D | null): HTMLCanvasElement {
  const canvas = makeCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  ctx.save()
  if (outlinePath) { ctx.beginPath(); ctx.clip(outlinePath, 'evenodd') }

  ctx.fillStyle = '#7a4a1e'
  ctx.fillRect(0, 0, W, H)
  safe(`copper noise (${layer})`, () => drawCopperNoise(ctx, canvas.width, canvas.height, mulberry32(layer === 'F.Cu' ? 1234 : 5678)))

  safe(`copper zones (${layer})`, () => drawZones(ctx, board, layer, S))
  safe(`copper traces (${layer})`, () => drawTraces(ctx, board, layer, '#c98a3a', S))
  const side: Side = layer === 'F.Cu' ? 'top' : 'bot'
  safe(`copper pads (${layer})`, () => drawPads(ctx, board, side, '#e0b84e', 0, S))
  safe(`copper vias (${layer})`, () => drawVias(ctx, board, S))

  ctx.restore()
  return canvas
}

function makeInnerCanvas(layerName: string, W: number, H: number, S: number, outlinePath: Path2D | null, idx: number): HTMLCanvasElement {
  const canvas = makeCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  ctx.save()
  if (outlinePath) { ctx.beginPath(); ctx.clip(outlinePath, 'evenodd') }

  ctx.fillStyle = '#8a5a28'
  ctx.fillRect(0, 0, W, H)

  // faint darker traces — deterministic pseudo-random routing per inner layer
  safe(`inner traces (${layerName})`, () => {
    const rng = mulberry32(97 + idx * 131)
    ctx.strokeStyle = 'rgba(40,22,8,0.25)'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const n = 60 + Math.floor(rng() * 40)
    for (let i = 0; i < n; i++) {
      let x = rng() * W, y = rng() * H
      ctx.lineWidth = 1.5 + rng() * 3
      ctx.beginPath()
      ctx.moveTo(x, y)
      const steps = 2 + Math.floor(rng() * 4)
      for (let s = 0; s < steps; s++) {
        // mostly axis-aligned with occasional 45° jog — reads as inner-layer routing
        if (rng() < 0.72) x += (rng() - 0.5) * W * 0.35
        else y += (rng() - 0.5) * H * 0.35
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    // a few pour islands
    ctx.fillStyle = 'rgba(40,22,8,0.18)'
    for (let i = 0; i < 14; i++) {
      const x = rng() * W, y = rng() * H
      const w = 8 + rng() * 50, h = 8 + rng() * 40
      ctx.fillRect(x, y, w, h)
    }
  })

  ctx.restore()
  return canvas
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BoardTextures {
  maskTop: THREE.Texture
  maskBot: THREE.Texture
  copperTop: THREE.Texture
  copperBot: THREE.Texture
  inner: Map<string, THREE.Texture | null>
  W: number
  H: number
  outlinePath: Path2D
  S: number
}

// Subtle micro-grain for the solder mask: fine speckle + soft blotches.
// STANDALONE — no board data; used as a repeat-wrapped roughnessMap.
let _grainCache: THREE.CanvasTexture | null = null
export function makeMaskGrainTexture(): THREE.CanvasTexture {
  if (_grainCache) return _grainCache
  const size = 256
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')!
  const rng = mulberry32(424242)
  safe('grain speckle', () => {
    const img = ctx.createImageData(size, size)
    for (let i = 0; i < img.data.length; i += 4) {
      const n = 235 + Math.floor(rng() * 20)
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  })
  safe('grain blotches', () => {
    for (let i = 0; i < 60; i++) {
      const x = rng() * size, y = rng() * size
      const r = 8 + rng() * 30
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      const v = rng() > 0.5 ? 255 : 210
      g.addColorStop(0, `rgba(${v},${v},${v},0.06)`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
  })
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(9, 5)
  _grainCache = t
  return t
}

// Build every board-surface texture from parsed KiCad data.
export function makeBoardTextures(board: BoardModel): BoardTextures {
  const bb = board.bbox || { x0: 0, y0: 0, x1: 20, y1: 20 }
  let S = 16 // px per mm
  // clamp canvas so width*S ≤ MAX_CANVAS (boards ~20mm → ~350mm all fit)
  const mmW = Math.max(bb.x1 - bb.x0, 1e-6)
  const mmH = Math.max(bb.y1 - bb.y0, 1e-6)
  S = Math.min(S, MAX_CANVAS / mmW, MAX_CANVAS / mmH)
  S = Math.max(S, 0.5)

  const W = Math.round(mmW * S)
  const H = Math.round(mmH * S)
  const px = (x: number) => (x - bb.x0) * S
  const py = (y: number) => (y - bb.y0) * S

  // outline Path2D in canvas px space; fall back to the bbox rect.
  // Uses the validated shared stitcher (src/pcb/outline.ts). Holes (Edge.Cuts
  // circles) are appended as extra subpaths; every consumer clips with the
  // 'evenodd' rule so a hole punches through regardless of its winding.
  let outlinePath: Path2D
  try {
    const parts = outlineParts(board)
    const path = new Path2D()
    const sub = (pts: [number, number][]) => {
      pts.forEach((p, i) => { const X = px(p[0]), Y = py(p[1]); if (i === 0) path.moveTo(X, Y); else path.lineTo(X, Y) })
      path.closePath()
    }
    sub(parts.ring)
    for (const h of parts.holes) sub(h)
    outlinePath = path
  } catch (e) {
    console.warn('[textures] outline stitch failed:', e instanceof Error ? e.message : e)
    outlinePath = new Path2D()
    outlinePath.rect(0, 0, W, H)
  }

  const cuLayers = Array.isArray(board.cuLayers) && board.cuLayers.length >= 2 ? board.cuLayers : ['F.Cu', 'B.Cu']
  const innerLayers = cuLayers.filter((l) => l !== 'F.Cu' && l !== 'B.Cu')

  const maskTop = toTexture(makeMaskCanvas(board, 'top', W, H, S, outlinePath))
  const maskBot = toTexture(makeMaskCanvas(board, 'bot', W, H, S, outlinePath))
  const copperTop = toTexture(makeCopperCanvas(board, 'F.Cu', W, H, S, outlinePath))
  const copperBot = toTexture(makeCopperCanvas(board, 'B.Cu', W, H, S, outlinePath))

  const inner = new Map<string, THREE.Texture | null>()
  // Inner layers sit INSIDE the stack — barely visible — so they render at half
  // resolution (a quarter of the pixels). On a 10-layer board that removes 8
  // full-size canvases from the critical path. UVs are unchanged.
  const Sinner = S * 0.5
  const Winner = Math.max(1, Math.round(mmW * Sinner))
  const Hinner = Math.max(1, Math.round(mmH * Sinner))
  innerLayers.forEach((layerName, i) => {
    let tex: THREE.Texture | null = null
    try {
      tex = toTexture(makeInnerCanvas(layerName, Winner, Hinner, Sinner, outlinePath, i))
    } catch (e) {
      console.warn(`[textures] inner layer ${layerName}:`, e instanceof Error ? e.message : e)
    }
    inner.set(layerName, tex)
  })

  return { maskTop, maskBot, copperTop, copperBot, inner, W, H, outlinePath, S }
}
