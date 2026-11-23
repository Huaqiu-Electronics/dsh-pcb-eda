/**
 * Three.js viewer for the host-generated PCB GLB.
 *
 * The GLB is a derived output: the `.kicad_pcb` stays authoritative and the
 * viewer keeps the source revision visible. Only GLTFLoader from `three` is
 * used; no editor, no external asset URL.
 */
import {
  AmbientLight, Box3, Color, DirectionalLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export interface MountedGlb {
  dispose(): void
}

export interface GlbViewerOptions {
  readonly signal: AbortSignal
  readonly background?: string
}

function aborted(signal: AbortSignal): DOMException {
  return new DOMException('3D view abandoned: navigation changed', 'AbortError')
}

/**
 * Load and display one GLB URL inside `container`.
 *
 * Drag rotates, the wheel zooms, and the camera is fitted to the model bounds.
 * Disposal removes the canvas and frees GPU resources; an aborted mount never
 * installs a listener or leaves a canvas behind.
 */
export async function mountGlb(url: string, container: HTMLElement, options: GlbViewerOptions): Promise<MountedGlb> {
  const scene = new Scene()
  const background = new Color(options.background ?? '#111318')
  scene.background = background

  const camera = new PerspectiveCamera(45, 1, 0.1, 10_000)
  const renderer = new WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(url)
  if (options.signal.aborted) {
    disposeGltf(gltf.scene)
    renderer.dispose()
    throw aborted(options.signal)
  }

  scene.add(gltf.scene)
  scene.add(new AmbientLight(0xffffff, 1.2))
  const key = new DirectionalLight(0xffffff, 2)
  key.position.set(40, 60, 30)
  scene.add(key)
  const fill = new DirectionalLight(0xffffff, 1)
  fill.position.set(-30, -20, -40)
  scene.add(fill)

  const bounds = new Box3().setFromObject(gltf.scene)
  const center = bounds.getCenter(new Vector3())
  const size = bounds.getSize(new Vector3())
  const radius = Math.max(size.x, size.y, size.z, 0.001) / 2
  const distance = radius / Math.sin(Math.PI / 8)

  let yaw = 0.6
  let pitch = 0.45
  let zoom = 1
  const place = (): void => {
    const horizontal = distance * zoom
    camera.position.set(
      center.x + horizontal * Math.cos(pitch) * Math.sin(yaw),
      center.y + horizontal * Math.sin(pitch),
      center.z + horizontal * Math.cos(pitch) * Math.cos(yaw),
    )
    camera.lookAt(center)
    camera.near = Math.max(radius / 1000, 0.01)
    camera.far = distance * 20
    camera.updateProjectionMatrix()
  }
  place()

  let dragging = false
  let lastX = 0
  let lastY = 0
  const onPointerDown = (event: PointerEvent): void => {
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    renderer.domElement.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    yaw -= dx * 0.01
    pitch = Math.max(-1.45, Math.min(1.45, pitch + dy * 0.01))
    place()
    draw()
  }
  const onPointerUp = (event: PointerEvent): void => {
    dragging = false
    if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
  }
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    zoom = Math.max(0.2, Math.min(8, zoom * (event.deltaY > 0 ? 1.1 : 0.9)))
    place()
    draw()
  }

  const resize = (): void => {
    const width = Math.max(container.clientWidth, 240)
    const height = Math.max(container.clientHeight, 220)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    draw()
  }

  let frame = 0
  const draw = (): void => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      renderer.render(scene, camera)
    })
  }

  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
  observer?.observe(container)
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab'
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointercancel', onPointerUp)
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
  container.append(renderer.domElement)
  resize()

  return {
    dispose: () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer?.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointercancel', onPointerUp)
      renderer.domElement.removeEventListener('wheel', onWheel)
      renderer.domElement.remove()
      disposeGltf(gltf.scene)
      renderer.dispose()
      scene.clear()
    },
  }
}

/** Release geometries, materials and textures owned by the loaded scene. */
function disposeGltf(root: { traverse(callback: (object: unknown) => void): void }): void {
  root.traverse((object) => {
    const mesh = object as {
      geometry?: { dispose(): void }
      material?: { dispose(): void } | readonly { dispose(): void }[]
    }
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) for (const entry of material) entry.dispose()
    else (material as { dispose(): void } | undefined)?.dispose()
  })
}
