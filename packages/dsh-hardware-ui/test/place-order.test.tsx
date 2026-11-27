// @vitest-environment jsdom
/**
 * The Place Order entry point: it lists what the Host discovered, refuses the
 * operations that cannot run, and hands one project to the existing order
 * destination. No row is invented here — every assertion below reads the
 * discovery answer back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@huaqiu/ecad-renderer', () => ({
  renderSchematic: async () => ({ canvas: {}, viewer: {}, dispose: () => {} }),
  renderPcb: async () => ({ canvas: {}, viewer: {}, dispose: () => {} }),
}))
vi.mock('three', () => ({
  AmbientLight: class {}, DirectionalLight: class {}, Color: class {}, Scene: class {},
  Box3: class {}, PerspectiveCamera: class {}, Vector3: class {}, WebGLRenderer: class {},
}))
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({ GLTFLoader: class {} }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { PlaceOrderBody, type PlaceOrderProps } from '../src/client/place-order.js'
import { COPY } from '../src/client/copy.js'
import { apply } from '../src/client/index.js'
import type { HardwareProjectInfo } from '../src/client/model.js'

const FULL: HardwareProjectInfo = {
  path: 'C:/w/board-a/board-a.kicad_pro',
  name: 'board-a',
  schematic: { id: 'schematic:C:/w/board-a/board-a.kicad_sch', kind: 'schematic', path: 'C:/w/board-a/board-a.kicad_sch', title: 'board-a.kicad_sch' },
  sheets: [],
  boards: [
    { id: 'pcb:C:/w/board-a/board-a.kicad_pcb', kind: 'pcb', path: 'C:/w/board-a/board-a.kicad_pcb', title: 'board-a.kicad_pcb' },
    { id: 'pcb:C:/w/board-a/board-b.kicad_pcb', kind: 'pcb', path: 'C:/w/board-a/board-b.kicad_pcb', title: 'board-b.kicad_pcb' },
  ],
  defaultBoard: 'C:/w/board-a/board-b.kicad_pcb',
  selectionRequired: false,
}

/** Board and schematic, no board: PCB is blocked, PCBA has two reasons stacked. */
const NO_BOARD: HardwareProjectInfo = {
  ...FULL, path: 'C:/w/only-sch/only-sch.kicad_pro', name: 'only-sch', boards: [], defaultBoard: undefined,
}

/** Board but no schematic: PCBA cannot build its BOM and positions. */
const NO_SCHEMATIC: HardwareProjectInfo = {
  path: 'C:/w/board-c/board-c.kicad_pro', name: 'board-c', schematic: undefined, sheets: [],
  boards: [{ id: 'pcb:C:/w/board-c/board-c.kicad_pcb', kind: 'pcb', path: 'C:/w/board-c/board-c.kicad_pcb', title: 'board-c.kicad_pcb' }],
  defaultBoard: 'C:/w/board-c/board-c.kicad_pcb',
  selectionRequired: false,
}

function orderConfig(hasToken: boolean): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ configured: true, baseUrl: 'https://www.eda.cn', hasToken, provider: 'huaqiu' }),
  })))
}

function props(overrides: Partial<PlaceOrderProps> = {}): PlaceOrderProps {
  return {
    sessionId: 's1',
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { cwd: 'C:/w' } } }),
    discover: async () => ({ cwd: 'C:/w', projects: [FULL] }),
    installations: async () => ({ kicad: { configured: true } }),
    orderProject: vi.fn(),
    ...overrides,
  }
}

let root: Root | undefined

async function mount(component: PlaceOrderProps): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<PlaceOrderBody {...component} />) })
  // The two probes resolve after the first paint; settle them.
  await act(async () => { await Promise.resolve() })
  const view = container.querySelector<HTMLElement>('[data-hardware-place-order]')
  if (view === null) throw new Error('the Place Order view did not render')
  return view
}

beforeEach(() => { orderConfig(true) })

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('project list', () => {
  it('renders one row per discovered project with its artifacts', async () => {
    const view = await mount(props())
    const rows = [...view.querySelectorAll('[data-hardware-place-order-project]')]
    expect(rows.map(row => row.getAttribute('data-hardware-place-order-project'))).toEqual([FULL.path])
    expect(rows[0]!.textContent).toContain('board-a')
    // Both boards counted, the default one named, and the schematic named too.
    expect(rows[0]!.textContent).toContain(COPY.order.placeOrder.boardCount(2))
    expect(rows[0]!.textContent).toContain('board-b.kicad_pcb')
    expect(rows[0]!.textContent).toContain('board-a.kicad_sch')
    // Also relative to the scanned workspace, so two projects with the same
    // basename still differ on screen.
    expect(rows[0]!.textContent).toContain('board-a/board-a.kicad_pro')
    expect(view.textContent).toContain('C:/w')
  })

  it('shows every project when the workspace holds several', async () => {
    const view = await mount(props({
      discover: async () => ({ cwd: 'C:/w', projects: [FULL, NO_BOARD], issue: { code: 'selection-required', message: 'two projects' } }),
    }))
    const rows = [...view.querySelectorAll('[data-hardware-place-order-project]')]
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.getAttribute('data-hardware-place-order-project'))).toEqual([FULL.path, NO_BOARD.path])
  })

  it('keeps two projects with the same basename apart by their relative path', async () => {
    const twinA: HardwareProjectInfo = { ...FULL, path: 'C:/w/rev-a/board.kicad_pro', name: 'board' }
    const twinB: HardwareProjectInfo = { ...FULL, path: 'C:/w/rev-b/board.kicad_pro', name: 'board' }
    const view = await mount(props({ discover: async () => ({ cwd: 'C:/w', projects: [twinA, twinB] }) }))
    const rows = [...view.querySelectorAll('[data-hardware-place-order-project]')]
    // Identity is the path, never the display name: both rows survive.
    expect(rows.map(row => row.getAttribute('data-hardware-place-order-project'))).toEqual([twinA.path, twinB.path])
    expect(rows[0]!.textContent).toContain('rev-a/board.kicad_pro')
    expect(rows[1]!.textContent).toContain('rev-b/board.kicad_pro')
  })

  it('reports an empty workspace instead of an empty list', async () => {
    const view = await mount(props({ discover: async () => ({ cwd: 'C:/w', projects: [], issue: { code: 'none', message: 'nothing here' } }) }))
    const empty = view.querySelector('[data-hardware-place-order-empty]')
    expect(empty).not.toBeNull()
    expect(empty!.getAttribute('data-hardware-place-order-empty')).toBe('none')
    expect(empty!.textContent).toContain(COPY.order.placeOrder.noProjectsHint)
    expect(view.querySelector('[data-hardware-place-order-project]')).toBeNull()
  })

  it('keeps a failed scan visible and blocks nothing that looks orderable', async () => {
    const view = await mount(props({ discover: async () => { throw new Error('host unreachable') } }))
    const error = view.querySelector('[role=status]')
    expect(error?.textContent).toBe(COPY.order.placeOrder.discoveryFailed('host unreachable'))
    expect(view.querySelector('[data-hardware-place-order-project]')).toBeNull()
  })
})

describe('hand-off to the existing order destination', () => {
  it('hands the default board of the chosen project over as a PCB order', async () => {
    const orderProject = vi.fn()
    const view = await mount(props({ orderProject }))
    const pcb = view.querySelector<HTMLButtonElement>('[data-hardware-place-order-action=pcb]')!
    expect(pcb.disabled).toBe(false)
    act(() => { pcb.click() })
    expect(orderProject).toHaveBeenCalledExactlyOnceWith({
      projectPath: FULL.path,
      boardPath: 'C:/w/board-a/board-b.kicad_pcb',
      // The project's own schematic travels with the order, so PCBA cannot
      // package a board with a stale project's BOM and positions.
      schematicPath: 'C:/w/board-a/board-a.kicad_sch',
      kind: 'pcb',
    })
  })

  it('asks for PCBA with the same board when the project has a schematic', async () => {
    const orderProject = vi.fn()
    const view = await mount(props({ orderProject }))
    act(() => { view.querySelector<HTMLButtonElement>('[data-hardware-place-order-action=pcba]')!.click() })
    expect(orderProject).toHaveBeenCalledExactlyOnceWith({
      projectPath: FULL.path,
      boardPath: 'C:/w/board-a/board-b.kicad_pcb',
      schematicPath: 'C:/w/board-a/board-a.kicad_sch',
      kind: 'smt',
    })
  })
})

describe('readiness reasons', () => {
  it('blocks PCB with no board and PCBA for a missing schematic, each with its reason', async () => {
    const view = await mount(props({ discover: async () => ({ cwd: 'C:/w', projects: [NO_BOARD, NO_SCHEMATIC] }) }))
    const noBoard = view.querySelector(`[data-hardware-place-order-project="${NO_BOARD.path}"]`)!
    expect(noBoard.getAttribute('data-hardware-place-order-pcb')).toBe('blocked')
    expect(noBoard.getAttribute('data-hardware-place-order-pcba')).toBe('blocked')
    expect((noBoard.querySelector('[data-hardware-place-order-action=pcb]') as HTMLButtonElement).disabled).toBe(true)
    expect(noBoard.textContent).toContain(COPY.order.placeOrder.noBoard)

    const noSchematic = view.querySelector(`[data-hardware-place-order-project="${NO_SCHEMATIC.path}"]`)!
    expect(noSchematic.getAttribute('data-hardware-place-order-pcb')).toBe('ready')
    expect(noSchematic.getAttribute('data-hardware-place-order-pcba')).toBe('blocked')
    expect(noSchematic.textContent).toContain(COPY.order.placeOrder.noSchematic)
  })

  it('sends no schematic at all when the project has none, rather than inventing one', async () => {
    const orderProject = vi.fn()
    const view = await mount(props({ discover: async () => ({ cwd: 'C:/w', projects: [NO_SCHEMATIC] }), orderProject }))
    act(() => { view.querySelector<HTMLButtonElement>('[data-hardware-place-order-action=pcb]')!.click() })
    expect(orderProject).toHaveBeenCalledExactlyOnceWith({
      projectPath: NO_SCHEMATIC.path,
      boardPath: 'C:/w/board-c/board-c.kicad_pcb',
      kind: 'pcb',
    })
    expect(Object.keys(orderProject.mock.calls[0]![0])).not.toContain('schematicPath')
  })

  it('blocks both operations when KiCad is missing', async () => {    const view = await mount(props({ installations: async () => ({ kicad: { configured: false } }) }))
    const row = view.querySelector(`[data-hardware-place-order-project="${FULL.path}"]`)!
    expect(row.getAttribute('data-hardware-place-order-pcb')).toBe('blocked')
    expect(row.textContent).toContain(COPY.order.placeOrder.needsKicad)
    expect(view.querySelector('[data-hardware-place-order-kicad]')!.getAttribute('data-hardware-place-order-kicad')).toBe('missing')
  })

  it('blocks both operations when the account is not signed in', async () => {
    orderConfig(false)
    const view = await mount(props())
    const row = view.querySelector(`[data-hardware-place-order-project="${FULL.path}"]`)!
    expect(row.getAttribute('data-hardware-place-order-pcba')).toBe('blocked')
    expect(row.textContent).toContain(COPY.order.placeOrder.needsSignIn)
    expect(view.querySelector('[data-hardware-place-order-signin]')!.getAttribute('data-hardware-place-order-signin')).toBe('missing')
  })

  it('says the probes are still running rather than claiming readiness', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const view = await mount(props({ installations: () => new Promise(() => {}) }))
    expect(view.querySelector('[data-hardware-place-order-kicad]')!.getAttribute('data-hardware-place-order-kicad')).toBe('checking')
    expect(view.querySelector('[data-hardware-place-order-signin]')!.getAttribute('data-hardware-place-order-signin')).toBe('checking')
  })
})

describe('refresh', () => {
  it('rescans the workspace from the refresh button', async () => {
    const discover = vi.fn<PlaceOrderProps['discover']>(async () => ({ cwd: 'C:/w', projects: [FULL] }))
    const view = await mount(props({ discover }))
    expect(discover).toHaveBeenCalledTimes(1)
    act(() => { view.querySelector<HTMLButtonElement>('[data-hardware-place-order-refresh]')!.click() })
    await act(async () => { await Promise.resolve() })
    expect(discover).toHaveBeenCalledTimes(2)
  })
})

describe('desktop shell handle', () => {
  interface Open {
    readonly kind: string
    readonly options?: { readonly revealIfOpened?: boolean }
  }

  function applyWithPanel(panel: boolean): { opens: Open[]; dispose: () => void } {
    const opens: Open[] = []
    const disposers: (() => void)[] = []
    const context = {
      slots: {
        inject: (_key: string, callback: () => () => void) => {
          const dispose = callback()
          disposers.push(dispose)
          return dispose
        },
        register: () => () => {},
      },
      sidebarRightTabs: { register: () => () => {} },
      ...(panel
        ? { sidebarRight: { openTab: (kind: string, options?: { revealIfOpened?: boolean }) => { opens.push({ kind, options }) } } }
        : {}),
      effect: (fn: () => (() => void) | void) => {
        const dispose = fn()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake only implements the seats apply() touches.
    apply(context as any)
    return { opens, dispose: () => { for (const entry of disposers.reverse()) entry() } }
  }

  it('installs one handle the menu calls, revealing the same view on every press', () => {
    const plugin = applyWithPanel(true)
    expect(window.huaqiu?.placeOrder?.()).toBe(true)
    expect(window.huaqiu?.placeOrder?.()).toBe(true)
    // Two presses, one view: the second only brings the first forward.
    expect(plugin.opens).toEqual([
      { kind: 'hardware-place-order', options: { revealIfOpened: true } },
      { kind: 'hardware-place-order', options: { revealIfOpened: true } },
    ])
    plugin.dispose()
    // Unloaded plugin, unusable menu: the handle is removed with the plugin.
    expect(window.huaqiu).toBeUndefined()
  })

  it('reports failure instead of pretending a view opened when the panel is absent', () => {
    const plugin = applyWithPanel(false)
    expect(window.huaqiu?.placeOrder?.()).toBe(false)
    expect(plugin.opens).toEqual([])
    plugin.dispose()
  })
})
