// @vitest-environment jsdom
/**
 * Regression guard: dropping an image onto the upload zone must reach the
 * generator even though the host runs a **page-wide** file drop target.
 *
 * dsh's attachment plugin (and chat-style hosts generally) listens on
 * `document` for dragenter/dragover/dragleave/drop:
 *   - its `dragover` writes `dataTransfer.dropEffect = 'none'` whenever it
 *     refuses the drop (cold start / blank session / composer busy) — the value
 *     lives on the shared drag data store, so the browser then cancels the drag
 *     and `drop` is never dispatched anywhere, including our zone;
 *   - its `drop` attaches the same file to the composer's own draft.
 *
 * Both are why a nested drop zone has to claim its own drag events. These tests
 * pin the zone's side of that contract: the zone sees the drop, the page-wide
 * target never does, and the page drag state is released so a full-viewport
 * drop mask cannot be left stranded on screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ComponentGenApp } from '../src/App.js'
import { releasePageDragState } from '../src/utils/drag.js'
import type { ComponentGenPorts } from '../src/ports.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Page-wide drop target double — mirrors the host's handler logic exactly. */
interface HostDropTarget {
  /** dragActive drives the host's full-viewport invitation. */
  dragActive: boolean
  depth: number
  draggedOver: number
  accepted: File[]
}

let root: Root | undefined
const HOST: HostDropTarget = { dragActive: false, depth: 0, draggedOver: 0, accepted: [] }

/**
 * Install the host double. `canAcceptDrop: false` is the cold-start/composer-
 * busy case whose `dropEffect = 'none'` kills drops page-wide.
 */
function installHostDropTarget(canAcceptDrop: boolean): () => void {
  const reset = (): void => { HOST.depth = 0; HOST.dragActive = false }
  const fileTransfer = (event: Event): unknown => {
    const transfer = (event as unknown as { dataTransfer?: { types?: string[] } }).dataTransfer
    if (!transfer || !transfer.types?.includes('Files')) return null
    return transfer
  }
  const onDragEnter = (event: Event): void => {
    if (!fileTransfer(event)) return
    event.preventDefault()
    HOST.depth += 1
    HOST.dragActive = true
  }
  const onDragOver = (event: Event): void => {
    const transfer = fileTransfer(event) as { dropEffect?: string } | null
    if (!transfer) return
    event.preventDefault()
    HOST.draggedOver += 1
    transfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
  }
  const onDragLeave = (event: Event): void => {
    if (!fileTransfer(event)) return
    HOST.depth = Math.max(0, HOST.depth - 1)
    if (HOST.depth === 0) HOST.dragActive = false
  }
  const onDrop = (event: Event): void => {
    const transfer = fileTransfer(event) as { files?: File[] } | null
    if (!transfer) return
    event.preventDefault()
    reset()
    if (canAcceptDrop) HOST.accepted.push(...(transfer.files ?? []))
  }
  document.addEventListener('dragenter', onDragEnter)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop)
  return () => {
    document.removeEventListener('dragenter', onDragEnter)
    document.removeEventListener('dragover', onDragOver)
    document.removeEventListener('dragleave', onDragLeave)
    document.removeEventListener('drop', onDrop)
  }
}

function fakePorts(authenticated = true): ComponentGenPorts {
  return {
    config: async () => ({
      hostMode: true,
      capabilities: { symbol: true, footprint: true },
      limits: { imageBytes: 4 * 1024 * 1024 },
    }),
    auth: {
      isAuthenticated: async () => authenticated,
      getUserInfo: async () => (authenticated ? { nickname: 'tester' } : null),
      login: async () => {},
      onAuthStateChanged: () => () => {},
    },
    startJob: async () => { throw new Error('not expected') },
    jobEvents: () => () => {},
    abortJob: async () => {},
    history: async () => ({ entries: [] }),
    historyEntry: async () => null,
    patchHistory: async () => { throw new Error('not expected') },
    deleteHistory: async () => {},
    artifactContent: async () => '',
    inputImage: async () => 'data:image/png;base64,AAAA',
  }
}

/** The array of drops the app itself saw, via the upload control's DOM. */
async function mountApp(authenticated = true): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const ports = fakePorts(authenticated)
  await act(async () => { root!.render(<ComponentGenApp ports={ports} page="footprint" lang="zh" />) })
  return container
}

function zoneOf(container: HTMLElement): HTMLElement {
  const zone = container.querySelector<HTMLElement>('.cga-upload')
  if (!zone) throw new Error('upload zone not rendered')
  return zone
}

/** Dispatch a native drag event the way the browser does (bubbles + cancels). */
async function fireDrag(
  target: Element,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  transfer: unknown,
  at: { x: number; y: number } = { x: 40, y: 40 },
): Promise<void> {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: at.x, clientY: at.y, dataTransfer: transfer })
  await act(async () => {
    target.dispatchEvent(event)
    // Reading the dropped file goes through FileReader, whose load event lands
    // on a later task — let those turns run so the zone can render its preview.
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function fileTransfer(file: File): { types: string[]; files: File[]; dropEffect: string } {
  return { types: ['Files'], files: [file], dropEffect: 'none' }
}

function imageFile(name = 'sop8.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
}

beforeEach(() => {
  document.body.innerHTML = ''
  HOST.dragActive = false
  HOST.depth = 0
  HOST.draggedOver = 0
  HOST.accepted = []
})

afterEach(() => {
  if (root) {
    act(() => { root!.unmount() })
    root = undefined
  }
  document.body.innerHTML = ''
})

describe('upload zone claims file drags from a page-wide drop target', () => {
  it('still receives the drop while the page-wide target refuses drops', async () => {
    const uninstall = installHostDropTarget(/* canAcceptDrop */ false)
    try {
      const container = await mountApp()
      const zone = zoneOf(container)
      const file = imageFile()
      const transfer = fileTransfer(file)

      // The file first enters the page (host shows its invitation), then lands
      // on our zone.
      await fireDrag(document.body, 'dragenter', transfer)
      expect(HOST.dragActive).toBe(true)

      await fireDrag(zone, 'dragenter', transfer)
      // The invitation must not keep covering the zone we are actually over.
      expect(HOST.dragActive).toBe(false)

      await fireDrag(zone, 'dragover', transfer)
      await fireDrag(zone, 'dragover', transfer)
      // The host never got to rule on this drag — its `dropEffect = 'none'`
      // is what makes the browser cancel the whole operation.
      expect(HOST.draggedOver).toBe(0)
      expect(transfer.dropEffect).toBe('copy')

      await fireDrag(zone, 'drop', transfer)

      // The image reached the generator…
      const thumb = container.querySelector<HTMLImageElement>('.cga-upload__thumb')
      expect(thumb?.src.startsWith('data:image/png')).toBe(true)
      // …and the page-wide target neither ruled on nor took it.
      expect(HOST.accepted).toEqual([])
      expect(HOST.dragActive).toBe(false)
      expect(HOST.depth).toBe(0)
    } finally {
      uninstall()
    }
  })

  it('does not hand the file to a page-wide target that would accept it', async () => {
    const uninstall = installHostDropTarget(/* canAcceptDrop */ true)
    try {
      const container = await mountApp()
      const zone = zoneOf(container)
      const transfer = fileTransfer(imageFile())

      await fireDrag(zone, 'dragenter', transfer)
      await fireDrag(zone, 'dragover', transfer)
      await fireDrag(zone, 'drop', transfer)

      expect(container.querySelector('.cga-upload__thumb')).not.toBeNull()
      expect(HOST.accepted).toEqual([])
      expect(HOST.draggedOver).toBe(0)
    } finally {
      uninstall()
    }
  })

  it('keeps the zone highlighted across child transitions and clears it on leave', async () => {
    const container = await mountApp()
    const zone = zoneOf(container)
    const transfer = fileTransfer(imageFile())

    await fireDrag(zone, 'dragenter', transfer)
    expect(zone.className).toContain('cga-upload--dragging')

    // Moving onto a child fires dragenter for the child and dragleave for its
    // parent (both bubble here) — the zone must stay highlighted.
    await fireDrag(zone, 'dragenter', transfer)
    await fireDrag(zone, 'dragleave', transfer)
    expect(zone.className).toContain('cga-upload--dragging')

    await fireDrag(zone, 'dragleave', transfer)
    expect(zone.className).not.toContain('cga-upload--dragging')
  })

  it('refuses the drop when the page is not authenticated without leaking it to the page', async () => {
    const uninstall = installHostDropTarget(/* canAcceptDrop */ true)
    try {
      const container = await mountApp(/* authenticated */ false)
      const zone = zoneOf(container)
      const transfer = fileTransfer(imageFile())

      await fireDrag(zone, 'dragenter', transfer)
      await fireDrag(zone, 'dragover', transfer)
      expect(transfer.dropEffect).toBe('none')
      await fireDrag(zone, 'drop', transfer)

      expect(container.querySelector('.cga-upload__thumb')).toBeNull()
      expect(HOST.accepted).toEqual([])
    } finally {
      uninstall()
    }
  })
})

describe('releasePageDragState', () => {
  it('broadcasts a Files-carrying dragleave at the viewport origin', () => {
    const seen: Array<{ type: string; types: string[] | undefined; x: number; target: EventTarget | null }> = []
    const listener = (event: Event): void => {
      const transfer = (event as unknown as { dataTransfer?: { types?: string[] } }).dataTransfer
      seen.push({
        type: event.type,
        types: transfer?.types,
        x: (event as unknown as { clientX: number }).clientX,
        target: event.target,
      })
    }
    document.addEventListener('dragleave', listener)
    try {
      releasePageDragState()
    } finally {
      document.removeEventListener('dragleave', listener)
    }
    // Page-wide targets only recognise the broadcast when it looks like the
    // pointer left the page: a file drag, at the origin, on the body.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.types).toContain('Files')
    expect(seen[0]?.x).toBe(0)
    expect(seen[0]?.target).toBe(document.body)
  })
})
