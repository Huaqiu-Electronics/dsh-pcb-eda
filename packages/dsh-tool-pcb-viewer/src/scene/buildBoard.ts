// ---------------------------------------------------------------------------
// buildBoard.ts — build an animated, explodable 3D board from PARSED KiCad data.
// Fully data-driven: arbitrary Edge.Cuts outline, N copper layers, real traces.
//   const board = parseKicad(text)
//   const b = buildBoard(board)   // → { group, update(u, speed), boardW, boardH, comps, bbox, dispose() }
// ---------------------------------------------------------------------------
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { M, grain } from './materials.js'
import { buildComponent } from './components.js'
import { makeBoardTextures } from './textures.js'
import { outlineParts } from '../pcb/outline.js'
import type { BoardModel, OutlineSeg } from '../model.js'

/** A 2D point in board millimetres (tuple so it round-trips through mirroring). */
type Pt = [number, number]

/** One sheet of the physical layer stack, before it becomes a mesh. */
type SheetKind = 'mask' | 'copper' | 'fr4' | 'inner'
interface Sheet {
  id: string
  t: number
  kind: SheetKind
  tex?: THREE.Texture | null
}
/** The resolved sheet plus the mesh it produced: z/ex/delay are all assigned here. */
interface LayerObj extends Sheet {
  mesh: THREE.Mesh
  baseZ: number
  z: number
  ex: number
  delay: number
}
/** Per-component animation state, keys mirrored from buildComponent's userData. */
interface CompEntry {
  g: THREE.Object3D
  hx: number
  hy: number
  baseZ: number
  qBase: THREE.Quaternion
  lift: number
  trigger: number
  tiltAxis: THREE.Vector3
  tiltMax: number
  ref: string
}
/** The runtime board handle returned by buildBoard. */
export interface BuiltBoard {
  group: THREE.Group
  update(u: number, speed: number): void
  boardW: number
  boardH: number
  comps: CompEntry[]
  bbox: BoardModel['bbox']
  layerCount: number
  dispose(): void
}

// deterministic pseudo-random + easing
function rnd(i: number, salt = 0): number { const x = Math.sin(i * 127.1 + salt * 311.7 + 13.7) * 43758.5453; return x - Math.floor(x) }
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const smooth = (v: number): number => { v = clamp01(v); return v * v * (3 - 2 * v) }
const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3)
const easeInOutCubic = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

// Keep the arc's `m` only when present — the typed counterpart of the original
// `...(o.m ? { m: [...] } : {})`.
function withMid(
  line: { type: 'line'; a: Pt; b: Pt },
  arc: { type: 'arc'; a: Pt; m: Pt; b: Pt } | null,
): OutlineSeg {
  if (!arc) return { ...line, type: 'line' }
  const { m, ...rest } = arc
  return { ...rest, type: 'arc', m }
}

// Mirror a parsed board across the X axis (y → −y), rotations reversed.
function mirrorY(b: BoardModel): BoardModel {
  const fy = (y: number) => -y
  return {
    ...b,
    bbox: { x0: b.bbox.x0, y0: -b.bbox.y1, x1: b.bbox.x1, y1: -b.bbox.y0 },
    // The `o.type === 'arc'` test narrows the union, so `o.m` reads exactly where
    // the original read it; `withMid` is the typed `...(o.m ? { m: [...] } : {})`
    // (so `m` enters the object only when the segment actually carries one).
    // (each `o` is narrowed to a discriminated local first — a `{...o}` spread
    // widens the discriminant, so the branches need their literal type spelled out)
    outline: (b.outline || []).map((o): OutlineSeg => {
      if (o.type === 'circle') return { ...o, type: 'circle', c: [o.c[0], fy(o.c[1])] as Pt }
      const a = [o.a[0], fy(o.a[1])] as Pt, b = [o.b[0], fy(o.b[1])] as Pt
      return o.type === 'arc' ? withMid({ ...o, type: 'line', a, b }, { ...o, type: 'arc', a, b, m: [o.m[0], fy(o.m[1])] as Pt })
        : withMid({ ...o, type: 'line', a, b }, null)
    }),
    comps: b.comps.map((c) => ({
      ...c, y: fy(c.y), rot: -c.rot,
      pads: c.pads.map((p) => ({ ...p, y: fy(p.y) })),
    })),
    traces: b.traces.map((t) => ({ ...t, pts: t.pts.map(([x, y]): Pt => [x, fy(y)]) })),
    zones: b.zones.map((z) => ({ ...z, pts: z.pts.map(([x, y]): Pt => [x, fy(y)]) })),
    vias: b.vias.map((v) => ({ ...v, y: fy(v.y) })),
    texts: (b.texts || []).map((t) => ({ ...t, y: fy(t.y), rot: -(t.rot || 0) })),
  }
}

export function buildBoard(board: BoardModel, opts: { textures?: boolean } = {}): BuiltBoard {
  // Mirror the whole model in Y before building. KiCad's +y points DOWN (screen
  // coords); this pipeline maps +y to the scene's far side (screen-up), which
  // renders the board upside-down vs KiCad's front view (verified against
  // `kicad-cli pcb render`). Pre-mirroring makes the render match KiCad exactly
  // while keeping every downstream transform proper and self-consistent
  // (components still land on pads — everything mirrors together).
  board = mirrorY(board)
  const B = board.bbox
  const W = B.x1 - B.x0, H = B.y1 - B.y0
  const CX = (B.x0 + B.x1) / 2, CY = (B.y0 + B.y1) / 2

  const group = new THREE.Group()
  const disposables: { dispose?: () => void }[] = []
  const track = <T extends { dispose?: () => void }>(...objs: T[]): T => { disposables.push(...objs); return objs[0] as T }

  // ---------- outline shape ----------
  const parts = outlineParts(board)
  const poly = parts.ring
  const shape = new THREE.Shape()
  poly.forEach((p, i) => { const x = p[0] - CX, y = p[1] - CY; if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y) })
  shape.closePath()
  // Edge.Cuts circles → real holes in the extruded/filled board shape.
  for (const h of parts.holes) {
    if (h.length < 3) continue
    const hp = new THREE.Path()
    h.forEach((p, i) => { const x = p[0] - CX, y = p[1] - CY; if (i === 0) hp.moveTo(x, y); else hp.lineTo(x, y) })
    hp.closePath()
    shape.holes.push(hp)
  }

  // planar UVs matching the texture mapping: u=(x-x0)/W, v=(y1-y)/H
  function planarUV<T extends THREE.BufferGeometry>(geo: T): T {
    const pos = geo.attributes.position as THREE.BufferAttribute
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + CX, wy = pos.getY(i) + CY
      uv[i * 2] = (wx - B.x0) / W
      uv[i * 2 + 1] = (B.y1 - wy) / H
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    return geo
  }

  // ---------- textures ----------
  // opts.textures === false：轻量档 —— 纯色材质，跳过全部 canvas 纹理绘制
  // （大板的 1.5s 建模成本主要在纹理上；缩略图/预渲染用它几乎零成本）。
  const T = opts.textures === false ? null : makeBoardTextures(board)

  // ---------- copper energize shader (uBrushX/uEnergy), shared by outer copper ----------
  const brushUniforms = { uBrushX: { value: 0 }, uEnergy: { value: 0 } }
  function copperMat(tex: THREE.Texture | null | undefined): THREE.MeshStandardMaterial {
    if (!tex) return new THREE.MeshStandardMaterial({ color: 0xa9682f, metalness: 0.8, roughness: 0.45, side: THREE.DoubleSide })
    const mat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0.78, roughness: 0.42, side: THREE.DoubleSide })
    mat.onBeforeCompile = (sh: THREE.WebGLProgramParametersWithUniforms) => {
      sh.uniforms.uBrushX = brushUniforms.uBrushX
      sh.uniforms.uEnergy = brushUniforms.uEnergy
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vLocalX;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalX = (modelMatrix * vec4(position, 1.0)).x;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vLocalX;\nuniform float uBrushX;\nuniform float uEnergy;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float d = vLocalX - uBrushX;
            float band = exp(-d * d * 0.0035);
            float behind = smoothstep(6.0, -4.0, d);
            totalEmissiveRadiance += vec3(0.22, 0.7, 0.62) * (band * 1.1 + behind * 0.28) * uEnergy;
          }`)
    }
    return mat
  }
  function maskMat(tex: THREE.Texture | null | undefined): THREE.MeshPhysicalMaterial {
    if (!tex) return new THREE.MeshPhysicalMaterial({ color: 0x0f5e30, roughness: 0.5, roughnessMap: grain, metalness: 0.0, clearcoat: 0.55, clearcoatRoughness: 0.32, side: THREE.DoubleSide })
    return new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.5, roughnessMap: grain, metalness: 0.0, clearcoat: 0.55, clearcoatRoughness: 0.32, side: THREE.DoubleSide })
  }

  // ---------- layer stack (2 masks + n copper + (n-1) FR4 cores), total 1.6mm ----------
  const cu = board.cuLayers // ['F.Cu', ...inners..., 'B.Cu'] top→bottom
  const n = cu.length
  const MASK_T = 0.15, CU_T = 0.09, CU_IN_T = 0.06
  const fr4Total = Math.max(0.4, 1.6 - 2 * MASK_T - CU_T * 2 - CU_IN_T * Math.max(0, n - 2))
  const coreT = fr4Total / Math.max(1, n - 1)

  // build sheets top→bottom: mask, cu(F), [core, cu(In_i)]..., core, cu(B), mask
  const sheets: Sheet[] = []
  sheets.push({ id: 'fmask', t: MASK_T, kind: 'mask', tex: T ? T.maskTop : null })
  sheets.push({ id: 'F.Cu', t: CU_T, kind: 'copper', tex: T ? T.copperTop : null })
  for (let i = 1; i < n - 1; i++) {
    sheets.push({ id: 'core' + i, t: coreT, kind: 'fr4' })
    sheets.push({ id: cu[i] as string, t: CU_IN_T, kind: 'inner', tex: (T && T.inner.get(cu[i] as string)) || null })
  }
  sheets.push({ id: 'coreB', t: coreT, kind: 'fr4' })
  sheets.push({ id: 'B.Cu', t: CU_T, kind: 'copper', tex: T ? T.copperBot : null })
  sheets.push({ id: 'bmask', t: MASK_T, kind: 'mask', tex: T ? T.maskBot : null })

  // assign z so the stack is centered on z=0 (top surface at +0.8)
  // (z/ex/delay live on LayerObj, built below — the mesh loop needs them anyway)
  let zc = 0.8
  const zs: number[] = []
  for (const s of sheets) { zs.push(zc - s.t / 2); zc -= s.t }

  // explode offsets: middle sheet stays, spacing grows outward; stagger delays inward
  const mid = (sheets.length - 1) / 2
  const exs: number[] = []
  const delays: number[] = []
  sheets.forEach((s, k) => {
    exs.push((k - mid) * 9)
    delays.push((1 - Math.abs(k - mid) / mid) * 0.18)
  })

  const layerObjs: LayerObj[] = []
  for (let si = 0; si < sheets.length; si++) {
    const s = sheets[si] as Sheet
    const sz = zs[si] as number, sex = exs[si] as number, sdelay = delays[si] as number
    let mesh: THREE.Mesh
    let mat: THREE.Material
    if (s.kind === 'fr4') {
      const geo = track(new THREE.ExtrudeGeometry(shape, { depth: s.t, bevelEnabled: false }))
      mesh = new THREE.Mesh(geo, M.fr4)
      mesh.position.z = sz - s.t / 2 // extrude goes +z from shape plane
    } else {
      const geo = track(planarUV(new THREE.ShapeGeometry(shape, 4)))
      const tex = s.tex
      const m = s.kind === 'mask' ? maskMat(tex) : s.kind === 'copper' ? copperMat(tex)
        : (tex
          ? new THREE.MeshStandardMaterial({ map: tex, metalness: 0.55, roughness: 0.5, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: 0x8a5a28, metalness: 0.55, roughness: 0.5, side: THREE.DoubleSide }))
      track(m)
      mat = m
      mesh = new THREE.Mesh(geo, mat)
      mesh.position.z = sz + (s.kind === 'mask' ? (s.id === 'fmask' ? s.t / 2 : -s.t / 2) : 0)
    }
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    layerObjs.push({ ...s, z: sz, ex: sex, delay: sdelay, mesh, baseZ: mesh.position.z })
  }

  // ---------- components ----------
  const comps: CompEntry[] = []
  board.comps.forEach((c, i) => {
    let g: THREE.Object3D
    try { g = buildComponent(c, i) } catch (e) { console.warn('component build failed', c.ref, e); return }
    const isBot = c.layer === 'B.Cu'
    const hx = c.x - CX
    const hy = c.y - CY
    // Bottom parts hang below the board. Pads are absolute, so the XY mapping is
    // IDENTICAL to top parts — never mirror positions about the anchor (a PI flip
    // through the anchor flings offset-anchor parts, like the CM5 bottom modules,
    // clear off the board). We simply hang the body below and drop it downward on explode.
    const ud = (g.userData || {}) as { h?: number; w?: number; l?: number }
    const bodyH = ud.h || 2
    const baseZ = isBot ? -(0.82 + bodyH) : 0.82
    g.position.set(hx, hy, baseZ)
    const qBase = new THREE.Quaternion()
    qBase.setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(c.rot), 'XYZ'))
    g.quaternion.copy(qBase)

    const size = Math.max(ud.w || 2, ud.l || 2)
    const lift = (isBot ? -1 : 1) * (40 + size * 0.55 + rnd(i, 6) * 7)
    const trigger = clamp01(0.02 + 0.86 * ((hx + W / 2) / W) + (rnd(i, 8) - 0.5) * 0.06)
    const tiltAxis = new THREE.Vector3(rnd(i, 11) - 0.5, rnd(i, 12) - 0.5, 0).normalize()
    const tiltMax = (rnd(i, 14) - 0.5) * 0.22

    group.add(g)
    comps.push({ g, hx, hy, baseZ, qBase, lift, trigger, tiltAxis, tiltMax, ref: c.ref })
  })

  // ---------- vias ----------
  let vias: THREE.InstancedMesh | null = null
  if (board.vias.length) {
    const viaGeo = track(new THREE.CylinderGeometry(0.32, 0.32, 1, 8))
    viaGeo.rotateX(Math.PI / 2)
    vias = new THREE.InstancedMesh(viaGeo, M.via, board.vias.length)
    vias.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    group.add(vias)
  }

  // ---------- animation ----------
  const tmpQ = new THREE.Quaternion()
  const tmpM = new THREE.Matrix4()

  function update(u: number, speed: number) {
    const energy = smooth(clamp01(speed * 2.2)) * 0.9 + 0.08
    brushUniforms.uEnergy.value = energy
    brushUniforms.uBrushX.value = THREE.MathUtils.lerp(-W / 2 - 10, W / 2 + 10, u)

    for (const L of layerObjs) {
      const p = easeInOutCubic(clamp01((u - L.delay) / (1 - L.delay)))
      L.mesh.position.z = L.baseZ + L.ex * p
    }

    for (const c of comps) {
      const p = smooth(clamp01((u * 1.2 - c.trigger) / 0.35))
      const e = easeOutCubic(p)
      c.g.position.set(c.hx, c.hy, c.baseZ + c.lift * e)
      tmpQ.copy(c.qBase)
      if (e > 0.001 && Math.abs(c.tiltMax) > 0.001) {
        const q = new THREE.Quaternion().setFromAxisAngle(c.tiltAxis, c.tiltMax * e)
        tmpQ.multiply(q)
      }
      c.g.quaternion.copy(tmpQ)
    }

    if (vias) {
      const viaTop = 0.8, viaBot = -0.8
      const vh = Math.max(0.1, viaTop - viaBot)
      for (let i = 0; i < board.vias.length; i++) {
        const v = board.vias[i]
        if (!v) continue
        tmpM.makeScale(v.size / 0.64, v.size / 0.64, vh)
        tmpM.setPosition(v.x - CX, v.y - CY, (viaTop + viaBot) / 2)
        vias.setMatrixAt(i, tmpM)
      }
      vias.instanceMatrix.needsUpdate = true
      M.via.opacity = 1 - 0.85 * smooth(clamp01((u - 0.55) / 0.4))
    }
  }
  update(0, 0)

  function dispose() {
    for (const d of disposables) d.dispose && d.dispose()
    if (T) for (const t of [T.maskTop, T.maskBot, T.copperTop, T.copperBot, ...(T.inner ? [...T.inner.values()] : [])] as (THREE.Texture | null | undefined)[]) t && t.dispose && t.dispose()
    group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; m.geometry && m.geometry.dispose && m.geometry.dispose() } })
  }

  return { group, update, boardW: W, boardH: H, comps, bbox: B, layerCount: n, dispose }
}
