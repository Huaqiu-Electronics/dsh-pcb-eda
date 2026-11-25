// @vitest-environment jsdom
/**
 * STEP mount lifecycle.
 *
 * The reader is stubbed at the module boundary: a real OpenCascade compile would
 * take seconds and the point here is not tessellation quality but ownership —
 * a canvas appears only on success, a bad file becomes a readable failure, and
 * disposal removes every element the mount created.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const occt = {
  readResult: { success: true, meshes: [{ attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } }] } as unknown,
  initFails: false,
}
const disposed = { geometries: 0, materials: 0, renderer: 0, controls: 0 }

vi.mock('occt-import-js', () => ({
  default: async () => {
    if (occt.initFails) throw new Error('instantiate exploded')
    return { ReadStepFile: () => occt.readResult }
  },
}))

vi.mock('three', () => {
  class Vector3 {
    x = 0; y = 0; z = 0
    copy() { return this }
    normalize() { return this }
    addScaledVector() { return this }
  }
  class Box3 {
    setFromObject() { return this }
    getCenter(target: unknown) { return target }
    getSize(target: { x: number; y: number; z: number }) { target.x = 10; target.y = 10; target.z = 10; return target }
  }
  class Geometry { attributes: unknown[] = []; dispose() { disposed.geometries += 1 } setAttribute(v: unknown) { this.attributes.push(v) } setIndex() {} computeVertexNormals() {} }
  class Material { dispose() { disposed.materials += 1 } }
  class Renderer {
    domElement: HTMLCanvasElement
    constructor() {
      this.domElement = document.createElement('canvas')
    }
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() { disposed.renderer += 1 }
  }
  class Light { position = { set() {} } }
  return {
    AmbientLight: Light, Box3, BufferGeometry: Geometry, Color: class {}, DirectionalLight: Light,
    DoubleSide: 2, Float32BufferAttribute: class { constructor(_a: unknown, _b: unknown) {} },
    Group: class { children: unknown[] = []; add(v: unknown) { this.children.push(v) } clear() {} },
    HemisphereLight: Light, Mesh: class {}, MeshStandardMaterial: Material, PerspectiveCamera: class {
      fov = 45; near = 0.1; far = 100
      position = new Vector3(); updateProjectionMatrix() {}
    },
    Scene: class { add() {} clear() {} }, Vector3, WebGLRenderer: Renderer,
  }
})

vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = { copy() {} }
    enableDamping = false
    screenSpacePanning = false
    addEventListener() {} removeEventListener() {} update() {}
    dispose() { disposed.controls += 1 }
  },
}))

import { MAX_STEP_BYTES, mountStepDocument, resetOcctReader } from '../src/client/document/step.js'
import { DocumentRenderError } from '../src/client/document/mount.js'
import { stepFailureText } from '../src/client/document/StepBody.js'

const wasm = new Uint8Array([0, 97, 115, 109])

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
})

beforeEach(() => {
  resetOcctReader()
  occt.initFails = false
  occt.readResult = { success: true, meshes: [{ attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } }] }
  disposed.geometries = 0
  disposed.materials = 0
  disposed.renderer = 0
  disposed.controls = 0
  vi.stubGlobal('fetch', async () => new Response(wasm, { status: 200 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function container(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  return element
}

describe('mountStepDocument', () => {
  it('fetches the packaged wasm, tessellates and attaches one canvas', async () => {
    const host = container()
    const mounted = await mountStepDocument({
      bytes: new Uint8Array([1, 2, 3]), container: host, signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })
    expect(host.querySelector('[data-step-canvas]')).not.toBeNull()
    mounted.dispose()
    expect(host.querySelector('[data-step-canvas]')).toBeNull()
    expect(disposed.renderer).toBe(1)
    expect(disposed.controls).toBe(1)
    expect(disposed.geometries).toBe(1)
    expect(disposed.materials).toBe(1)
    mounted.dispose()
    expect(disposed.renderer).toBe(1)
  })

  it('reports an empty file before touching the reader', async () => {
    await expect(mountStepDocument({
      bytes: new Uint8Array(), container: container(), signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })).rejects.toMatchObject({ reason: 'parse' })
  })

  it('refuses a model past the size gate', async () => {
    await expect(mountStepDocument({
      bytes: new Uint8Array(MAX_STEP_BYTES + 1), container: container(), signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })).rejects.toMatchObject({ reason: 'toolarge' })
  })

  it('reports a model with no solid geometry instead of showing an empty scene', async () => {
    occt.readResult = { success: true, meshes: [] }
    await expect(mountStepDocument({
      bytes: new Uint8Array([1]), container: container(), signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })).rejects.toMatchObject({ reason: 'parse' })
  })

  it('surfaces a failed wasm download as a render failure and clears the cache', async () => {
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }))
    await expect(mountStepDocument({
      bytes: new Uint8Array([1]), container: container(), signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })).rejects.toMatchObject({ reason: 'render' })
    // A later mount must retry rather than reuse the rejected promise.
    vi.stubGlobal('fetch', async () => new Response(wasm, { status: 200 }))
    const mounted = await mountStepDocument({
      bytes: new Uint8Array([1]), container: container(), signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })
    mounted.dispose()
  })

  it('reuses one reader instance across documents', async () => {
    const fetchSpy = vi.fn(async () => new Response(wasm, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const first = await mountStepDocument({
      bytes: new Uint8Array([1]), container: container(), signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })
    const second = await mountStepDocument({
      bytes: new Uint8Array([2]), container: container(), signal: new AbortController().signal, wasmUrl: '/w.wasm',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    first.dispose()
    second.dispose()
  })
})

describe('stepFailureText', () => {
  it('names the missing reader when the wasm cannot be loaded', () => {
    expect(stepFailureText(new DocumentRenderError('render', 'wasm fetch failed: HTTP 404')))
      .toContain('3D 解析组件加载失败')
  })

  it('falls back to a readable generic line for an unknown error', () => {
    expect(stepFailureText(new Error('boom'))).toContain('boom')
  })
})
