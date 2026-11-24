import { describe, expect, it, vi } from 'vitest'

// The renderer and Three.js are browser-only (canvas/WebGL/`window`). These
// tests exercise registration and state logic, so the canvas layer is stubbed
// rather than loaded in Node.
vi.mock('@huaqiu/ecad-renderer', () => ({
  renderSchematic: async () => ({ canvas: {}, viewer: {}, dispose: () => {} }),
  renderPcb: async () => ({ canvas: {}, viewer: {}, dispose: () => {} }),
}))
vi.mock('three', () => {
  class Stub {
    domElement = { style: {}, addEventListener() {}, removeEventListener() {} }
    setFromObject() { return this }
    getCenter() { return { x: 0, y: 0, z: 0 } }
    getSize() { return { x: 1, y: 1, z: 1 } }
    add() {}
    clear() {}
    lookAt() {}
    updateProjectionMatrix() {}
    dispose() {}
    setPixelRatio() {}
    setSize() {}
    render() {}
  }
  return {
    AmbientLight: Stub, DirectionalLight: Stub, Color: Stub, Scene: Stub,
    Box3: Stub, PerspectiveCamera: Stub, Vector3: Stub, WebGLRenderer: Stub,
  }
})
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({ GLTFLoader: class { async loadAsync() { return { scene: { traverse() {} }, scenes: [] } } } }))

import { apply, HARDWARE_TAB_ID, HARDWARE_TAB_KIND, kindForPath } from '../src/client/index.js'
import { selectedArtifact } from '../src/client/components.js'
import { DESTINATIONS, DESTINATION_LABELS, applicationFor } from '../src/client/model.js'
import { createHardwareStore } from '../src/client/store.js'
import { wizardPhase } from '../src/client/wizard.js'

interface Registration {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly store?: unknown
  readonly inject?: (...args: unknown[]) => Record<string, unknown>
}

function fakeContext(): {
  registrations: Registration[]
  tabTypes: unknown[]
  context: Parameters<typeof apply>[0]
} {
  const registrations: Registration[] = []
  const tabTypes: unknown[] = []
  const context = {
    slots: {
      inject: (_key: string, callback: () => () => void) => callback(),
      register: (spec: Registration) => {
        registrations.push(spec)
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition: unknown) => {
        tabTypes.push(definition)
        return () => {}
      },
    },
    effect: (fn: () => (() => void) | void) => { fn() },
  }
  return { registrations, tabTypes, context }
}

describe('client slot registrations', () => {
  it('uses only supported DSH seats and no conversation-level native action', () => {
    const { registrations, tabTypes, context } = fakeContext()
    apply(context)
    expect(registrations.map(entry => entry.name)).toEqual([
      'conversation.header.leading',
      'sidebar.right.pane.tab',
      'settings.section',
    ])
    expect(registrations.map(entry => entry.name)).not.toContain('conversation.session.header.corner')
    expect(registrations[1]?.key).toBe(HARDWARE_TAB_ID)
    expect(tabTypes).toEqual([{
      id: HARDWARE_TAB_ID,
      kind: HARDWARE_TAB_KIND,
      keepMounted: true,
      title: expect.any(Function),
    }])
  })

  it('never mounts one store handle in two scopes', () => {
    const { registrations, context } = fakeContext()
    apply(context)
    const [nav, viewer, settings] = registrations
    // Both root seats share one instance; the session seat must not.
    expect(nav?.store).toBe(settings?.store)
    expect(viewer?.store).not.toBe(nav?.store)
  })

  it('delivers the controller verbatim instead of a hooks compartment', () => {
    const { registrations, context } = fakeContext()
    apply(context)
    for (const registration of registrations) {
      const face = registration.inject?.()
      expect(face).toBeDefined()
      // A `hooks` member would be rebound into `use<Name>` selector hooks and
      // the component would never see its functions.
      expect(Object.keys(face ?? {})).not.toContain('hooks')
      expect(face?.openDestination).toBeTypeOf('function')
      expect(face?.discover).toBeTypeOf('function')
    }
  })
})

describe('five destinations', () => {
  it('exposes exactly the persistent product destinations', () => {
    expect(DESTINATIONS).toEqual(['schematic', 'pcb', 'bom', '3d', 'order'])
    expect(Object.keys(DESTINATION_LABELS)).toEqual([...DESTINATIONS])
  })

  it('maps every preview destination to KiCad and leaves order without a native action', () => {
    expect(applicationFor('schematic')).toBe('kicad')
    expect(applicationFor('pcb')).toBe('kicad')
    expect(applicationFor('bom')).toBe('kicad')
    expect(applicationFor('3d')).toBe('kicad')
    expect(applicationFor('order')).toBeUndefined()
  })

  it('classifies artifact kinds without inventing a mechanical destination', () => {
    expect(kindForPath('/x/main.kicad_sch')).toBe('schematic')
    expect(kindForPath('/x/main.kicad_pcb')).toBe('pcb')
    expect(kindForPath('/x/main.kicad_pro')).toBe('project')
  })
})

describe('product store', () => {
  it('keeps canonical artifact paths and bumps revision on selection', () => {
    const store = createHardwareStore()
    const first = store.create()
    expect(first.getSnapshot().activeDestination).toBe('schematic')
    first.actions.setActive('pcb')
    first.actions.selectArtifact('/tmp/power.kicad_pcb', 'pcb')
    expect(first.getSnapshot()).toMatchObject({
      activeDestination: 'pcb',
      pcbPath: '/tmp/power.kicad_pcb',
      revision: 2,
    })
    let notified = 0
    const off = first.subscribe(() => { notified += 1 })
    first.actions.setActive('bom')
    off()
    first.actions.setActive('3d')
    expect(notified).toBe(1)
  })

  it('resets artifact selections when a project is adopted', () => {
    const store = createHardwareStore()
    const instance = store.create()
    instance.actions.setDiscovery({
      cwd: '/w',
      projects: [{
        path: '/w/a.kicad_pro', name: 'a',
        schematic: { id: 'schematic:/w/a.kicad_sch', kind: 'schematic', path: '/w/a.kicad_sch', title: 'a.kicad_sch' },
        sheets: [],
        boards: [{ id: 'pcb:/w/a.kicad_pcb', kind: 'pcb', path: '/w/a.kicad_pcb', title: 'a.kicad_pcb' }],
        defaultBoard: '/w/a.kicad_pcb',
        selectionRequired: false,
      }],
      selected: {
        path: '/w/a.kicad_pro', name: 'a',
        schematic: { id: 'schematic:/w/a.kicad_sch', kind: 'schematic', path: '/w/a.kicad_sch', title: 'a.kicad_sch' },
        sheets: [],
        boards: [{ id: 'pcb:/w/a.kicad_pcb', kind: 'pcb', path: '/w/a.kicad_pcb', title: 'a.kicad_pcb' }],
        defaultBoard: '/w/a.kicad_pcb',
        selectionRequired: false,
      },
    })
    expect(instance.getSnapshot()).toMatchObject({
      projectPath: '/w/a.kicad_pro',
      schematicPath: '/w/a.kicad_sch',
      pcbPath: '/w/a.kicad_pcb',
    })
  })

  it('adopts a navigation without needing a remount', () => {
    const store = createHardwareStore()
    const instance = store.create()
    instance.actions.applyNavigation({ destination: 'pcb', path: '/w/b.kicad_pcb', navigationRevision: 1 })
    expect(instance.getSnapshot()).toMatchObject({
      activeDestination: 'pcb',
      pcbPath: '/w/b.kicad_pcb',
    })
    const before = instance.getSnapshot().revision
    instance.actions.applyNavigation({ destination: 'pcb', path: '/w/b.kicad_pcb', navigationRevision: 2 })
    expect(instance.getSnapshot().revision).toBeGreaterThan(before)
  })

  it('keeps a navigated artifact when discovery refreshes', () => {
    const store = createHardwareStore()
    const instance = store.create()
    instance.actions.applyNavigation({ destination: 'schematic', path: '/w/child.kicad_sch', navigationRevision: 1 })
    instance.actions.setDiscovery({
      cwd: '/w',
      selected: {
        path: '/w/a.kicad_pro', name: 'a',
        schematic: { id: 'schematic:/w/a.kicad_sch', kind: 'schematic', path: '/w/a.kicad_sch', title: 'a.kicad_sch' },
        sheets: [],
        boards: [{ id: 'pcb:/w/a.kicad_pcb', kind: 'pcb', path: '/w/a.kicad_pcb', title: 'a.kicad_pcb' }],
        defaultBoard: '/w/a.kicad_pcb',
        selectionRequired: false,
      },
    }, true)
    expect(instance.getSnapshot().schematicPath).toBe('/w/child.kicad_sch')
    expect(instance.getSnapshot().projectPath).toBe('/w/a.kicad_pro')
  })

  /**
   * Regression: a preserved selection belongs to one workspace. Keeping it
   * after the workspace moved left the panel reading a path the host no longer
   * authorizes — "artifact is outside the authorized workspace".
   */
  it('drops a preserved selection when the workspace moved', () => {
    const store = createHardwareStore()
    const instance = store.create()
    const project = (root: string) => ({
      path: `${root}/a.kicad_pro`, name: 'a',
      schematic: { id: `schematic:${root}/a.kicad_sch`, kind: 'schematic', path: `${root}/a.kicad_sch`, title: 'a.kicad_sch' },
      sheets: [],
      boards: [{ id: `pcb:${root}/a.kicad_pcb`, kind: 'pcb', path: `${root}/a.kicad_pcb`, title: 'a.kicad_pcb' }],
      defaultBoard: `${root}/a.kicad_pcb`,
      selectionRequired: false,
    })
    instance.actions.setDiscovery({ cwd: '/old', projects: [project('/old')], selected: project('/old') })
    instance.actions.applyNavigation({ destination: 'schematic', path: '/old/child.kicad_sch', navigationRevision: 1 })

    instance.actions.setDiscovery({ cwd: '/new', projects: [project('/new')], selected: project('/new') }, true)
    expect(instance.getSnapshot()).toMatchObject({
      workspaceRoot: '/new',
      projectPath: '/new/a.kicad_pro',
      schematicPath: '/new/a.kicad_sch',
      pcbPath: '/new/a.kicad_pcb',
    })
  })

  it('drops every selection when the new workspace has no project', () => {
    const store = createHardwareStore()
    const instance = store.create()
    instance.actions.applyNavigation({ destination: 'pcb', path: '/old/a.kicad_pcb', navigationRevision: 1 })
    instance.actions.setDiscovery({ cwd: '/old', projects: [] })
    instance.actions.setDiscovery({ cwd: '/new', projects: [] }, true)
    expect(instance.getSnapshot().pcbPath).toBeUndefined()
    expect(instance.getSnapshot().workspaceRoot).toBe('/new')
  })
})

/**
 * Regression: the wizard is a full-screen modal, and it used to mount on the
 * pre-hydration facts (`status: 'loading'`, no probe yet) and unmount the moment
 * the real answer arrived. That show-then-hide is the flash on first launch and
 * on every browser refresh.
 */
describe('first-run wizard gating', () => {
  const firstRun = {
    hasForm: true, status: 'ready', onboardingComplete: false, kicadConfigured: false, dismissed: false,
  }

  it('opens on a genuine first run', () => {
    expect(wizardPhase(firstRun)).toBe('open')
  })

  it('mounts nothing while the host config is still syncing', () => {
    expect(wizardPhase({ ...firstRun, status: 'loading' })).toBe('waiting')
    // The value is absent while loading, so "not completed yet" must not be read
    // out of it.
    expect(wizardPhase({ ...firstRun, status: 'loading', onboardingComplete: true })).toBe('waiting')
  })

  it('mounts nothing while the install probe is in flight', () => {
    expect(wizardPhase({ ...firstRun, kicadConfigured: undefined })).toBe('waiting')
  })

  it('stays shut once the host recorded completion, with no probe needed', () => {
    expect(wizardPhase({ ...firstRun, onboardingComplete: true, kicadConfigured: undefined })).toBe('completed')
  })

  it('never flashes on a machine whose KiCad already validates', () => {
    expect(wizardPhase({ ...firstRun, kicadConfigured: true })).toBe('configured')
  })

  it('honours a dismissal even when the config write has not landed', () => {
    expect(wizardPhase({ ...firstRun, dismissed: true })).toBe('dismissed')
    expect(wizardPhase({ ...firstRun, dismissed: true, status: 'loading' })).toBe('dismissed')
  })

  it('renders nowhere without a host config form', () => {
    expect(wizardPhase({ ...firstRun, hasForm: false })).toBe('no-form')
  })
})

describe('artifact resolution per destination', () => {
  const state = {
    activeDestination: 'schematic' as const,
    schematicPath: '/w/main.kicad_sch',
    pcbPath: '/w/main.kicad_pcb',
    revision: 1,
  }

  it('resolves 3D from the board and BOM from the schematic', () => {
    expect(selectedArtifact(state, '3d')?.path).toBe('/w/main.kicad_pcb')
    expect(selectedArtifact(state, 'bom')?.path).toBe('/w/main.kicad_sch')
    expect(selectedArtifact(state, 'pcb')?.path).toBe('/w/main.kicad_pcb')
  })

  it('resolves nothing when no artifact is selected', () => {
    const empty = { activeDestination: 'schematic' as const, revision: 0 }
    expect(selectedArtifact(empty, 'pcb')).toBeUndefined()
  })
})
