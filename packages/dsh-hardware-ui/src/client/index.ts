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
import { installDocumentPreviews } from './document/index.js'
import { setOrderPageOpener } from './order-page.js'
import { ORDER_TAB_ID, ORDER_TAB_KIND, OrderTabBody, orderTabRegistration } from './order-tab.js'
import { OrderWatcher } from './order-watcher.js'
import type { DocumentClientContext, WorkspaceFilesRemote } from './document/contract.js'
import type { ProbeSheetFile } from './document/EcadBody.js'

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
      /** One tab per order; without it every order would share one page. */
      multiple?: boolean
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
  /**
   * Workspace byte reads, used to resolve the child sheets a schematic declares.
   *
   * Readable only from inside a nested `inject(['remote', …])` scope: Cordis
   * throws `cannot get property "remote" without inject` on a direct access, and
   * declaring `remote` on the whole plugin would drop the product panel on a
   * Host that has no client remote.
   */
  readonly remote?: { readonly workspaceFiles?: WorkspaceFilesRemote }
  /** DSH's document-renderer registry; absent on a Host without document previews. */
  readonly documentPreviews?: DocumentClientContext['documentPreviews']
  effect?(fn: () => (() => void) | void, label?: string): void
  inject?(dependencies: readonly string[], callback: (scope: ClientContext) => void): void
}

/** Holder for a dependency that arrives after this plugin installs its renderers. */
interface WorkspaceHolder {
  files?: WorkspaceFilesRemote
}

/**
 * Build the child-sheet probe for the document renderers.
 *
 * Existence is answered by the Host, not by this plugin: a one-byte read through
 * the session's own workspace endpoint either succeeds or reports a structured
 * failure. Nothing here decides what the workspace contains — that is precisely
 * the authority the document preview must not duplicate.
 *
 * The remote is read from a holder, not off the context: the dependency is
 * acquired by nested injection (see `apply`), which resolves after the renderers
 * are registered, and resolving it per mount means a schematic opened later still
 * gets a working probe. While it is absent the factory answers `undefined`, which
 * the body already treats as "list the references, do not claim they exist".
 * @param workspace - holder filled by nested injection once `remote` is available.
 * @returns a per-session probe factory that stays usable across a late dependency.
 */
function sheetProbeFactory(workspace: WorkspaceHolder): (sessionId: string) => ProbeSheetFile | undefined {
  return sessionId => {
    const files = workspace.files
    if (files === undefined) return undefined
    return async (path, signal) => {
      try {
        const result = await files.readBytes(sessionId, path, { range: { offset: 0, length: 1 } }, signal)
        return result.ok
      } catch {
        return false
      }
    }
  }
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
    id: ORDER_TAB_ID,
    kind: ORDER_TAB_KIND,
    multiple: true,
    title: () => COPY.order.tabTitle,
  }) ?? (() => {}), 'hardware-ui: order tab type')

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

  effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
    orderTabRegistration() as never,
    OrderTabBody,
  )), 'hardware-ui: order page body')

  effect(() => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: HARDWARE_SETTINGS_ID,
    order: 85,
    label: () => COPY.product.name,
    store: rootStore,
    inject: () => controller,
  }, HardwareSettingsSection)), 'hardware-ui: CAD installation settings')

  // An order page belongs in the panel beside its board, not in the OS browser.
  // `browser` is DSH's own tab kind; when this Host has no sidebar or no such
  // kind, the opener reports failure and `openOrderPage` falls back, so a placed
  // order is never lost to a missing tab.
  setOrderPageOpener(url => {
    const tabs = ctx.sidebarRight
    if (tabs === undefined) return false
    tabs.openTab(ORDER_TAB_KIND, { params: { url }, revealIfOpened: true })
    return true
  })

  // Agent-driven orders end in a tool result, which no client code sees. The
  // watcher reads the transcript and opens the page through the same opener.
  effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
    name: 'conversation.session.header.actions',
    id: 'hardware-ui-order-watcher',
    order: 999,
    inject: () => ({}),
  }, OrderWatcher)), 'hardware-ui: order page in a Browser tab')

  // Document renderers ride DSH's own document pipeline: they contribute four
  // registry entries and four bodies, and nothing else. Installed through a
  // nested injection so a Host without the document-preview service loses only
  // the ECAD previews, not the product panel.
  //
  // The same applies to the child-sheet probe's dependency: `remote` is acquired
  // in its own nested injection rather than read off `ctx` (Cordis throws on an
  // undeclared access) or declared plugin-wide (which would take the product
  // panel down with it on a Host without a client remote).
  const workspace: WorkspaceHolder = {}
  const documentOptions = { probeSheet: sheetProbeFactory(workspace) }
  if (ctx.inject !== undefined) {
    ctx.inject(['remote', 'remote.workspaceFiles'], (scope) => {
      workspace.files = scope.remote?.workspaceFiles
    })
    ctx.inject(['documentPreviews'], (scope) => {
      installDocumentPreviews(scope as unknown as DocumentClientContext, documentOptions)
    })
  } else {
    installDocumentPreviews(ctx as unknown as DocumentClientContext, documentOptions)
  }
}
