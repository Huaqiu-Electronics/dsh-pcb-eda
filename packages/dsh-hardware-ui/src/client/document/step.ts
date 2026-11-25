/**
 * STEP / STP document renderer.
 *
 * Why direct parsing, not host-side conversion: the ordering spec demands the
 * model be viewable without launching SolidCraft and without asking the user to
 * convert anything (§6.2), and this repository already had a proven
 * browser-side path for mechanical formats — `occt-import-js` (OpenCascade
 * compiled to WebAssembly), vendored in `web-vue` for exactly this purpose.
 * With it the `.step`/`.stp` file stays authoritative, nothing is derived, no
 * cache can go stale, and the whole pipeline runs offline because the `.wasm`
 * ships in the package rather than at a CDN URL.
 *
 * The cost is stated instead of hidden: the reader is a synchronous WebAssembly
 * call, so a pathological model blocks the main thread while it tessellates.
 * The size gate below is what bounds that, and the reader instance is created
 * once per page and shared — the 7.6 MB `.wasm` is compiled a single time no
 * matter how many STEP documents are opened.
 *
 * Resource ownership: everything this module creates (geometries, materials,
 * renderer, controls, observers, canvas) is released by `dispose()`. Nothing is
 * cached per document, so closing a tab leaves no model behind.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/step
 */

import {
  AmbientLight, Box3, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, Group,
  HemisphereLight, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import occtimportjs, { type OcctModule } from 'occt-import-js'
import { DocumentRenderError, waitForLayout, DEFAULT_RENDER_TIMEOUT_MS } from './mount.js'

/** A live 3D document body. */
export interface MountedStepDocument {
  /** Release every GPU resource, listener, observer and element this mount created. Idempotent. */
  dispose(): void
  /** Re-fit the camera to the model bounds. */
  fit(): void
}

/** Largest STEP document this renderer will tessellate. */
export const MAX_STEP_BYTES = 32 * 1024 * 1024

/** Neutral steel that reads as machined metal under the two-light rig below. */
const DEFAULT_MATERIAL_COLOR = 0xb8bcc4

/** One shared reader instance per page: compiling the module again per document would cost seconds. */
let readerPromise: Promise<OcctModule> | undefined

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
}

/**
 * Instantiate the OpenCascade reader from locally served wasm bytes.
 * @param wasmUrl - same-origin URL of the packaged `occt-import-js.wasm`.
 * @param signal - document lifetime; cancels the download only.
 * @returns the ready module, cached for the page.
 */
export function loadOcctReader(wasmUrl: string, signal: AbortSignal): Promise<OcctModule> {
  readerPromise ??= (async () => {
    let response: Response
    try {
      response = await fetch(wasmUrl, { credentials: 'same-origin' })
    } catch (error) {
      readerPromise = undefined
      throw new DocumentRenderError('render', `wasm fetch failed: ${messageOf(error)}`)
    }
    if (!response.ok) {
      readerPromise = undefined
      throw new DocumentRenderError('render', `wasm fetch failed: HTTP ${response.status}`)
    }
    const wasmBinary = await response.arrayBuffer()
    try {
      return await occtimportjs({ wasmBinary })
    } catch (error) {
      readerPromise = undefined
      throw new DocumentRenderError('render', `wasm instantiation failed: ${messageOf(error)}`)
    }
  })()
  // The download is the only cancellable part; instantiation itself is atomic.
  return readerPromise.catch((error: unknown) => {
    if (signal.aborted) throw new DocumentRenderError('aborted', 'render abandoned')
    throw error instanceof DocumentRenderError ? error : new DocumentRenderError('render', messageOf(error))
  })
}

/** Drop the cached reader, so the next mount reloads it. Used by tests and by a failed load. */
export function resetOcctReader(): void {
  readerPromise = undefined
}

export interface StepDocumentRequest {
  /** Exact `.step`/`.stp` bytes; the source file is never modified. */
  readonly bytes: Uint8Array
  readonly container: HTMLElement
  readonly signal: AbortSignal
  /** Same-origin URL of the packaged reader wasm. */
  readonly wasmUrl: string
  readonly timeoutMs?: number
}

/**
 * Tessellate one STEP/STP document and show it with orbit, pan and zoom.
 * @param request - bytes, target container, lifetime, wasm source.
 * @returns the live mount; call `dispose()` when the document closes or reloads.
 */
export async function mountStepDocument(request: StepDocumentRequest): Promise<MountedStepDocument> {
  const { bytes, container, signal, wasmUrl } = request
  const timeoutMs = request.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
  if (signal.aborted) throw new DocumentRenderError('aborted', 'render abandoned')
  if (bytes.byteLength === 0) throw new DocumentRenderError('parse', 'file is empty')
  if (bytes.byteLength > MAX_STEP_BYTES) {
    throw new DocumentRenderError('toolarge', `${bytes.byteLength} bytes exceeds ${MAX_STEP_BYTES}`)
  }

  await waitForLayout(container, signal)
  if (signal.aborted) throw new DocumentRenderError('aborted', 'render abandoned')

  const reader = await loadOcctReader(wasmUrl, signal)
  if (signal.aborted) throw new DocumentRenderError('aborted', 'render abandoned')

  let importResult
  try {
    importResult = reader.ReadStepFile(bytes, null)
  } catch (error) {
    throw new DocumentRenderError('parse', messageOf(error))
  }
  if (!importResult.success || importResult.meshes.length === 0) {
    throw new DocumentRenderError('parse', 'no solid geometry')
  }

  const scene = new Scene()
  const group = new Group()
  const geometries: BufferGeometry[] = []
  const materials: MeshStandardMaterial[] = []
  for (const mesh of importResult.meshes) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([...mesh.attributes.position.array], 3))
    if (mesh.attributes.normal !== undefined) {
      geometry.setAttribute('normal', new Float32BufferAttribute([...mesh.attributes.normal.array], 3))
    }
    if (mesh.index !== undefined) geometry.setIndex([...mesh.index.array])
    if (mesh.attributes.normal === undefined) geometry.computeVertexNormals()
    const rgb = mesh.color
    const material = new MeshStandardMaterial({
      color: rgb !== undefined && rgb.length >= 3
        ? new Color(rgb[0] ?? 0.7, rgb[1] ?? 0.7, rgb[2] ?? 0.7)
        : new Color(DEFAULT_MATERIAL_COLOR),
      metalness: 0.25,
      roughness: 0.55,
      // Imported solids do not guarantee consistent winding; a single-sided
      // material would show holes on inverted faces.
      side: DoubleSide,
    })
    materials.push(material)
    geometries.push(geometry)
    const object = new Mesh(geometry, material)
    object.name = mesh.name ?? ''
    group.add(object)
  }
  scene.add(group)

  scene.add(new AmbientLight(0xffffff, 0.55))
  scene.add(new HemisphereLight(0xffffff, 0x30343c, 1.1))
  const key = new DirectionalLight(0xffffff, 2.1)
  key.position.set(1, 1.6, 1.1)
  scene.add(key)
  const fill = new DirectionalLight(0xffffff, 0.9)
  fill.position.set(-1.2, -0.8, -0.7)
  scene.add(fill)

  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true })
  } catch (error) {
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    throw new DocumentRenderError('render', `webgl unavailable: ${messageOf(error)}`)
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const bounds = new Box3().setFromObject(group)
  const center = bounds.getCenter(new Vector3())
  const size = bounds.getSize(new Vector3())
  const radius = Math.max(size.x, size.y, size.z, 0.001) / 2
  const camera = new PerspectiveCamera(45, 1, Math.max(radius / 1000, 0.01), radius * 1000)

  const fit = (): void => {
    const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.15
    const direction = new Vector3(0.9, 0.65, 1).normalize()
    camera.position.copy(center).addScaledVector(direction, distance)
    camera.near = Math.max(radius / 1000, 0.01)
    camera.far = distance * 20
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
    draw()
  }

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
  controls.screenSpacePanning = true

  const canvas = renderer.domElement
  canvas.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;outline:none;touch-action:none'
  canvas.dataset.stepCanvas = ''
  container.append(canvas)

  let frame = 0
  const draw = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      renderer.render(scene, camera)
    })
  }
  const resize = (): void => {
    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    draw()
  }
  const onControls = (): void => { draw() }
  const onDoubleClick = (): void => { fit() }
  controls.addEventListener('change', onControls)
  renderer.domElement.addEventListener('dblclick', onDoubleClick)
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
  observer?.observe(container)
  resize()
  fit()

  let disposed = false
  return {
    fit,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (frame !== 0) cancelAnimationFrame(frame)
      observer?.disconnect()
      controls.removeEventListener('change', onControls)
      controls.dispose()
      renderer.domElement.removeEventListener('dblclick', onDoubleClick)
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      scene.clear()
      group.clear()
      renderer.dispose()
      canvas.remove()
    },
  }
}
