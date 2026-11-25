// @vitest-environment jsdom
/**
 * Mount lifecycle for an ECAD document.
 *
 * What is asserted is exactly what a document tab depends on: a canvas appears,
 * disposal removes it and frees the renderer, a superseded mount paints nothing,
 * and a malformed file becomes a value the body can print rather than an
 * unhandled rejection. The renderer itself is stubbed — the real one needs a GPU
 * canvas — so these tests stay honest about scope: they test the lifecycle this
 * package owns, not the drawing DSH does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = { dispose: 0, render: 0 }
let renderImpl: () => Promise<{ canvas: HTMLCanvasElement; viewer: unknown; dispose: () => void }> = async () => ({
  canvas: document.createElement('canvas'),
  viewer: {},
  dispose: () => { calls.dispose += 1 },
})

vi.mock('@huaqiu/ecad-renderer', () => ({
  renderSchematic: () => { calls.render += 1; return renderImpl() },
  renderPcb: () => { calls.render += 1; return renderImpl() },
}))

import { DocumentRenderError, mountEcadDocument, waitForLayout } from '../src/client/document/mount.js'

const SCHEMATIC = '(kicad_sch (version 20231120) (uuid "x"))'

/** A container jsdom will never lay out, so the box is stated instead of measured. */
function sized(width = 640, height = 480): HTMLDivElement {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true })
  document.body.append(element)
  return element
}

beforeEach(() => {
  calls.dispose = 0
  calls.render = 0
  renderImpl = async () => ({
    canvas: document.createElement('canvas'),
    viewer: {},
    dispose: () => { calls.dispose += 1 },
  })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('mountEcadDocument', () => {
  it('attaches one sized canvas and releases it on dispose', async () => {
    const container = sized()
    const mounted = await mountEcadDocument({
      kind: 'schematic', text: SCHEMATIC, container, signal: new AbortController().signal,
    })
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.style.width).toBe('100%')
    expect(calls.render).toBe(1)

    mounted.dispose()
    expect(calls.dispose).toBe(1)
    // The renderer detaches its own listeners but leaves the element; only this
    // module may remove it, and a second dispose must not double-free.
    expect(container.querySelector('canvas')).toBeNull()
    mounted.dispose()
    expect(calls.dispose).toBe(1)
  })

  it('reports a parser failure as a DocumentRenderError instead of throwing raw', async () => {
    const container = sized()
    await expect(mountEcadDocument({
      kind: 'schematic', text: 'not a schematic at all', container, signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DocumentRenderError)
    expect(container.querySelector('canvas')).toBeNull()
  })

  it('never attaches a canvas when the document was already abandoned', async () => {
    const container = sized()
    const controller = new AbortController()
    controller.abort()
    await expect(mountEcadDocument({
      kind: 'pcb', text: SCHEMATIC, container, signal: controller.signal,
    })).rejects.toMatchObject({ reason: 'aborted' })
    expect(container.querySelector('canvas')).toBeNull()
    expect(calls.render).toBe(0)
  })

  it('disposes a render that finishes after the deadline and reports a timeout', async () => {
    const container = sized()
    let resolveLate: ((value: { canvas: HTMLCanvasElement; viewer: unknown; dispose: () => void }) => void) | undefined
    renderImpl = () => new Promise((resolve) => { resolveLate = resolve })

    await expect(mountEcadDocument({
      kind: 'schematic', text: SCHEMATIC, container, signal: new AbortController().signal, timeoutMs: 5,
    })).rejects.toMatchObject({ reason: 'timeout' })
    expect(container.querySelector('canvas')).toBeNull()

    resolveLate?.({ canvas: document.createElement('canvas'), viewer: {}, dispose: () => { calls.dispose += 1 } })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls.dispose).toBe(1)
  })

  it('waits for a box, and gives up only when the document goes away', async () => {
    const container = sized(0, 0)
    const controller = new AbortController()
    const pending = waitForLayout(container, controller.signal)
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' })
  })

  it('returns immediately for a container that is already laid out', async () => {
    await expect(waitForLayout(sized(), new AbortController().signal)).resolves.toBeUndefined()
  })
})
