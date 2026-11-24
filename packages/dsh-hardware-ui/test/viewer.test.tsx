// @vitest-environment jsdom
/**
 * The panel as the user meets it: one header at the top carrying the five
 * destinations, and an empty destination that says what is missing and how to
 * get it.
 *
 * These are DOM assertions rather than screenshots: the shape of the panel is
 * the claim (header first, nothing above it, one centred placeholder), and it is
 * the part a later refactor would break silently.
 */
import { describe, expect, it, vi } from 'vitest'
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

// `act` warns loudly in 18.3 unless the environment opts in.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { HardwareViewerBody, type HardwareProps } from '../src/client/components.js'
import { COPY } from '../src/client/copy.js'
import type { DiscoveryInfo, HardwareState, ViewerNavigationParams } from '../src/client/model.js'

const EMPTY_DISCOVERY: DiscoveryInfo = { cwd: '/w', projects: [] }

/** A project with a schematic and no board: the PCB destination has a placeholder. */
const BOARD_LESS: DiscoveryInfo = {
  cwd: '/w',
  projects: [{
    path: '/w/a.kicad_pro', name: 'a',
    schematic: { id: 'schematic:/w/a.kicad_sch', kind: 'schematic', path: '/w/a.kicad_sch', title: 'a.kicad_sch' },
    sheets: [], boards: [], selectionRequired: false,
  }],
  selected: {
    path: '/w/a.kicad_pro', name: 'a',
    schematic: { id: 'schematic:/w/a.kicad_sch', kind: 'schematic', path: '/w/a.kicad_sch', title: 'a.kicad_sch' },
    sheets: [], boards: [], selectionRequired: false,
  },
}

function props(state: HardwareState, params: ViewerNavigationParams, configured = false): HardwareProps {
  const noop = (): void => {}
  // The viewer reads the installation from its store, which the mount effect
  // fills; a test that needs a configured KiCad starts with it already there.
  const view: HardwareState = configured
    ? { ...state, installations: { kicad: { configured: true, version: '10.0.7' } } }
    : state
  // Stable snapshots: `useSyncExternalStore` re-renders whenever `getSnapshot`
  // returns a new object, so a fresh literal here would loop forever.
  const snapshot = { status: 'ready', value: { onboardingComplete: true } }
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
  }
  return {
    useStore: <S,>(selector: (snapshot: HardwareState) => S): S => selector(view),
    actions: {
      setActive: noop, setWorkspaceRoot: noop, setDiscovery: noop, selectProject: noop,
      selectArtifact: noop, applyNavigation: noop, setInstallations: noop, setNotice: noop, refresh: noop,
    },
    useTabInfo: () => ({ tab: { id: 'tab1', navigation: { params: params as unknown as Record<string, unknown>, revision: 1 } } }),
    sessionId: 's1',
    useSessions: (selector: (sessions: {
      readonly ids: readonly string[]
      readonly byId: Readonly<Record<string, { readonly cwd?: string }>>
    }) => string | undefined): string | undefined => selector({ ids: ['s1'], byId: { s1: { cwd: '/w' } } }),
    discover: async () => state.discovery ?? EMPTY_DISCOVERY,
    installations: async () => ({ kicad: { configured } }),
    saveInstallation: async () => {},
    configForm: () => form,
    openDestination: noop,
    openNative: async () => {},
  } as unknown as HardwareProps
}

/**
 * Render the body and return the panel root.
 * @param state - viewer state the fake store answers with.
 * @param params - the navigation the tab record carries.
 * @returns the mounted root and the panel element.
 */
async function mount(state: HardwareState, params: ViewerNavigationParams, configured = false): Promise<{ root: Root; panel: HTMLElement }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<HardwareViewerBody {...props(state, params, configured)} />) })
  const panel = container.querySelector<HTMLElement>('[data-hardware-destination]')
  if (panel === null) throw new Error('the viewer body did not render a panel')
  return { root, panel }
}

describe('viewer panel header', () => {
  it('is the panel’s first row, carrying the five destinations in order', async () => {
    const { root, panel } = await mount(
      { activeDestination: 'pcb', revision: 1, discovery: BOARD_LESS },
      { destination: 'pcb', navigationRevision: 1 },
    )
    const header = panel.firstElementChild
    // The first child is the keyframes <style>; the header is the first row.
    const row = header?.tagName === 'STYLE' ? panel.children[1] : header
    expect(row?.hasAttribute('data-hardware-header')).toBe(true)
    const labels = [...(row?.querySelectorAll('[data-destination]') ?? [])].map(node => node.textContent)
    expect(labels).toEqual(['原理图', 'PCB', 'BOM', '3D 模型', '下单'])
    // Nothing above it: no tab strip, no second navigator inside the body.
    expect(panel.querySelector('[data-hardware-nav]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})

describe('empty destination', () => {
  it('centres one placeholder that names the artifact and points at the agent', async () => {
    const { root, panel } = await mount(
      { activeDestination: 'pcb', revision: 1, discovery: BOARD_LESS },
      { destination: 'pcb', navigationRevision: 1 },
    )
    const card = panel.querySelector<HTMLElement>('[data-hardware-state="missing"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain(COPY.placeholder.title.pcb)
    expect(card?.textContent).toContain(COPY.discovery.noBoard)

    const guidance = card?.querySelector('[data-hardware-guidance]')
    expect(guidance?.textContent).toBe(COPY.placeholder.guide.pcb)

    // Centred on both axes, which is what the BOM stage used to miss.
    expect(card?.style.alignItems).toBe('center')
    expect(card?.style.justifyContent).toBe('center')
    await act(async () => { root.unmount() })
  })

  it('tells the user to ask the agent for a project when the workspace has none', async () => {
    const { root, panel } = await mount(
      { activeDestination: 'schematic', revision: 1, discovery: EMPTY_DISCOVERY },
      { destination: 'schematic', navigationRevision: 1 },
    )
    const card = panel.querySelector<HTMLElement>('[data-hardware-state="missing"]')
    expect(card?.textContent).toContain(COPY.placeholder.noProject)
    expect(card?.textContent).toContain(COPY.placeholder.title.schematic)
    await act(async () => { root.unmount() })
  })

  it('centres the BOM stage’s placeholder like every other destination', async () => {
    // A failed BOM export is the state that used to say "不可用" at the stage's
    // left edge.
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 500,
      json: async () => ({ ok: false, error: { code: 'export-failed', message: 'kicad-cli exit 1' } }),
    }))
    try {
      const { root, panel } = await mount(
        { activeDestination: 'bom', revision: 1, discovery: BOARD_LESS },
        { destination: 'bom', navigationRevision: 1 },
        // A configured KiCad: the failure is the export, not the installation,
        // so the placeholder carries the agent guidance.
        true,
      )
      const stage = panel.querySelector<HTMLElement>('[data-hardware-bom] [data-hardware-stage]')
      expect(stage).not.toBeNull()
      expect(stage?.textContent).toContain(COPY.placeholder.title.bom)
      expect(stage?.textContent).toContain(COPY.placeholder.guide.bom)
      expect(stage?.style.alignItems).toBe('center')
      expect(stage?.style.justifyContent).toBe('center')
      // Fills the row box it sits in, which is what centres it horizontally.
      expect(stage?.style.flex).toContain('1 1 auto')
      await act(async () => { root.unmount() })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
