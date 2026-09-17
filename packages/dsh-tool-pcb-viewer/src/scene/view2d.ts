// ---------------------------------------------------------------------------
// view2d.ts — KiCad-editor-style 2D top view of a parsed board (canvas 2D).
// Shows what the 3D mask hides: real traces, zones, vias, pads, silkscreen.
//   const v2d = create2DView(canvas)  →  { setBoard(parsedBoard), redraw(), destroy() }
// Coordinate convention: KiCad +y is DOWN — same as canvas, so no mirroring needed.
// ---------------------------------------------------------------------------
import type { BoardModel } from '../model.js'
import type { OutlineParts } from '../pcb/outline.js'

type Pt = [number, number]
type Ctx = CanvasRenderingContext2D
type Board2D = BoardModel & { _outlineParts?: OutlineParts }

const LAYER_COLORS = [
  '#d6483c', // F.Cu  — red (KiCad convention)
  '#3d6fd6', // B.Cu  — blue
  '#c9a227', '#2aa198', '#b58900', '#6c71c4', '#d33682', '#859900',
]
export function layerColor(name: string, cuLayers: string[]): string {
  if (name === 'F.Cu') return LAYER_COLORS[0]!
  if (name === 'B.Cu') return LAYER_COLORS[1]!
  const i = Math.max(0, cuLayers.indexOf(name) - 1)
  return LAYER_COLORS[2 + (i % (LAYER_COLORS.length - 2))]!
}

function circleThrough3(a: Pt, m: Pt, b: Pt): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
  if (Math.abs(d) < 1e-9) return null
  const ux = ((a[0] ** 2 + a[1] ** 2) * (m[1] - b[1]) + (m[0] ** 2 + m[1] ** 2) * (b[1] - a[1]) + (b[0] ** 2 + b[1] ** 2) * (a[1] - m[1])) / d
  const uy = ((a[0] ** 2 + a[1] ** 2) * (b[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (a[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (m[0] - a[0])) / d
  return { cx: ux, cy: uy, r: Math.hypot(a[0] - ux, a[1] - uy) }
}

export interface View2D {
  setBoard(parsed: BoardModel, outline: OutlineParts): void
  redraw(): void
  destroy(): void
}

export function create2DView(canvas: HTMLCanvasElement): View2D {
  const ctx = canvas.getContext('2d')!
  let board: Board2D | null = null
  let scale = 1, ox = 0, oy = 0 // mm → px transform: px = mm*scale + o
  let dragging = false, lx = 0, ly = 0
  let destroyed = false
  // 离屏缓存：同一缩放级别下平移只做一次 drawImage（大板平移从"全量重画"变"贴图"）
  let cache: HTMLCanvasElement | null = null
  let cacheScale = -1, cacheOx = 0, cacheOy = 0

  const px = (x: number) => (x - board!.bbox.x0) * scale + ox
  const py = (y: number) => (y - board!.bbox.y0) * scale + oy

  function fit() {
    if (!board) return
    const W = board.bbox.x1 - board.bbox.x0, H = board.bbox.y1 - board.bbox.y0
    const pad = 28
    // 面板可能被隐藏（0×0）——scale 必须保持正数，否则 arc() 会收到负半径
    scale = Math.max(0.01, Math.min((canvas.width - pad * 2) / W, (canvas.height - pad * 2) / H))
    ox = (canvas.width - W * scale) / 2
    oy = (canvas.height - H * scale) / 2
  }

  function drawArc(ctx: Ctx, a: Pt, m: Pt, b: Pt, w: number, color: string) {
    const c = circleThrough3(a, m, b)
    ctx.strokeStyle = color
    ctx.lineWidth = w
    if (!c) { ctx.beginPath(); ctx.moveTo(px(a[0]), py(a[1])); ctx.lineTo(px(b[0]), py(b[1])); ctx.stroke(); return }
    const a0 = Math.atan2(a[1] - c.cy, a[0] - c.cx)
    const a1 = Math.atan2(b[1] - c.cy, b[0] - c.cx)
    const am = Math.atan2(m[1] - c.cy, m[0] - c.cx)
    const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    const ccw = norm(a1 - a0), mid = norm(am - a0)
    const anticw = mid <= ccw
    ctx.beginPath()
    ctx.arc(px(c.cx), py(c.cy), c.r * scale, a0, a1, anticw)
    ctx.stroke()
  }

  function renderBoard(ctx: Ctx) {
    if (!board) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    // pane background
    ctx.fillStyle = '#0b0e13'
    ctx.fillRect(0, 0, W, H)

    // board body — ring plus any Edge.Cuts holes as extra subpaths. Filling and
    // clipping with 'evenodd' punches the holes out of the body AND out of
    // everything drawn after (zones/traces/pads all inherit this clip).
    const parts = board._outlineParts
    const poly = parts?.ring || []
    const holes = parts?.holes || []
    const bodyPath = new Path2D()
    const sub = (pts: Pt[]) => {
      pts.forEach((p, i) => { const X = px(p[0]), Y = py(p[1]); if (i === 0) bodyPath.moveTo(X, Y); else bodyPath.lineTo(X, Y) })
      bodyPath.closePath()
    }
    sub(poly)
    for (const h of holes) sub(h)
    ctx.save()
    ctx.fillStyle = '#123822'
    ctx.fill(bodyPath, 'evenodd')
    ctx.clip(bodyPath, 'evenodd')

    // zones (translucent pours) — batched per layer colour
    const zonePaths = new Map<string, Path2D>()
    for (const z of board.zones || []) {
      const key = z.layer || 'F.Cu'
      let path = zonePaths.get(key)
      if (!path) { path = new Path2D(); zonePaths.set(key, path) }
      z.pts.forEach((p, i) => { const X = px(p[0]), Y = py(p[1]); if (i === 0) path.moveTo(X, Y); else path.lineTo(X, Y) })
      path.closePath()
    }
    for (const [layer, path] of zonePaths) {
      ctx.fillStyle = layerColor(layer, board.cuLayers) + '2e'
      ctx.fill(path)
    }

    // traces by layer — BATCHED: one Path2D per (layer, width bucket) instead of a
    // beginPath/stroke per trace. Big boards carry tens of thousands of segments
    // and the per-call canvas state churn dominated the 2D view cost.
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const tracePaths = new Map<string, Path2D>()
    const widthOf = new Map<string, number>()
    for (const t of board.traces || []) {
      if (t.arc && t.pts.length === 3) continue // arcs drawn individually (rare)
      const w = Math.max(t.w * scale, 1)
      const key = (t.layer || 'F.Cu') + '|' + Math.round(w * 2) // bucket to 0.5px
      let path = tracePaths.get(key)
      if (!path) {
        path = new Path2D()
        tracePaths.set(key, path)
        widthOf.set(key, w)
      }
      const pts = t.pts
      const p0 = pts[0]
      if (!p0) continue
      path.moveTo(px(p0[0]), py(p0[1]))
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i]!
        path.lineTo(px(p[0]), py(p[1]))
      }
    }
    for (const [key, path] of tracePaths) {
      const layer = key.slice(0, key.lastIndexOf('|'))
      ctx.strokeStyle = layerColor(layer, board.cuLayers)
      ctx.lineWidth = widthOf.get(key)!
      ctx.stroke(path)
    }
    // arcs (few) drawn with the per-arc path helper
    for (const t of board.traces || []) {
      if (!(t.arc && t.pts.length === 3)) continue
      drawArc(ctx, t.pts[0]!, t.pts[1]!, t.pts[2]!, Math.max(t.w * scale, 1), layerColor(t.layer, board.cuLayers))
    }

    // vias — batched rings + holes
    const viaRing = new Path2D(), viaHole = new Path2D()
    for (const v of board.vias || []) {
      const X = px(v.x), Y = py(v.y)
      const rr = Math.max((v.size / 2) * scale, 1.2), hr = Math.max((v.drill / 2) * scale, 0.5)
      viaRing.moveTo(X + rr, Y); viaRing.arc(X, Y, rr, 0, Math.PI * 2)
      viaHole.moveTo(X + hr, Y); viaHole.arc(X, Y, hr, 0, Math.PI * 2)
    }
    ctx.fillStyle = '#c98a3a'; ctx.fill(viaRing)
    ctx.fillStyle = '#0b0e13'; ctx.fill(viaHole)

    // pads — gold; top pads solid, bottom-only pads outlined.
    // BATCHED into four Path2D buckets (rect/ellipse × filled/outlined) + one
    // fill/stroke each, same reason as the traces above.
    const padRectFill = new Path2D(), padRectStroke = new Path2D()
    const padEllFill = new Path2D(), padEllStroke = new Path2D()
    for (const c of board.comps || []) {
      for (const p of c.pads || []) {
        const X = px(p.x), Y = py(p.y)
        const w = Math.max(p.w * scale, 1.6), l = Math.max(p.l * scale, 1.6)
        const solid = p.top || p.th
        if (p.shape === 'circle' || p.shape === 'oval') {
          const target = solid ? padEllFill : padEllStroke
          target.moveTo(X + w / 2, Y)
          target.ellipse(X, Y, w / 2, l / 2, 0, 0, Math.PI * 2)
        } else {
          const target = solid ? padRectFill : padRectStroke
          target.rect(X - w / 2, Y - l / 2, w, l)
        }
      }
    }
    ctx.fillStyle = '#e8c35a'
    ctx.strokeStyle = '#e8c35a'
    ctx.fill(padRectFill); ctx.fill(padEllFill)
    ctx.lineWidth = 1
    ctx.stroke(padRectStroke); ctx.stroke(padEllStroke)

    // silkscreen board texts
    ctx.fillStyle = 'rgba(235,242,246,0.85)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const t of board.texts || []) {
      if ((t.layer || '') !== 'F.SilkS') continue
      ctx.save()
      ctx.translate(px(t.x), py(t.y))
      ctx.rotate(((t.rot || 0) * Math.PI) / 180)
      ctx.font = `600 ${Math.max(t.size * scale, 6)}px ui-monospace, Menlo, monospace`
      ctx.fillText(t.text || '', 0, 0)
      ctx.restore()
    }
    // ref designators — font/style set once, per-label transform only
    ctx.font = `600 ${Math.max(1 * scale, 5)}px ui-monospace, Menlo, monospace`
    ctx.fillStyle = 'rgba(235,242,246,0.55)'
    const refY = -Math.max(2.2 * scale, 7)
    for (const c of board.comps || []) {
      if (!c.ref || (c.layer || 'F.Cu') === 'B.Cu' || /^M[23]/.test(c.fp || '')) continue
      ctx.save()
      ctx.translate(px(c.x), py(c.y))
      if (c.rot) ctx.rotate(((c.rot || 0) * Math.PI) / 180)
      ctx.fillText(c.ref, 0, refY)
      ctx.restore()
    }
    ctx.restore()

    // outline stroke — the board edge and every cutout edge
    ctx.strokeStyle = 'rgba(95,224,205,0.5)'
    ctx.lineWidth = 1.2
    ctx.stroke(bodyPath)
  }

  function redraw() {
    if (!board || destroyed) return
    if (canvas.width < 8 || canvas.height < 8) return // 隐藏中：不排版不绘制
    const W = canvas.width, H = canvas.height
    if (!cache || cache.width !== W || cache.height !== H) {
      cache = document.createElement('canvas')
      cache.width = W
      cache.height = H
      cacheScale = -1 // 尺寸变了，缓存失效
    }
    if (cacheScale !== scale) { // 只有缩放级别变了才重画
      renderBoard(cache.getContext('2d')!)
      cacheScale = scale; cacheOx = ox; cacheOy = oy
    }
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#0b0e13'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(cache, Math.round(ox - cacheOx), Math.round(oy - cacheOy))
  }

  // pan / zoom
  function onDown(e: PointerEvent) { dragging = true; lx = e.clientX; ly = e.clientY }
  function onMove(e: PointerEvent) {
    if (!dragging) return
    ox += e.clientX - lx; oy += e.clientY - ly
    lx = e.clientX; ly = e.clientY
    redraw()
  }
  function onUp() { dragging = false }
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const r = canvas.getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    const k = e.deltaY < 0 ? 1.12 : 0.89
    scale = Math.min(Math.max(scale * k, 0.05), 200)
    ox = mx - (mx - ox) * k
    oy = my - (my - oy) * k
    redraw()
  }
  function onResize() {
    const r = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(r.width * dpr))
    canvas.height = Math.max(1, Math.round(r.height * dpr))
    if (r.width < 8 || r.height < 8) return // 面板隐藏（如 3D-only 模式）
    fit(); redraw()
  }

  canvas.addEventListener('pointerdown', onDown as EventListener)
  window.addEventListener('pointermove', onMove as EventListener)
  window.addEventListener('pointerup', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
  ro && ro.observe(canvas)

  return {
    setBoard(parsed: BoardModel, outline: OutlineParts) {
      board = parsed
      board._outlineParts = outline
      cacheScale = -1 // 换板：缓存必须失效（否则同尺寸板可能残留上一块的内容）
      cacheOx = 0
      cacheOy = 0
      onResize() // fits + redraws
    },
    redraw,
    destroy() {
      destroyed = true
      canvas.removeEventListener('pointerdown', onDown as EventListener)
      window.removeEventListener('pointermove', onMove as EventListener)
      window.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('wheel', onWheel)
      ro && ro.disconnect()
    },
  }
}
