/**
 * Flat board model — the renderer-facing shape.
 *
 * This is the contract every part of the viewer is written against. The host
 * half never returns this directly; `adapter.ts` converts the published
 * `@huaqiu/kicad-sexpr-parser` model (`I_KicadPCB`) into this.
 *
 * Units are millimetres. KiCad coordinates: +x right, +y DOWN (the viewer
 * pre-mirrors Y at build time so the render matches KiCad's front view).
 */

/** One pad in absolute board coordinates (footprint transform already applied). */
export interface BoardPad {
  x: number
  y: number
  /** board-aligned pad width (x extent) */
  w: number
  /** board-aligned pad length (y extent) */
  l: number
  shape: 'rect' | 'circle' | 'oval' | 'roundrect' | 'trapezoid' | 'custom' | string
  net: string
  /** present on the top copper */
  top: boolean
  /** present on the bottom copper */
  bottom: boolean
  /** through-hole */
  th: boolean
}

/** One footprint / component. */
export interface BoardComp {
  ref: string
  fp: string
  x: number
  y: number
  rot: number
  layer: 'F.Cu' | 'B.Cu' | string
  pads: BoardPad[]
}

/** One copper segment (track). `arc` marks a 3-point arc. */
export interface BoardTrace {
  pts: [number, number][]
  w: number
  layer: string
  arc?: boolean
}

/** A copper pour polygon on one layer. */
export interface BoardZone {
  pts: [number, number][]
  layer: string
  layers: string[]
  net: string
}

/** A via. */
export interface BoardVia {
  x: number
  y: number
  size: number
  drill: number
}

/** One Edge.Cuts outline element. */
export type OutlineSeg =
  | { type: 'line'; a: [number, number]; b: [number, number] }
  | { type: 'arc'; a: [number, number]; m: [number, number]; b: [number, number] }
  | { type: 'circle'; c: [number, number]; r: number }

/** Silkscreen board text (gr_text). */
export interface BoardText {
  text: string
  x: number
  y: number
  rot: number
  size: number
  layer: string
}

/** The full flat board model. */
export interface BoardModel {
  outline: OutlineSeg[]
  bbox: { x0: number; y0: number; x1: number; y1: number }
  cuLayers: string[]
  comps: BoardComp[]
  traces: BoardTrace[]
  zones: BoardZone[]
  vias: BoardVia[]
  texts: BoardText[]
}
