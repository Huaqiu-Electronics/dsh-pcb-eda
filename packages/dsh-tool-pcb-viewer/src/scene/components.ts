// Parametric 3D component template library for the PCB renderer.
//
// Each parsed component `c` carries absolute board-coord pads; this module
// re-derives them in the footprint's LOCAL frame (rot = 0) and builds a
// three.js Group whose base sits at z = 0, +z out of the board, x right,
// y down — matching KiCad's local axes. The caller positions/rotates it.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { M } from './materials.js'
import type { BoardComp, BoardPad } from '../model.js'

// ---------- small shared helpers ----------

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

// deterministic per-index pseudo-random in [0,1)
function rnd(i: number, salt = 0): number {
  const x = Math.sin(i * 127.1 + salt * 311.7 + 7.7) * 43758.5453
  return x - Math.floor(x)
}

// rounded box centered at z = z + h/2 (base sits on the given plane)
// 分级细分：小件的倒角在屏幕上不可见，却要付大量顶点（实测整板 512 万顶点）。
//  <1.5mm  → 直角盒（24 顶点）
//  <4mm    → 圆角盒 1 段
//  其余     → 圆角盒 3 段（原样）
function B_(w: number, l: number, h: number, mat: THREE.Material, z = 0): THREE.Mesh {
  const W = Math.max(w, 0.05), L = Math.max(l, 0.05), H = Math.max(h, 0.05)
  const big = Math.max(W, L)
  const radius = Math.min(0.22, W * 0.18, L * 0.18, H * 0.45)
  const geo = big < 1.5
    ? new THREE.BoxGeometry(W, L, H)
    : new RoundedBoxGeometry(W, L, H, big < 4 ? 1 : 3, radius)
  const m = new THREE.Mesh(geo, mat)
  m.position.z = z + h / 2
  return m
}

// small beveled metal post, base at z
function pin(w: number, l: number, h: number, mat: THREE.Material = M.gold, z = 0): THREE.Mesh {
  const r = Math.min(0.25, w * 0.3, l * 0.3)
  const m = new THREE.Mesh(new RoundedBoxGeometry(Math.max(w, 0.05), Math.max(l, 0.05), Math.max(h, 0.05), 2, r), mat)
  m.position.z = z + h / 2
  return m
}

// ---------- name parsing ----------

const IMPERIAL: Record<string, [number, number]> = {
  '0402': [1.0, 0.5], '0603': [1.6, 0.8], '0805': [2.0, 1.25], '1206': [3.2, 1.6],
  '1210': [3.2, 2.5], '1812': [4.5, 3.2], '2010': [5.0, 2.5], '2512': [6.3, 3.2],
}

function parseImperial(fp: string): [number, number] | null {
  const m = fp.match(/\b(0402|0603|0805|1206|1210|1812|2010|2512)\b/)
  const k = m?.[1]
  return (k && IMPERIAL[k]) ? IMPERIAL[k]! : null
}

function parseLW(fp: string): [number, number] | null {
  const m = fp.match(/L([\d.]+)-W([\d.]+)/)
  return (m && m[1] !== undefined && m[2] !== undefined) ? [parseFloat(m[1]), parseFloat(m[2])] : null
}

function parsePitch(fp: string): number | null {
  const m = fp.match(/P([\d.]+)/)
  return (m && m[1] !== undefined) ? parseFloat(m[1]) : null
}

// e.g. C_Ele_SMD_5x5.4mm → [5, 5.4]
function parseXMM(fp: string): [number, number] | null {
  const m = fp.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/)
  return (m && m[1] !== undefined && m[2] !== undefined) ? [parseFloat(m[1]), parseFloat(m[2])] : null
}

// ---------- local frame ----------

interface LocalFrame {
  pads: BoardPad[]
  bbox: { minX: number; maxX: number; minY: number; maxY: number }
  cx: number
  cy: number
}

// Transform absolute pads into the footprint's local frame (rot = 0):
// local = P(-rot) · (pad − center) where P is the CCW rotation matrix — the exact
// inverse of the parser's absolute = anchor + P(rot) · local. (Using P(rot) here
// instead of P(-rot) was silently wrong for 90°/270° parts; 0°/180° accidentally
// work because P(θ)=P(-θ) there.)
function toLocal(c: BoardComp): LocalFrame {
  const r = (c.rot * Math.PI) / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const pads = c.pads.map((p) => {
    const dx = p.x - c.x, dy = p.y - c.y
    const lx = cos * dx + sin * dy
    const ly = -sin * dx + cos * dy
    if (lx < minX) minX = lx
    if (lx > maxX) maxX = lx
    if (ly < minY) minY = ly
    if (ly > maxY) maxY = ly
    return { x: lx, y: ly, w: p.w, l: p.l, shape: p.shape, net: p.net, top: p.top, bottom: p.bottom, th: p.th }
  })
  if (!isFinite(minX)) { minX = -1; maxX = 1; minY = -1; maxY = 1 }
  return { pads, bbox: { minX, maxX, minY, maxY }, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

const spanX = (b: LocalFrame['bbox']) => b.maxX - b.minX
const spanY = (b: LocalFrame['bbox']) => b.maxY - b.minY

// ---------- template builders ----------
// Each takes (g, c, L) where L is the local frame; adds meshes to g.

function buildWifi(g: THREE.Group, _c: BoardComp, _L: LocalFrame): void {
  // ESP-WROOM-style module: green substrate + rounded metal RF shield + antenna strip
  addM(g, B_(18, 13.5, 0.9, M.modGreen))
  const shield = new THREE.Mesh(new RoundedBoxGeometry(16.4, 11.6, 3.2, 3, 0.7), M.shield)
  shield.position.set(0, -1.2, 0.9 + 1.6)
  addM(g, shield)
  // subtle seam at the shield base
  addM(g, B_(16.8, 12.0, 0.35, M.darkGray).translateY(-1.2))
  // antenna strip along one short edge
  addM(g, B_(16.4, 2.6, 0.9, new THREE.MeshStandardMaterial({ color: 0x1c2b20, roughness: 0.7 })).translateY(4.9))
}

function buildRelay(g: THREE.Group, _c: BoardComp, L: LocalFrame): void {
  // Wide flat power relay (G5NB-class). TH pins span the long axis; body depth
  // is capped at 10 so relays stacked 12mm apart don't collide.
  const sx = spanX(L.bbox), sy = spanY(L.bbox)
  // long axis = whichever pad spread is bigger
  const alongX = sx >= sy
  const bw = alongX ? sx + 3.5 : Math.min(sy + 5, 10)
  const bl = alongX ? Math.min(sx + 5, 10) : sy + 3.5
  const h = 13
  addM(g, B_(bw, bl, h, M.black))
  // cream top face, slightly inset, with a darker brand panel
  addM(g, B_(bw * 0.94, bl * 0.88, 0.45, M.white, h - 0.1))
  addM(g, B_(bw * 0.62, bl * 0.55, 0.2, new THREE.MeshStandardMaterial({ color: 0xcfc9bd, roughness: 0.6 }), h + 0.35))
  // dark side-groove band at mid height
  addM(g, B_(bw + 0.15, bl + 0.15, 1.3, M.darkGray, h * 0.3))
  // pin tabs along the two long edges
  const n = Math.max(2, Math.round(sx / 4.5))
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : -0.75 + (1.5 * i) / (n - 1)
    if (alongX) {
      addM(g, pin(1.6, 1.2, 2.4).translateX(t * bw * 0.85).translateY(bl / 2))
      addM(g, pin(1.6, 1.2, 2.4).translateX(t * bw * 0.85).translateY(-bl / 2))
    } else {
      addM(g, pin(1.2, 1.6, 2.4).translateX(bw / 2).translateY(t * bl * 0.85))
      addM(g, pin(1.2, 1.6, 2.4).translateX(-bw / 2).translateY(t * bl * 0.85))
    }
  }
}

function buildUsbTypeC(g: THREE.Group, _c: BoardComp, _L: LocalFrame): void {
  // Pill-shaped metal shroud + black inner body + gold solder tabs at ±x edges
  addM(g, new THREE.Mesh(new RoundedBoxGeometry(9.2, 7.5, 3.0, 4, 1.3), M.silver).translateZ(1.5))
  addM(g, B_(8.0, 6.4, 2.4, M.black, 0.6))
  addM(g, B_(1.2, 7.5, 0.8, M.gold).translateX(-4.0))
  addM(g, B_(1.2, 7.5, 0.8, M.gold).translateX(4.0))
}

function buildTfCard(g: THREE.Group, _c: BoardComp, _L: LocalFrame): void {
  // Compact micro-SD / TF card reader: metal shell, dark slot, gold contacts, eject nub
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 0.85, roughness: 0.4 })
  addM(g, B_(23, 11, 4.6, shellMat))
  addM(g, B_(19, 7.5, 0.4, new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.85 }), 4.6))
  addM(g, B_(3.2, 6.5, 0.3, M.gold).translateX(-6.5).translateZ(4.4))
  addM(g, B_(1.6, 8, 0.6, M.darkGray).translateX(10.2).translateZ(4.6))
}

function buildStandoff(g: THREE.Group, _c: BoardComp, _L: LocalFrame): void {
  // Steel standoff: cylinder + hex head on top
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 3, 14), M.steel)
  cyl.position.z = 1.5
  addM(g, cyl)
  const head = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 1.2, 6), M.steel)
  head.position.z = 3.6
  addM(g, head)
}

function buildElcoCap(g: THREE.Group, c: BoardComp, _L: LocalFrame): void {
  // Electrolytic cap: black cylinder + polarity band + silver dome with vent scores
  const xm = parseXMM(c.fp)
  const d = xm ? xm[0] : 6.3
  const h = xm ? xm[1] : 7
  const r = d / 2
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), M.black)
  body.position.z = h / 2
  addM(g, body)
  // polarity band — partial cylinder shell on one side
  const bandMat = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.5 })
  const band = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.01, r + 0.01, h, 24, 1, true, -0.5, 1.0), bandMat)
  band.position.z = h / 2
  addM(g, band)
  // silver top disc + squashed-sphere dome
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.35, 24), M.silver)
  disc.position.z = h + 0.17
  addM(g, disc)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.silver)
  dome.scale.set(1, 0.28, 1)
  dome.position.z = h + 0.2
  addM(g, dome)
  // two thin vent score lines on the dome
  const scoreMat = new THREE.MeshStandardMaterial({ color: 0x7d838b, roughness: 0.4 })
  for (let i = 0; i < 2; i++) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(d * 0.92, 0.18, 0.12), scoreMat)
    line.position.z = h + r * 0.24
    line.rotation.z = (i * Math.PI) / 2
    addM(g, line)
  }
}

function buildTactSwitch(g: THREE.Group, _c: BoardComp, L: LocalFrame): void {
  // Tact button: silver base plate + black square button
  const sx = spanX(L.bbox), sy = spanY(L.bbox)
  const bw = Math.max(sx, 4.5), bl = Math.max(sy, 4.5)
  addM(g, B_(bw, bl, 1.2, M.silver))
  addM(g, B_(Math.min(4, bw * 0.75), Math.min(5, bl * 0.85), 2.6, M.black, 1.2))
}

function buildFpc(g: THREE.Group, _c: BoardComp, L: LocalFrame): void {
  // FPC/FFC connector: dark-gray body + black actuator bar on top
  const sx = spanX(L.bbox), sy = spanY(L.bbox)
  const bw = Math.max(sx + 1.5, 8), bl = Math.max(sy + 1.5, 6)
  addM(g, B_(bw, bl, 4.5, M.darkGray))
  addM(g, B_(bw * 0.9, 2, 1.0, M.black, 3.8).translateY(bl * 0.28))
}

function buildDcJack(g: THREE.Group, _c: BoardComp, _L: LocalFrame): void {
  // DC barrel jack: black body + silver center pin ring
  addM(g, B_(8, 5.5, 4.5, M.black))
  addM(g, B_(3, 3, 1.0, M.silver, 4.5))
}

function buildTo92(g: THREE.Group, c: BoardComp, _L: LocalFrame): void {
  // TO-92: black half-cylinder-ish body + silver fin disc on top
  const lw = parseLW(c.fp)
  const bw = lw ? lw[0] : 4.9
  const bl = lw ? lw[1] : 3.7
  addM(g, B_(bw, bl, 3.0, M.black))
  const fin = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(bw, bl) * 0.52, Math.min(bw, bl) * 0.52, 0.6, 16), M.silver)
  fin.rotation.x = Math.PI / 2
  fin.position.set(0, 0, 3.3)
  addM(g, fin)
}

function buildSot23(g: THREE.Group, c: BoardComp, _L: LocalFrame): void {
  // SOT-23: tiny black body + 3 thin gull pins (2 one side, 1 other)
  const lw = parseLW(c.fp)
  const bw = lw ? lw[0] : 2.9
  const bl = lw ? lw[1] : 1.3
  addM(g, B_(bw, bl, 1.0, M.black))
  addM(g, pin(bw * 0.9, 0.5, 0.3).translateY(bl / 2 + 0.35))
  addM(g, pin(bw * 0.9, 0.5, 0.3).translateY(-bl / 2 - 0.35))
}

// Gull-wing IC: black body from L/W (or pad-bbox inset), pin rows on the two
// long sides, silver pin-1 dot at one corner. If pads cluster on all four
// sides it's a QFP → delegate to buildQfn.
function buildIc(g: THREE.Group, c: BoardComp, L: LocalFrame): void {
  const lw = parseLW(c.fp)
  const bw = lw ? lw[0] : spanX(L.bbox) * 0.85
  const bl = lw ? lw[1] : spanY(L.bbox) * 0.85
  const h = 1.5
  // detect 4-side pad clusters → QFP
  const xs = L.pads.map((p) => p.x), ys = L.pads.map((p) => p.y)
  const fourSides = L.pads.length >= 8 &&
    xs.some((x) => x < -bw * 0.25) && xs.some((x) => x > bw * 0.25) &&
    ys.some((y) => y < -bl * 0.25) && ys.some((y) => y > bl * 0.25)
  if (fourSides) { buildQfn(g, c, L); return }

  addM(g, B_(bw, bl, h, M.black))
  const nSide = Math.max(1, Math.floor(L.pads.length / 2))
  for (let i = 0; i < nSide; i++) {
    const t = nSide === 1 ? 0 : -0.85 + (1.7 * i) / (nSide - 1)
    addM(g, pin(0.45, 0.9, 0.35).translateX(t * bw * 0.42).translateY(bl / 2 + 0.3))
    addM(g, pin(0.45, 0.9, 0.35).translateX(t * bw * 0.42).translateY(-bl / 2 - 0.3))
  }
  // silver pin-1 dot at one corner
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 12), M.silver)
  dot.position.set(-bw / 2 + 0.8, -bl / 2 + 0.8, h)
  addM(g, dot)
}

function buildQfn(g: THREE.Group, c: BoardComp, L: LocalFrame): void {
  // Flat square-ish IC: black body, pins/pads on 4 sides (QFP) or just body+dot (QFN/BGA)
  const lw = parseLW(c.fp)
  const bw = lw ? lw[0] : spanX(L.bbox) * 0.85
  const bl = lw ? lw[1] : spanY(L.bbox) * 0.85
  const h = 1.0
  addM(g, B_(bw, bl, h, M.black))
  const isQfp = /QFP/.test(c.fp)
  if (isQfp) {
    const nSide = Math.max(1, Math.floor(L.pads.length / 4))
    for (let i = 0; i < nSide; i++) {
      const t = nSide === 1 ? 0 : -0.85 + (1.7 * i) / (nSide - 1)
      addM(g, pin(0.45, 0.9, 0.3).translateX(t * bw * 0.42).translateY(bl / 2 + 0.3))
      addM(g, pin(0.45, 0.9, 0.3).translateX(t * bw * 0.42).translateY(-bl / 2 - 0.3))
      addM(g, pin(0.9, 0.45, 0.3).translateX(bw / 2 + 0.3).translateY(t * bl * 0.42))
      addM(g, pin(0.9, 0.45, 0.3).translateX(-bw / 2 - 0.3).translateY(t * bl * 0.42))
    }
  }
  const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.1, 12), M.silver)
  dot.position.set(-bw / 2 + 0.8, -bl / 2 + 0.8, h)
  addM(g, dot)
}

function buildDiode(g: THREE.Group, c: BoardComp, _L: LocalFrame): void {
  // SMB/SMC/SMA/SOD: black body from L/W, silver end caps, cathode band at one end
  const lw = parseLW(c.fp)
  const bw = lw ? lw[0] : 4.6
  const bl = lw ? lw[1] : 3.6
  const h = 2.2
  addM(g, B_(bw, bl, h, M.black))
  addM(g, B_(0.8, bl + 0.1, h + 0.1, M.silver).translateX(-bw / 2 + 0.4))
  addM(g, B_(0.5, bl * 0.96, h * 0.98, new THREE.MeshStandardMaterial({ color: 0x8a8f97, roughness: 0.5 })).translateX(bw / 2 - 1.0))
}

function buildLed(g: THREE.Group, c: BoardComp, L: LocalFrame): void {
  // Small chip LED: amber emissive body from imperial code or pad span
  const imp = parseImperial(c.fp)
  let bw = imp ? imp[0] : null
  let bl = imp ? imp[1] : null
  if (bw == null || bl == null) {
    bw = Math.max(spanX(L.bbox), 1.6)
    bl = Math.max(spanY(L.bbox), 1.0)
  }
  addM(g, B_(bw, bl, 1.2, M.amber))
}

function buildInductor(g: THREE.Group, c: BoardComp, L: LocalFrame): void {
  // Inductor: dark-gray body + silver wrap ends
  const lw = parseLW(c.fp)
  let bw = lw ? lw[0] : null
  let bl = lw ? lw[1] : null
  if (bw == null || bl == null) {
    const imp = parseImperial(c.fp)
    if (imp) { bw = imp[0]; bl = imp[1] }
    else { bw = Math.max(spanX(L.bbox), 3); bl = Math.max(spanY(L.bbox), 2.5) }
  }
  addM(g, B_(bw, bl, 2.5, M.darkGray))
  addM(g, B_(bw * 0.82, bl * 0.82, 0.3, M.silver, 2.5))
}

// Classic two-pad SMD chip: silver end caps + center body, color by ref prefix.
function buildChip(g: THREE.Group, c: BoardComp, L: LocalFrame, idx: number): void {
  const ref = (c.ref || '').toUpperCase()
  let mat: THREE.Material = M.black
  let h = 0.55
  if (ref.startsWith('C')) { mat = rnd(idx) < 0.65 ? M.tan : M.blueCap; h = 0.8 }
  else if (ref.startsWith('L')) { mat = M.darkGray; h = 0.8 }
  else if (ref.startsWith('D') || ref.startsWith('FB') || ref.startsWith('F')) { mat = M.black; h = 1.0 }

  const imp = parseImperial(c.fp)
  let bw: number, bl: number
  if (imp) { bw = imp[0]; bl = imp[1] }
  else {
    // local pad span minus ~30% of a typical pad width
    const pw = L.pads.length ? Math.max(...L.pads.map((p) => p.w)) : 1.2
    bw = Math.max(spanX(L.bbox) + pw * 0.7, 1.6)
    bl = Math.max(spanY(L.bbox) + pw * 0.5, 0.9)
  }
  const capW = clamp(bw * 0.28, 0.3, 1.2)
  addM(g, B_(capW, bl, h, M.silver).translateX(-bw / 2 + capW / 2))
  addM(g, B_(capW, bl, h, M.silver).translateX(bw / 2 - capW / 2))
  addM(g, B_(bw - capW * 1.6, bl, h, mat))
}

// TH connectors: inline (one line of pads) or two-row box, gold pin stubs on top.
function buildThConnector(g: THREE.Group, c: BoardComp, L: LocalFrame): void {
  const pitch = parsePitch(c.fp) || 2.54
  const sx = spanX(L.bbox), sy = spanY(L.bbox)
  const h = pitch >= 5 ? 7 : pitch >= 2.5 ? 6 : 3.5

  // one line? (all pads share the same axis within tolerance)
  const xs = L.pads.map((p) => p.x), ys = L.pads.map((p) => p.y)
  const xTol = Math.max(1.2, pitch * 0.45), yTol = Math.max(1.2, pitch * 0.45)
  const inlineX = Math.max(...ys) - Math.min(...ys) <= yTol // pads along X line
  const inlineY = Math.max(...xs) - Math.min(...xs) <= xTol // pads along Y line

  if (inlineX || inlineY) {
    const alongX = inlineX
    const span = alongX ? sx : sy
    const bw = alongX ? span + pitch : pitch * 0.9
    const bl = alongX ? pitch * 0.9 : span + pitch
    addM(g, B_(bw, bl, h, M.darkGray))
    for (const p of L.pads) {
      if (alongX) addM(g, pin(1.2, 1.2, 0.8, M.gold, h).translateX(p.x - L.cx))
      else addM(g, pin(1.2, 1.2, 0.8, M.gold, h).translateY(p.y - L.cy))
    }
  } else {
    // two rows → box spanning both rows with two pin rows
    const bw = sx + pitch * 0.9
    const bl = sy + pitch * 0.9
    addM(g, B_(bw, bl, h, M.darkGray))
    for (const p of L.pads) {
      addM(g, pin(1.2, 1.2, 0.8, M.gold, h).translateX(p.x - L.cx).translateY(p.y - L.cy))
    }
  }
}

function buildFallback(g: THREE.Group, _c: BoardComp, L: LocalFrame): void {
  const bw = Math.max(spanX(L.bbox), 1.2)
  const bl = Math.max(spanY(L.bbox), 1.2)
  const np = L.pads.length
  if (np > 8 && (bw > 10 || bl > 10)) {
    // Large multi-pad footprint with no specific template (board-to-board connector,
    // module socket, M.2, etc.): a hollow perimeter housing + gold contacts reads as
    // a real connector — a solid slab this big looks wrong and covers the board.
    const rail = Math.min(1.6, bw * 0.12, bl * 0.12)
    const h = Math.min(4, 1.6 + np * 0.02)
    addM(g, B_(bw, rail, h, M.darkGray).translateY(bl / 2 - rail / 2))
    addM(g, B_(bw, rail, h, M.darkGray).translateY(-bl / 2 + rail / 2))
    addM(g, B_(rail, bl - 2 * rail, h, M.darkGray).translateX(bw / 2 - rail / 2))
    addM(g, B_(rail, bl - 2 * rail, h, M.darkGray).translateX(-bw / 2 + rail / 2))
    for (const p of L.pads.slice(0, 48)) {
      addM(g, pin(Math.min((p.w || 1) * 0.8, 1.2), Math.min((p.l || 1) * 0.8, 1.2), 0.5, M.gold, 0).translateX(p.x - L.cx).translateY(p.y - L.cy))
    }
  } else {
    addM(g, B_(bw, bl, 1.0, M.darkGray))
  }
}

// ---------- dispatch ----------

function addM(g: THREE.Group, m: THREE.Object3D): THREE.Object3D { g.add(m); return m }

export function buildComponent(c: BoardComp, idx = 0): THREE.Group {
  const g = new THREE.Group()
  const L = toLocal(c)
  const fp = c.fp || ''
  const ref = (c.ref || '').toUpperCase()

  if (/^WIFIM|ESP-WROOM|WROOM/.test(fp)) buildWifi(g, c, L)
  else if (/^RELAY/.test(fp)) buildRelay(g, c, L)
  else if (/USB_TYPE-C|USB_C|USB-C/.test(fp)) buildUsbTypeC(g, c, L)
  else if (/TF-SMD|TF-CARD|MicroSD/.test(fp)) buildTfCard(g, c, L)
  else if (/^M2|^M3|螺丝|MountingHole|Standoff/.test(fp)) buildStandoff(g, c, L)
  else if (/C_Ele|CP_Radial|Elco/.test(fp)) buildElcoCap(g, c, L)
  else if (/Key_SMD|^SW_|^KEY|Tact/.test(fp)) buildTactSwitch(g, c, L)
  else if (/FPC|FFC/.test(fp)) buildFpc(g, c, L)
  else if (/DC-005|DC_JACK|Barrel/.test(fp)) buildDcJack(g, c, L)
  else if (/TO-92/.test(fp)) buildTo92(g, c, L)
  else if (/SOT-23/.test(fp)) buildSot23(g, c, L)
  else if (/SOP|SOIC|SSOP|TSSOP|MSOP|ESOP|SOT-223|DIP|SOJ/.test(fp)) buildIc(g, c, L)
  else if (/QFN|QFP|LQFP|TQFP|DFN|BGA/.test(fp)) buildQfn(g, c, L)
  else if (/SMB|SMC|SMA|SOD|DO-214/.test(fp)) buildDiode(g, c, L)
  else if (/^LED|^LD/.test(ref) || /LED/.test(fp)) buildLed(g, c, L)
  else if (/IND|^L_|^L0/.test(fp) || /^L\d/.test(ref)) buildInductor(g, c, L)
  else if (/^(R|C|L|D|FB|F)\d/.test(ref) || parseImperial(fp)) buildChip(g, c, L, idx)
  else if (/CONN|^WJ|^HX|TerminalBlock|PinHeader|Header|JST|^XH|^PH/.test(fp)) buildThConnector(g, c, L)
  else buildFallback(g, c, L)

  // Bottom-side parts hang below the board: flip built geometry so it extends
  // downward. Mesh z-positions negate (pivot at the pad plane z=0, NOT the
  // anchor) and each mesh is rotated 180° about its own X so tops face down.
  // XY is untouched — pad positions use the same absolute mapping as top parts.
  if (c.layer === 'B.Cu') {
    for (const ch of g.children) { ch.position.z = -ch.position.z; ch.rotation.x += Math.PI }
  }

  // Re-center on the pad centroid: many footprints (connectors, modules, board-edge
  // parts) have their anchor far from the pad cluster. Templates build around the
  // anchor (local origin), so without this the 3D body floats off its pads — the
  // "big black boxes hanging off the board" bug. Shifting every child by the local
  // pad-bbox center puts bodies on their pads; pins built at (p - L.c) land exactly
  // on their pads too.
  if (Math.abs(L.cx) > 1e-6 || Math.abs(L.cy) > 1e-6) {
    for (const ch of g.children) { ch.position.x += L.cx; ch.position.y += L.cy }
  }

  // bounding dims in local frame (for the caller's explode-lift height)
  const box = new THREE.Box3().setFromObject(g)
  const size = box.getSize(new THREE.Vector3())
  g.userData = { w: Math.max(size.x, 0.1), l: Math.max(size.y, 0.1), h: Math.max(size.z, 0.1) }

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true } })
  return g
}
