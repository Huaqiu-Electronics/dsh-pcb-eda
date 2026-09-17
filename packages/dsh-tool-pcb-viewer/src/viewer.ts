// ---------------------------------------------------------------------------
// viewer.ts — the whole product as a vanilla-JS, framework-free embeddable unit.
//
//   import { createViewer } from '@huaqiu/dsh-tool-pcb-viewer/viewer' (library use)
//   const v = createViewer(document.getElementById('app')!, { brand: 'HUAQIU · 华秋电路' })
//   v.loadBoard(pcbText, 'name.kicad_pcb'); v.setExplode(0.5); v.setDemo(true); v.dispose()
//
// Layout: left = 2D layout view (traces visible, KiCad-editor style),
//         right = 3D cinematic render (orbit / explode / auto-demo).
// No React, no build-step assumptions — plain ESM + three (peer dependency).
//
// Parsing goes through the published @huaqiu/kicad-sexpr-parser + ./adapter.js.
// ---------------------------------------------------------------------------
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { parseBoard } from './parse.js'
import { buildBoard, type BuiltBoard } from './scene/buildBoard.js'
import { outlineParts } from './pcb/outline.js'
import { create2DView } from './scene/view2d.js'
import DEMO_PCB from './assets/demo.js'

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

// 画质档位：后处理逐 pass 开关 + 像素比。大板自动降档（实测 SSAO 是最贵的 pass）。
interface Tier { ssao: boolean; bloom: boolean; bokeh: boolean; dpr: number }
const TIERS: Record<string, Tier> = {
  high: { ssao: true, bloom: true, bokeh: true, dpr: 2 },
  medium: { ssao: false, bloom: true, bokeh: false, dpr: 1.5 },
  low: { ssao: false, bloom: false, bokeh: false, dpr: 1 },
}
const TIER_ORDER = ['auto', 'high', 'medium', 'low'] as const
type QualityMode = (typeof TIER_ORDER)[number]

/** 按板子规模自动选档：器件越多越省。 */
function autoTier(compCount: number): string {
  if (compCount > 900) return 'low'
  if (compCount > 450) return 'medium'
  return 'high'
}
const easeLux = (p: number) => (p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2)

function demoCurve(t: number): number {
  const T = 20
  t = t % T
  if (t < 3) return 0
  if (t < 8.5) return easeLux((t - 3) / 5.5)
  if (t < 11.5) return 1
  if (t < 17) return 1 - easeLux((t - 11.5) / 5.5)
  return 0
}

function makeStudioEnv(): THREE.Scene {
  const s = new THREE.Scene()
  s.background = new THREE.Color(0x0a0c10)
  const panel = (w: number, h: number, color: number, intensity: number, pos: THREE.Vector3, look: THREE.Vector3) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }))
    m.position.copy(pos); m.lookAt(look); s.add(m)
  }
  const c = new THREE.Vector3(0, 0, 4)
  panel(150, 90, 0xffffff, 5.5, new THREE.Vector3(60, -70, 120), c)
  panel(120, 70, 0xbcd2ff, 2.4, new THREE.Vector3(-80, 90, 70), c)
  panel(200, 60, 0x4fd8c4, 1.5, new THREE.Vector3(-40, 30, -140), c)
  panel(300, 300, 0x1a2028, 0.7, new THREE.Vector3(0, 0, 220), c)
  return s
}

const GradeShader = {
  uniforms: { tDiffuse: { value: null as null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float l = luma(col);
      col *= mix(vec3(0.86,1.0,0.98), vec3(1.05,1.0,0.94), smoothstep(0.0, 0.7, l));
      vec2 d = vUv - 0.5;
      col *= mix(0.78, 1.0, smoothstep(1.0, 0.42, length(d) * 1.1));
      gl_FragColor = vec4(col, 1.0);
    }`,
}

const CSS = `
.k3v-root{position:relative;width:100%;height:100%;display:flex;background:#090b0f;overflow:hidden;font-family:ui-monospace,"SF Mono",Menlo,monospace}
.k3v-2d{width:38%;min-width:260px;border-right:1px solid rgba(95,224,205,.14);position:relative;background:#0b0e13}
.k3v-2d canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab}
.k3v-2d .k3v-pane-title{position:absolute;top:14px;left:16px;font-size:10px;letter-spacing:.3em;color:#5fe0cd;opacity:.75;pointer-events:none}
.k3v-3d{flex:1;position:relative}
.k3v-3d canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.k3v-hud{position:absolute;z-index:10;color:#eef2f6;user-select:none}
.k3v-brand{top:20px;left:24px;letter-spacing:.2em;font-size:13px;opacity:.92;pointer-events:none}
.k3v-brand b{color:#5fe0cd;font-weight:700;text-shadow:0 0 18px rgba(95,224,205,.35)}
.k3v-brand span{display:block;margin-top:4px;font-size:9px;letter-spacing:.3em;opacity:.5}
.k3v-ctrl{top:20px;right:24px;display:flex;align-items:center;gap:12px;font-size:11px;letter-spacing:.14em}
.k3v-bar{width:130px;height:2px;background:rgba(255,255,255,.12);position:relative;overflow:hidden}
.k3v-bar i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#3fb8a6,#5fe0cd);width:0%;box-shadow:0 0 10px rgba(95,224,205,.5)}
.k3v-demo{background:rgba(95,224,205,.05);border:1px solid rgba(95,224,205,.45);color:#5fe0cd;font:inherit;letter-spacing:.16em;padding:7px 12px;cursor:pointer;transition:all .2s;backdrop-filter:blur(4px)}
.k3v-demo:hover{background:rgba(95,224,205,.14);box-shadow:0 0 16px rgba(95,224,205,.25)}
.k3v-quality{background:rgba(95,224,205,.05);border:1px solid rgba(95,224,205,.3);color:#9fe8dc;font:inherit;letter-spacing:.12em;padding:7px 10px;cursor:pointer;transition:all .2s;backdrop-filter:blur(4px);min-width:120px}
.k3v-quality:hover{background:rgba(95,224,205,.14);color:#5fe0cd}
.k3v-openwrap{top:56px;right:24px;display:flex;align-items:center;gap:10px;font-size:10px;letter-spacing:.14em}
.k3v-bname{color:#9fb2c4;opacity:.8;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k3v-open{background:rgba(159,178,196,.06);border:1px solid rgba(159,178,196,.4);color:#cdd8e4;font:inherit;letter-spacing:.14em;padding:6px 10px;cursor:pointer;transition:all .2s;backdrop-filter:blur(4px)}
.k3v-open:hover{background:rgba(159,178,196,.16);border-color:#5fe0cd;color:#5fe0cd}
.k3v-sliderwrap{position:absolute;bottom:64px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;z-index:10;color:#eef2f6}
.k3v-sliderwrap label{font-size:9px;letter-spacing:.26em;opacity:.55}
.k3v-explode{-webkit-appearance:none;appearance:none;width:320px;height:2px;background:rgba(255,255,255,.14);outline:none;cursor:pointer}
.k3v-explode::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;background:#5fe0cd;box-shadow:0 0 12px rgba(95,224,205,.7);cursor:pointer}
.k3v-explode::-moz-range-thumb{width:13px;height:13px;border:none;border-radius:50%;background:#5fe0cd;box-shadow:0 0 12px rgba(95,224,205,.7);cursor:pointer}
.k3v-hint{bottom:24px;left:50%;transform:translateX(-50%);font-size:10px;letter-spacing:.14em;opacity:.6;transition:opacity .8s;white-space:nowrap;pointer-events:none}
.k3v-hint.k3v-dim{opacity:.2}
.k3v-caption{top:84px;left:50%;transform:translateX(-50%);font-size:11px;letter-spacing:.3em;opacity:0;transition:opacity .6s;color:#aef0e4;text-shadow:0 0 14px rgba(95,224,205,.3);pointer-events:none}
.k3v-corner{position:absolute;width:22px;height:22px;z-index:9;border:1px solid rgba(95,224,205,.3);pointer-events:none}
.k3v-c-tl{top:12px;left:12px;border-right:none;border-bottom:none}
.k3v-c-tr{top:12px;right:12px;border-left:none;border-bottom:none}
.k3v-c-bl{bottom:12px;left:12px;border-right:none;border-top:none}
.k3v-c-br{bottom:12px;right:12px;border-left:none;border-top:none}
.k3v-root.k3v-dropping::after{content:'DROP .KICAD_PCB TO RENDER';position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(9,11,15,.72);color:#5fe0cd;font-weight:700;font-size:17px;letter-spacing:.3em;border:2px dashed rgba(95,224,205,.6);pointer-events:none}
/* view modes: split (default) / 2d only / 3d only */
.k3v-root.k3v-mode-2d .k3v-3d{display:none}
.k3v-root.k3v-mode-2d .k3v-2d{width:100%;border-right:none}
.k3v-root.k3v-mode-3d .k3v-2d{display:none}
@media (max-width:900px){.k3v-root.k3v-mode-split .k3v-2d{display:none}}
`

let styleInjected = false
function injectStyle(): void {
  if (styleInjected || typeof document === 'undefined') return
  const el = document.createElement('style')
  el.setAttribute('data-k3v', '1')
  el.textContent = CSS
  document.head.appendChild(el)
  styleInjected = true
}

declare global {
  interface Window {
    __dbg?: Record<string, unknown>
    __PCB_TEXT__?: string
    __PCB_NAME__?: string
  }
}

/** Parse cache keyed by board identity — re-opening the same board (2D/3D switch,
 *  panel vs thumbnail) then skips the 1.3s parse on an 81MB file. */
const modelCache = new Map<string, ReturnType<typeof parseBoard>>()
const MODEL_CACHE_CAP = 6

function parseCached(text: string, key?: string) {
  if (!key) return parseBoard(text)
  const hit = modelCache.get(key)
  if (hit) return hit
  const model = parseBoard(text)
  if (modelCache.size >= MODEL_CACHE_CAP) {
    const oldest = modelCache.keys().next().value
    if (oldest !== undefined) modelCache.delete(oldest)
  }
  modelCache.set(key, model)
  return model
}

export interface ViewerOptions {
  /** stable identity for the board text — enables the parse cache */
  cacheKey?: string
  brand?: string
  brandSub?: string
  board?: string
  boardName?: string
  mode?: 'split' | '2d' | '3d'
  hud?: boolean
  post?: boolean
  interactive?: boolean
  textures?: boolean
  autoDemo?: boolean
  onError?: (e: unknown) => void
}

export type ViewMode = 'split' | '2d' | '3d'
type BoardHandle = BuiltBoard

export interface ViewerApi {
  loadBoard(text: string, name?: string): BoardHandle
  setExplode(v: number): void
  setDemo(on: boolean): void
  setMode(mode: ViewMode): ViewMode
  getMode(): ViewMode
  setQuality(mode: string): void
  getQuality(): { mode: string; tier: string }
  dispose(): void
}

export function createViewer(container: HTMLElement, opts: ViewerOptions = {}): ViewerApi {
  injectStyle()
  // 轻量模式：缩略图等场景用 —— 不建 HUD、不走后处理、不绑交互（省 GPU/CPU）
  const wantHud = opts.hud !== false
  const wantPost = opts.post !== false
  const wantInteractive = opts.interactive !== false
  const brand = opts.brand ?? 'HUAQIU · 华秋电路'
  const sub = opts.brandSub ?? 'PCB IRON-MAN DISASSEMBLY'

  container.classList.add('k3v-root-host')
  const root = document.createElement('div')
  const initialMode: ViewMode = opts.mode === '2d' || opts.mode === '3d' ? opts.mode : 'split'
  root.className = 'k3v-root k3v-mode-' + initialMode
  root.innerHTML = (wantHud ? `
    <div class="k3v-2d"><canvas class="k3v-2d-canvas"></canvas><div class="k3v-pane-title">2D LAYOUT · 走线视图</div></div>
    <div class="k3v-3d">
      <div class="k3v-hud k3v-brand"><b>${brand.split('·')[0]!.trim()}</b> · ${brand.split('·')[1]?.trim() ?? ''}<span>${sub}</span></div>
      <div class="k3v-hud k3v-ctrl">
        <button class="k3v-demo">▶ AUTO DEMO</button>
        <button class="k3v-quality" title="画质档位（点击循环：AUTO → HIGH → MEDIUM → LOW）">— FPS · AUTO</button>
        <div class="k3v-bar"><i></i></div><span class="k3v-pct">0%</span>
      </div>
      <div class="k3v-hud k3v-openwrap">
        <span class="k3v-bname"></span>
        <button class="k3v-open">＋ 打开 .KICAD_PCB</button>
        <input type="file" class="k3v-file" accept=".kicad_pcb" style="display:none" />
      </div>
      <div class="k3v-sliderwrap"><label>DISASSEMBLY</label><input type="range" class="k3v-explode" min="0" max="100" value="0" step="1" /></div>
      <div class="k3v-hud k3v-hint">拖拽旋转 · 滚轮/滑杆拆解 · 左图可缩放 — DRAG TO ORBIT · SCROLL TO DISASSEMBLE</div>
      <div class="k3v-hud k3v-caption"></div>
    </div>
    <div class="k3v-corner k3v-c-tl"></div><div class="k3v-corner k3v-c-tr"></div><div class="k3v-corner k3v-c-bl"></div><div class="k3v-corner k3v-c-br"></div>` : `
    <div class="k3v-2d"><canvas class="k3v-2d-canvas"></canvas></div>
    <div class="k3v-3d"></div>`)
  container.appendChild(root)

  const q = (sel: string) => root.querySelector(sel)
  const pane3d = q('.k3v-3d') as HTMLElement
  const canvas2d = q('.k3v-2d-canvas') as HTMLCanvasElement
  const demoBtn = q('.k3v-demo') as HTMLButtonElement | null
  const slider = q('.k3v-explode') as HTMLInputElement | null
  const uBar = q('.k3v-bar i') as HTMLElement | null
  const uPct = q('.k3v-pct') as HTMLElement | null
  const qualityBtn = q('.k3v-quality') as HTMLButtonElement | null
  const boardName = q('.k3v-bname') as HTMLElement | null
  const openBtn = q('.k3v-open') as HTMLButtonElement | null
  const fileInput = q('.k3v-file') as HTMLInputElement | null
  const hint = q('.k3v-hint') as HTMLElement | null
  const caption = q('.k3v-caption') as HTMLElement | null

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.32
  pane3d.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x090b0f)
  const fog = new THREE.Fog(0x090b0f, 360, 820)
  scene.fog = fog
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(makeStudioEnv(), 0.04).texture
  if ('environmentIntensity' in scene) scene.environmentIntensity = 1.0

  const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000)
  const target = new THREE.Vector3(0, -2, 7)
  const INIT = { theta: -0.14, phi: THREE.MathUtils.degToRad(38), radius: 205 }
  let theta = INIT.theta, phi = INIT.phi, radius = INIT.radius
  let tTheta = INIT.theta, tPhi = INIT.phi, tRadius = INIT.radius

  const hemi = new THREE.HemisphereLight(0x9fb2c4, 0x1a1f26, 0.95)
  scene.add(hemi)
  const key = new THREE.DirectionalLight(0xfff3e4, 1.6)
  key.position.set(90, -70, 140)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.radius = 6
  key.shadow.camera.left = -95; key.shadow.camera.right = 95
  key.shadow.camera.top = 95; key.shadow.camera.bottom = -95
  key.shadow.camera.far = 520
  key.shadow.bias = -0.0004
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.8); fill.position.set(-70, 90, 60); scene.add(fill)
  const rim = new THREE.DirectionalLight(0x4fd8c4, 0.45); rim.position.set(-130, 50, 20); scene.add(rim)
  const ground = new THREE.Mesh(new THREE.CircleGeometry(360, 72), new THREE.MeshStandardMaterial({ color: 0x232a33, roughness: 0.32, metalness: 0.5 }))
  ground.position.z = -1.6; ground.receiveShadow = true; scene.add(ground)

  // ---------- state ----------
  let u = 0, targetU = 0
  let dragging = false, lastX = 0, lastY = 0
  let velTheta = 0, velPhi = 0
  let demoMode = false, demoT = 0
  let movedBefore = false
  const clock = new THREE.Clock()
  let lastFps = 0
  let fpsFrames = 0
  let fpsT0 = 0

  const v2d = create2DView(canvas2d)

  // ---------- quality tiers ----------
  let qualityMode: QualityMode = 'auto'
  let activeTier = 'high'
  let qualityReady = false   // 后处理 pass 建好之前不能应用档位（TDZ）
  let ssao: SSAOPass | null = null
  let bloom: UnrealBloomPass | null = null
  let bokeh: BokehPass | null = null
  let composer: EffectComposer | null = null

  function applyTier(tier: string): void {
    activeTier = tier
    const t = TIERS[tier]!
    if (ssao) ssao.enabled = t.ssao
    if (bloom) bloom.enabled = t.bloom
    if (bokeh) bokeh.enabled = t.bokeh
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.dpr))
    onResize()
    if (qualityBtn) qualityBtn.textContent = (lastFps ? Math.round(lastFps) + ' FPS · ' : '') + qualityMode.toUpperCase()
  }
  function setQuality(mode: string): void {
    qualityMode = (TIER_ORDER as readonly string[]).includes(mode) ? mode as QualityMode : 'auto'
    applyTier(qualityMode === 'auto' ? autoTier(board?.comps?.length ?? 0) : qualityMode)
  }

  // ---------- board loading ----------
  let board: BoardHandle | null = null
  function loadBoard(text: string, name?: string | null): BoardHandle {
    const parsed = parseCached(text, opts.cacheKey)
    const nb = buildBoard(parsed, { textures: opts.textures !== false })
    if (board) { scene.remove(board.group); board.dispose() }
    board = nb
    scene.add(board.group)
    v2d.setBoard(parsed, outlineParts(parsed))
    if (typeof window !== 'undefined' && window.__dbg) window.__dbg.board = board
    const diag = Math.hypot(board.boardW, board.boardH)
    if (wantHud) {
      tRadius = radius = THREE.MathUtils.clamp(diag * 1.55, 90, 900)
    } else {
      // 缩略图：对准板面（target.z≈0）、更近，板子占满画面
      target.set(0, 0, Math.max(1.5, diag * 0.05))
      tRadius = radius = THREE.MathUtils.clamp(diag * 1.34, 60, 900)
      tPhi = phi = THREE.MathUtils.degToRad(48)
      tTheta = theta = -0.22
    }
    fog.near = diag * 3.2; fog.far = diag * 7.5
    camera.far = diag * 20; camera.updateProjectionMatrix()
    const s = diag * 0.75 + 20
    key.shadow.camera.left = -s; key.shadow.camera.right = s
    key.shadow.camera.top = s; key.shadow.camera.bottom = -s
    key.shadow.camera.far = diag * 4
    key.shadow.camera.updateProjectionMatrix()
    key.position.set(diag * 0.45, -diag * 0.35, diag * 0.7)
    ground.scale.setScalar(Math.max(1, diag / 230))
    if (boardName) boardName.textContent = name || ''
    u = 0; targetU = 0; movedBefore = false
    if (qualityReady) applyTier(qualityMode === 'auto' ? autoTier(board.comps?.length ?? 0) : qualityMode)
    return board
  }

  const winText = typeof window !== 'undefined' ? window.__PCB_TEXT__ : undefined
  const winName = typeof window !== 'undefined' ? window.__PCB_NAME__ : undefined
  const initialText = opts.board ?? winText ?? DEMO_PCB
  const initialName = opts.boardName ?? winName ?? 'ESP-MCB V1.0 · DEMO'
  const initialBoard = loadBoard(initialText, initialName)

  // ---------- post pipeline ----------
  if (wantPost) {
    composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    ssao = new SSAOPass(scene, camera, 1280, 720)
    ssao.kernelRadius = 30; ssao.minDistance = 0.015; ssao.maxDistance = 14
    composer.addPass(ssao)
    bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.22, 0.85, 0.9)
    composer.addPass(bloom)
    bokeh = new BokehPass(scene, camera, { focus: 0.0, aperture: 0.000015, maxblur: 0.0012 })
    composer.addPass(bokeh)
    composer.addPass(new ShaderPass(GradeShader as unknown as ConstructorParameters<typeof ShaderPass>[0]))
    composer.addPass(new OutputPass())
  }
  qualityReady = true
  applyTier(qualityMode === 'auto' ? autoTier(initialBoard.comps?.length ?? 0) : qualityMode)

  if (typeof window !== 'undefined') window.__dbg = { scene, camera, renderer, board, THREE, loadBoard: (t: string, n?: string) => loadBoard(t, n ?? 'custom'), parseKicad: (t: string) => parseBoard(t) }

  // ---------- interaction (3D pane) ----------
  const el = renderer.domElement
  el.style.touchAction = 'none'; el.style.cursor = 'grab'
  function onDown(e: PointerEvent) {
    dragging = true; lastX = e.clientX; lastY = e.clientY; velTheta = 0; velPhi = 0
    el.style.cursor = 'grabbing'
    if (demoMode) setDemo(false)
    hint && hint.classList.add('k3v-dim')
  }
  function onMove(e: PointerEvent) {
    if (!dragging) return
    const dx = e.clientX - lastX, dy = e.clientY - lastY
    lastX = e.clientX; lastY = e.clientY
    tTheta -= dx * 0.0052
    tPhi = clamp(tPhi + dy * 0.0042, THREE.MathUtils.degToRad(6), THREE.MathUtils.degToRad(88))
    velTheta = -dx * 0.0052; velPhi = dy * 0.0042
  }
  function onUp() { if (dragging) { dragging = false; el.style.cursor = 'grab' } }
  if (wantInteractive) {
    el.addEventListener('pointerdown', onDown as EventListener)
    window.addEventListener('pointermove', onMove as EventListener)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  function onWheel(e: WheelEvent) { e.preventDefault(); if (demoMode) setDemo(false); targetU = clamp(targetU + e.deltaY * 0.0011, 0, 1); hint && hint.classList.add('k3v-dim') }
  if (wantInteractive) el.addEventListener('wheel', onWheel, { passive: false })
  function onDblClick() { tTheta = INIT.theta; tPhi = INIT.phi; tRadius = INIT.radius }
  if (wantInteractive) el.addEventListener('dblclick', onDblClick)
  if (slider) slider.addEventListener('input', () => { if (demoMode) setDemo(false); targetU = clamp(parseInt(slider.value, 10) / 100, 0, 1); hint && hint.classList.add('k3v-dim') })
  function setDemo(on: boolean): void { demoMode = on; if (on) demoT = 0; if (demoBtn) demoBtn.textContent = on ? '⏸ STOP DEMO' : '▶ AUTO DEMO' }
  if (demoBtn) demoBtn.addEventListener('click', () => setDemo(!demoMode))
  if (qualityBtn) qualityBtn.addEventListener('click', () => {
    const i = TIER_ORDER.indexOf(qualityMode)
    setQuality(TIER_ORDER[(i + 1) % TIER_ORDER.length]!)
  })

  function readBoardFile(f: File): void {
    const r = new FileReader()
    r.onload = () => { try { loadBoard(String(r.result), f.name) } catch (e) { console.error(e); if (opts.onError) opts.onError(e); else alert('无法解析该文件 / failed to parse: ' + (e instanceof Error ? e.message : e)) } }
    r.readAsText(f)
  }
  const onFile = () => { const f = fileInput?.files?.[0]; if (f) readBoardFile(f); if (fileInput) fileInput.value = '' }
  if (fileInput) fileInput.addEventListener('change', onFile)
  const onOpen = () => fileInput?.click()
  if (openBtn) openBtn.addEventListener('click', onOpen)
  const onDragOver = (e: DragEvent) => { e.preventDefault(); root.classList.add('k3v-dropping') }
  const onDragLeave = (e: DragEvent) => { if (!e.relatedTarget) root.classList.remove('k3v-dropping') }
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); root.classList.remove('k3v-dropping')
    const f = e.dataTransfer?.files?.[0]
    if (f && /\.kicad_pcb$/i.test(f.name)) readBoardFile(f)
  }
  if (wantInteractive) {
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
  }

  function onResize(): void {
    const r = pane3d.getBoundingClientRect()
    const w = Math.max(1, r.width), h = Math.max(1, r.height)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    if (composer) composer.setSize(w, h)
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
  ro && ro.observe(pane3d)
  onResize()

  // ---------- frame loop ----------
  let raf = 0
  function frame(): void {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(clock.getDelta(), 0.05)
    if (demoMode) {
      demoT += dt
      targetU = demoCurve(demoT)
      tTheta += dt * 0.12
    } else if (!dragging && (Math.abs(velTheta) > 1e-4 || Math.abs(velPhi) > 1e-4)) {
      tTheta += velTheta
      tPhi = clamp(tPhi + velPhi, THREE.MathUtils.degToRad(6), THREE.MathUtils.degToRad(88))
      velTheta *= Math.exp(-dt * 3.5); velPhi *= Math.exp(-dt * 3.5)
    }
    const k = 1 - Math.exp(-dt * 9)
    theta += (tTheta - theta) * k
    phi += (tPhi - phi) * k
    radius += (tRadius - radius) * k
    const prevU = u
    u += (targetU - u) * (1 - Math.exp(-dt * 9))
    if (Math.abs(u - prevU) > 1e-5) movedBefore = true
    const speed = Math.abs(u - prevU) / Math.max(dt, 1e-4)
    board!.update(u, speed)
    const effRadius = radius * (1 + 0.42 * u)
    const cp = Math.cos(phi), sp = Math.sin(phi)
    camera.position.set(
      target.x + effRadius * cp * Math.sin(theta),
      target.y - effRadius * cp * Math.cos(theta),
      target.z + effRadius * sp
    )
    camera.lookAt(target)
    if (composer && bokeh) {
      const dist = effRadius + 7
      ;(bokeh.uniforms as Record<string, { value: number }>)['focus']!.value = clamp((camera.near + camera.far) / (2 * dist), 0, 1)
      composer.render()
    } else {
      renderer.render(scene, camera)
    }
    // 帧率统计（1 秒窗口）并刷新画质按钮文案
    fpsFrames += 1
    const now = performance.now()
    if (!fpsT0) fpsT0 = now
    if (now - fpsT0 >= 1000) {
      lastFps = (fpsFrames * 1000) / (now - fpsT0)
      fpsFrames = 0
      fpsT0 = now
      if (qualityBtn) qualityBtn.textContent = Math.round(lastFps) + ' FPS · ' + qualityMode.toUpperCase()
    }
    if (uBar) uBar.style.width = (u * 100).toFixed(1) + '%'
    if (uPct) uPct.textContent = Math.round(u * 100) + '%'
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(u * 100))
    if (caption) {
      caption.textContent = u > 0.94 ? `EXPLODED VIEW · ${board ? board.layerCount : 2}-LAYER STACKUP` : movedBefore && u < 0.03 ? 'FULLY ASSEMBLED' : ''
      caption.style.opacity = caption.textContent ? '1' : '0'
    }
  }
  frame()

  if (opts.autoDemo) setDemo(true)

  function setMode(mode: ViewMode): ViewMode {
    const next: ViewMode = mode === '2d' || mode === '3d' ? mode : 'split'
    root.classList.remove('k3v-mode-split', 'k3v-mode-2d', 'k3v-mode-3d')
    root.classList.add('k3v-mode-' + next)
    // 面板/分栏尺寸变了，两个视图各自按新尺寸重排
    onResize()
    v2d.redraw()
    return next
  }

  return {
    loadBoard,
    setMode,
    getMode() { return [...root.classList].find((c) => c.startsWith('k3v-mode-'))?.slice('k3v-mode-'.length) as ViewMode ?? 'split' },
    setQuality,
    getQuality() { return { mode: qualityMode, tier: activeTier } },
    setExplode(v: number) { targetU = clamp(v, 0, 1) },
    setDemo,
    dispose() {
      cancelAnimationFrame(raf)
      if (wantInteractive) {
        el.removeEventListener('pointerdown', onDown as EventListener)
        window.removeEventListener('pointermove', onMove as EventListener)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        el.removeEventListener('wheel', onWheel)
        el.removeEventListener('dblclick', onDblClick)
        window.removeEventListener('dragover', onDragOver)
        window.removeEventListener('dragleave', onDragLeave)
        window.removeEventListener('drop', onDrop)
      }
      if (fileInput) fileInput.removeEventListener('change', onFile)
      if (openBtn) openBtn.removeEventListener('click', onOpen)
      ro && ro.disconnect()
      v2d.destroy()
      board && board.dispose()
      if (composer) composer.dispose()
      renderer.dispose()
      container.removeChild(root)
    },
  }
}
