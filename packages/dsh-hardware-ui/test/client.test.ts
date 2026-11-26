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
import { openOrderPage } from '../src/client/order-page.js'
import { missingState, selectedArtifact } from '../src/client/components.js'
import { DESTINATIONS, DESTINATION_LABELS, applicationFor } from '../src/client/model.js'
import { createHardwareStore } from '../src/client/store.js'
import { COPY } from '../src/client/copy.js'
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
      // The product page, then the order-page tab body.
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab',
      'settings.section',
      // Renders nothing: it only watches tool results for an order URL so the
      // page can open in a tab. It is not a conversation action.
      'conversation.session.header.actions',
    ])
    expect(registrations.map(entry => entry.name)).not.toContain('conversation.session.header.corner')
    // The panel's header is the only navigation: a second one above the
    // conversation would be a duplicate, so the seat is gone.
    expect(registrations.map(entry => entry.name)).not.toContain('conversation.header.leading')
    expect(registrations[0]?.key).toBe(HARDWARE_TAB_ID)
    expect(tabTypes).toHaveLength(2)
    // The order page is its own tab type so one order never replaces another.
    expect(tabTypes[0]).toMatchObject({ kind: 'hardware-order', multiple: true })
    expect(tabTypes[1]).toEqual({
      id: HARDWARE_TAB_ID,
      kind: HARDWARE_TAB_KIND,
      keepMounted: true,
      default: true,
      title: expect.any(Function),
    })
  })

  it('declares itself the panel default page so the expand button opens it', () => {
    const { tabTypes, context } = fakeContext()
    apply(context)
    expect(tabTypes).toContainEqual(expect.objectContaining({ kind: HARDWARE_TAB_KIND, default: true }))
    // Exactly one type may claim the default page.
    expect(tabTypes.filter(entry => (entry as { default?: boolean }).default === true)).toHaveLength(1)
  })

  it('never mounts one store handle in two scopes', () => {
    const { registrations, context } = fakeContext()
    apply(context)
    const [viewer, settings] = registrations
    // The session seat and the root seat must not share an instance.
    expect(viewer?.store).toBeDefined()
    expect(viewer?.store).not.toBe(settings?.store)
  })

  it('delivers the controller verbatim instead of a hooks compartment', () => {
    const { registrations, context } = fakeContext()
    apply(context)
    // The watcher injects nothing; the product seats carry the controller.
    for (const registration of registrations.filter(entry => entry.store !== undefined)) {
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

/**
 * Empty viewers must not stop at "not available": hardware is authored in the
 * conversation, so every placeholder ends with the way to get the artifact.
 */
describe('empty viewer placeholders', () => {
  const project = {
    path: '/w/a.kicad_pro', name: 'a',
    schematic: { id: 'schematic:/w/a.kicad_sch', kind: 'schematic', path: '/w/a.kicad_sch', title: 'a.kicad_sch' },
    sheets: [],
    boards: [{ id: 'pcb:/w/a.kicad_pcb', kind: 'pcb', path: '/w/a.kicad_pcb', title: 'a.kicad_pcb' }],
    defaultBoard: '/w/a.kicad_pcb',
    selectionRequired: false,
  }

  it('says nothing before discovery has answered', () => {
    expect(missingState({ activeDestination: 'schematic', revision: 0 }, 'schematic')).toBeUndefined()
  })

  it('points at the agent when the workspace has no project', () => {
    const view = missingState({ activeDestination: 'schematic', revision: 1, discovery: { cwd: '/w', projects: [] } }, 'schematic')
    expect(view?.title).toBe(COPY.placeholder.title.schematic)
    expect(view?.guidance).toBe(COPY.placeholder.noProject)
  })

  it('gives each destination its own title and guide', () => {
    const board = { ...project, schematic: undefined, boards: [] }
    const state = { activeDestination: 'schematic' as const, revision: 1, discovery: { cwd: '/w', projects: [board], selected: board } }
    for (const destination of DESTINATIONS) {
      const view = missingState(state, destination)
      expect(view?.title, destination).toBe(COPY.placeholder.title[destination])
      expect(view?.guidance, destination).toBe(COPY.placeholder.guide[destination])
    }
  })

  it('explains that the BOM follows the schematic', () => {
    const boardOnly = { ...project, schematic: undefined }
    const view = missingState(
      { activeDestination: 'bom', revision: 1, discovery: { cwd: '/w', projects: [boardOnly], selected: boardOnly } },
      'bom',
    )
    expect(view?.title).toBe(COPY.placeholder.title.bom)
    expect(view?.guidance).toContain('原理图')
    expect(view?.guidance).toContain('自动')
  })

  it('leaves the instruction off a workspace choice the user can see', () => {
    const other = { ...project, path: '/w/b.kicad_pro', name: 'b' }
    const view = missingState(
      {
        activeDestination: 'pcb', revision: 1,
        discovery: {
          cwd: '/w', projects: [project, other],
          issue: { code: 'selection-required', message: '2 projects found; select one explicitly' },
        },
      },
      'pcb',
    )
    expect(view?.reason).toBe(COPY.discovery.selectionRequiredCount(2))
    expect(view?.guidance).toBeUndefined()
  })

  it('renders the artifact instead of a placeholder once it exists', () => {
    expect(missingState(
      { activeDestination: 'pcb', revision: 1, discovery: { cwd: '/w', projects: [project], selected: project } },
      'pcb',
    )).toBeUndefined()
  })
})

describe('order page tab', () => {
  it('opens a placed order in its own tab kind, passing the URL as a parameter', () => {
    const opened: { kind: string; params?: Readonly<Record<string, unknown>> }[] = []
    const { context } = fakeContext()
    apply({
      ...context,
      sidebarRight: {
        openTab: (kind, options) => { opened.push({ kind, ...(options?.params === undefined ? {} : { params: options.params }) }) },
      },
    })
    openOrderPage('https://www.hqpcb.com/mycenter/orders/pcb/quote?id=7')
    expect(opened).toEqual([
      { kind: 'hardware-order', params: { url: 'https://www.hqpcb.com/mycenter/orders/pcb/quote?id=7' } },
    ])
  })
})

describe('Cordis service access', () => {
  // Cordis contexts throw on any property that was not declared, which is how a
  // direct `ctx.remote` read took the whole plugin down at load time:
  // "cannot get property \"remote\" without inject". This proxy reproduces that
  // rule so the regression is caught here instead of in the product panel.
  const INTRINSIC = ['effect', 'inject', 'get', 'then']

  function strictContext(services: Record<string, unknown>): {
    specs: Record<string, unknown>[]
    definitions: { id: string }[]
    ctx: Parameters<typeof apply>[0]
  } {
    const specs: Record<string, unknown>[] = []
    const definitions: { id: string }[] = []
    const resolve = (name: string): unknown => {
      if (name === 'slots') {
        return {
          inject: (_key: string, callback: () => () => void) => callback(),
          register: (spec: Record<string, unknown>) => {
            specs.push(spec)
            return () => {}
          },
        }
      }
      if (name === 'documentPreviews') {
        return {
          register: (definition: { id: string }) => {
            definitions.push(definition)
            return () => {}
          },
        }
      }
      return name.split('.').reduce<unknown>(
        (value, part) => (value as Record<string, unknown> | undefined)?.[part],
        services,
      )
    }
    const make = (allowed: Set<string>): unknown => new Proxy({} as Record<string, unknown>, {
      get(_target, key) {
        const name = String(key)
        if (!allowed.has(name)) throw new Error(`cannot get property "${name}" without inject`)
        if (name === 'effect') return (fn: () => unknown) => { void fn() }
        if (name === 'inject') {
          return (deps: readonly string[], callback: (scope: unknown) => void) => {
            if (!deps.every(dep => resolve(dep) !== undefined)) return
            callback(make(new Set([...allowed, ...deps])))
          }
        }
        return resolve(name)
      },
    })
    // The plugin's own declared dependencies, available for the whole lifecycle.
    return {
      specs, definitions,
      ctx: make(new Set([...INTRINSIC, 'slots', 'locale', 'sidebarRightTabs', 'configForms'])) as Parameters<typeof apply>[0],
    }
  }

  it('installs every renderer without reading an undeclared service', () => {
    const fake = strictContext({})
    // The old code read `ctx.remote` here and threw before any registration ran.
    expect(() => apply(fake.ctx as never)).not.toThrow()
    expect(fake.definitions.map(definition => definition.id)).toEqual([
      '@huaqiu/dsh-hardware-ui/document/schematic',
      '@huaqiu/dsh-hardware-ui/document/pcb',
      '@huaqiu/dsh-hardware-ui/document/step',
    ])
  })

  it('answers the child-sheet probe from the injected workspace remote', async () => {
    const readBytes = vi.fn(async () => ({ ok: true as const, value: null }))
    const fake = strictContext({ remote: { workspaceFiles: { readBytes } } })
    apply(fake.ctx as never)
    const schematic = fake.specs.find(spec => spec.key === '@huaqiu/dsh-hardware-ui/document/schematic')
    const injected = (schematic?.inject as (...args: unknown[]) => Record<string, unknown>)('session-1')
    const probe = injected.probeSheet as (path: string, signal?: AbortSignal) => Promise<boolean>
    expect(await probe('/w/power.kicad_sch')).toBe(true)
    expect(readBytes).toHaveBeenCalledWith(
      'session-1', '/w/power.kicad_sch', { range: { offset: 0, length: 1 } }, undefined,
    )
  })
})
