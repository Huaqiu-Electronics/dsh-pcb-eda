/**
 * Browser half of `@huaqiu/dsh-hardware-ui`.
 *
 * Occupies existing DSH seats only: a root navigation occupant, a session
 * header action, a `keepMounted` right-panel tab body, and a settings section.
 * The shape below is structural on purpose: this package stays independently
 * installable and does not import DSH internals.
 */
import {
  ContextualOpenAction, EngineeringNav, HardwareSettingsSection, HardwareViewerBody,
} from './components.js'
import type {
  ConfigFormLike, HardwareActions, HardwareDestination, HardwareInjected,
  HardwareInstallationConfig, NativeApplication,
} from './model.js'
import { createHardwareStore } from './store.js'
import { loadInstallations, loadProjects, openArtifact } from './transport.js'

/** Real Cordis service names this browser plugin waits for. */
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'configForms'] as const

export const HARDWARE_SETTINGS_ID = 'hardware-engineering'
export const HARDWARE_TAB_ID = '@huaqiu/dsh-hardware-ui'
export const HARDWARE_TAB_KIND = 'hardware-engineering'

interface SlotSpec {
  name: string
  id?: string
  key?: string
  order?: number
  label?: () => string
  store?: unknown
  inject?: (...args: unknown[]) => unknown
}

interface ClientContext {
  readonly slots?: {
    inject(key: string, callback: () => () => void): () => void
    register(spec: SlotSpec, component: unknown): () => void
  }
  readonly sidebarRight?: {
    openTab(kind: string, options?: {
      params?: Readonly<Record<string, unknown>>
      revealIfOpened?: boolean
    }): void
  }
  readonly sidebarRightTabs?: {
    register(definition: {
      id: string
      kind: string
      keepMounted?: boolean
      title: (address: string) => string
    }): () => void
  }
  readonly configForms?: {
    get<T>(entryId: string): ConfigFormLike<T>
  }
  effect?(fn: () => (() => void) | void, label?: string): void
}

function kindForPath(path: string): string {
  if (path.endsWith('.kicad_sch')) return 'schematic'
  if (path.endsWith('.kicad_pcb')) return 'pcb'
  if (path.endsWith('.kicad_pro')) return 'project'
  if (/\.(step|stp|glb)$/iu.test(path)) return 'mechanical-3d'
  return 'bom'
}

/** Install all product UI contributions on a DSH client context. */
export function apply(ctx: ClientContext): void {
  const store = createHardwareStore()
  let actions: HardwareActions | undefined
  let revision = 0
  const effect = (fn: () => (() => void) | void, label: string): void => {
    if (ctx.effect !== undefined) ctx.effect(fn, label)
    else fn()
  }

  const captureActions = (...args: unknown[]): { hooks: HardwareInjected } => {
    for (const candidate of args) {
      if (candidate !== null && typeof candidate === 'object'
        && typeof (candidate as HardwareActions).setActive === 'function') {
        actions = candidate as HardwareActions
      }
    }
    return { hooks: injected }
  }

  const injected: HardwareInjected = {
    async refreshDiscovery(cwd, project) {
      try {
        const result = await loadProjects(cwd, project)
        actions?.setDiscovery(result)
        if (result.issue?.code === 'bad-manifest') actions?.setNotice(result.issue.message)
      } catch (error) {
        actions?.setNotice(`Artifact discovery failed: ${String(error)}`)
      }
    },
    openDestination(destination: HardwareDestination, path) {
      revision += 1
      const kind = path === undefined ? undefined : kindForPath(path)
      try {
        ctx.sidebarRight?.openTab(HARDWARE_TAB_KIND, {
          params: { destination, path, kind, revision },
          revealIfOpened: true,
        })
      } catch (error) {
        actions?.setNotice(`Open viewer failed: ${String(error)}`)
      }
    },
    async openNative(application?: NativeApplication, artifactPath?: string) {
      if (artifactPath === undefined || artifactPath === '') {
        actions?.setNotice('Select an artifact before opening a native application.')
        return
      }
      try {
        await openArtifact({
          application: application ?? 'kicad',
          artifactPath,
          kind: kindForPath(artifactPath),
        })
      } catch (error) {
        actions?.setNotice(`Native launch failed: ${String(error)}`)
        throw error
      }
    },
    async saveInstallation(application, root) {
      const form = ctx.configForms?.get<HardwareInstallationConfig>('hardware-artifacts')
      if (form === undefined) throw new Error('host settings are unavailable')
      const field = application === 'kicad' ? 'kicadRoot' : 'solidcraftRoot'
      const accepted = await form.set(field, root)
      if (!accepted) throw new Error(`the host rejected the ${field} setting`)
    },
    async fetchInstallations() {
      try {
        actions?.setInstallations(await loadInstallations())
      } catch (error) {
        actions?.setNotice(`Installation check failed: ${String(error)}`)
      }
    },
    useConfigForm() {
      return ctx.configForms?.get<HardwareInstallationConfig>('hardware-artifacts')
    },
  }

  effect(() => ctx.sidebarRightTabs?.register({
    id: HARDWARE_TAB_ID,
    kind: HARDWARE_TAB_KIND,
    keepMounted: true,
    title: () => 'Hardware Engineering',
  }) ?? (() => {}), 'hardware-ui: right-panel tab type')

  const slots = ctx.slots
  if (slots === undefined) return

  effect(() => slots.inject('conversation.header.leading', () => slots.register({
    name: 'conversation.header.leading',
    store,
    inject: captureActions,
  }, EngineeringNav)), 'hardware-ui: six-destination navigation')

  effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: HARDWARE_TAB_ID,
    store,
    inject: captureActions,
  }, HardwareViewerBody)), 'hardware-ui: viewer body')

  effect(() => slots.inject('conversation.session.header.corner', () => slots.register({
    name: 'conversation.session.header.corner',
    store,
    inject: captureActions,
  }, ContextualOpenAction)), 'hardware-ui: contextual native action')

  effect(() => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: HARDWARE_SETTINGS_ID,
    order: 85,
    label: () => 'Hardware Engineering',
    store,
    inject: captureActions,
  }, HardwareSettingsSection)), 'hardware-ui: CAD installation settings')
}
