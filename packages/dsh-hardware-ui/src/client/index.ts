/**
 * Browser half of `@huaqiu/dsh-hardware-ui`.
 *
 * Occupies existing DSH seats only: one `keepMounted` right-panel tab body and
 * one settings section. Native open lives inside the viewer with the resolved
 * artifact in scope, so no conversation-level action is registered — and no
 * conversation-level navigation either: the panel's own header IS the product's
 * navigation, so nothing duplicates it above the conversation.
 *
 * The tab type declares itself the panel's default page (`default: true`), so
 * expanding the column opens Hardware Engineering instead of the guide. Inside
 * the panel there is no tab strip: the page's header is the panel's top edge and
 * the host lays the two panel controls (full screen, collapse) over its end.
 *
 * Two store handles, not one: DSH pins a handle to a single slot scope, and
 * `settings.section` is `root` while `sidebar.right.pane.tab` is `session`.
 * Mounting one handle in both scopes is rejected at load time ("one handle, one
 * scope").
 */
import { HardwareSettingsSection, HardwareViewerBody } from './components.js'
import type {
  ConfigFormLike, HardwareController, HardwareDestination, HardwareInstallationConfig,
  ViewerNavigationParams,
} from './model.js'
import { createHardwareStore } from './store.js'
import { COPY } from './copy.js'
import { loadInstallations, loadProjects, openArtifact } from './transport.js'

/** Real Cordis service names this browser plugin waits for. */
export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'configForms'] as const

export const HARDWARE_SETTINGS_ID = 'hardware-engineering'
export const HARDWARE_TAB_ID = '@huaqiu/dsh-hardware-ui'
export const HARDWARE_TAB_KIND = 'hardware-engineering'
/** Host plugin row id whose volatile config backs the product settings page. */
export const HARDWARE_CONFIG_ENTRY = 'hardware-artifacts'

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
      /**
       * Seed this kind into a fresh docked pane, i.e. make it the page the
       * expand button opens. At most one registered type may declare it.
       */
      default?: boolean
    }): () => void
  }
  readonly configForms?: {
    get<T>(entryId: string): ConfigFormLike<T>
  }
  effect?(fn: () => (() => void) | void, label?: string): void
}

/** Artifact kind discriminator carried in navigation params. */
export function kindForPath(path: string): string {
  if (path.toLowerCase().endsWith('.kicad_sch')) return 'schematic'
  if (path.toLowerCase().endsWith('.kicad_pcb')) return 'pcb'
  if (path.toLowerCase().endsWith('.kicad_pro')) return 'project'
  return 'bom'
}

/** Destination-specific artifact kind used by the host `open` route. */
function nativeKindFor(destination: HardwareDestination, path: string): string {
  if (destination === '3d') return 'pcb-3d'
  if (destination === 'bom') return 'bom'
  return kindForPath(path)
}

/** Install all product UI contributions on a DSH client context. */
export function apply(ctx: ClientContext): void {
  // Root scope: the settings section. The viewer owns the session scope below.
  const rootStore = createHardwareStore()
  // Session scope: each viewer owns its own selection/discovery state.
  const viewerStore = createHardwareStore()
  let navigation = 0
  const effect = (fn: () => (() => void) | void, label: string): void => {
    if (ctx.effect !== undefined) ctx.effect(fn, label)
    else fn()
  }

  const controller: HardwareController = {
    discover(cwd, project, session) {
      return loadProjects(cwd, project, session)
    },
    installations() {
      return loadInstallations()
    },
    async saveInstallation(application, root) {
      const form = ctx.configForms?.get<HardwareInstallationConfig>(HARDWARE_CONFIG_ENTRY)
      if (form === undefined) throw new Error(COPY.settings.hostSettingsUnavailable)
      const field = application === 'kicad' ? 'kicadRoot' : 'solidcraftRoot'
      const accepted = await form.set(field, root)
      if (!accepted) {
        throw new Error(COPY.settings.hostRejected(application === 'kicad' ? 'KiCad' : 'SolidCraft'))
      }
    },
    configForm() {
      return ctx.configForms?.get<HardwareInstallationConfig>(HARDWARE_CONFIG_ENTRY)
    },
    openDestination(destination, path) {
      navigation += 1
      const kind = path === undefined ? undefined : kindForPath(path)
      const params: ViewerNavigationParams = {
        destination,
        ...(path === undefined ? {} : { path }),
        ...(kind === undefined ? {} : { kind }),
        navigationRevision: navigation,
      }
      ctx.sidebarRight?.openTab(HARDWARE_TAB_KIND, {
        params: params as unknown as Readonly<Record<string, unknown>>,
        revealIfOpened: true,
      })
    },
    async openNative(request) {
      await openArtifact({
        application: request.application,
        artifactPath: request.artifactPath,
        kind: request.kind,
      })
    },
  }

  effect(() => ctx.sidebarRightTabs?.register({
    id: HARDWARE_TAB_ID,
    kind: HARDWARE_TAB_KIND,
    keepMounted: true,
    // The panel's default page: an expansion seeds this kind into the empty
    // docked pane, replacing the product's general-purpose start page.
    default: true,
    title: () => COPY.product.name,
  }) ?? (() => {}), 'hardware-ui: right-panel tab type')

  const slots = ctx.slots
  if (slots === undefined) return

  effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: HARDWARE_TAB_ID,
    store: viewerStore,
    inject: () => controller,
  }, HardwareViewerBody)), 'hardware-ui: viewer body')

  effect(() => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: HARDWARE_SETTINGS_ID,
    order: 85,
    label: () => COPY.product.name,
    store: rootStore,
    inject: () => controller,
  }, HardwareSettingsSection)), 'hardware-ui: CAD installation settings')
}
