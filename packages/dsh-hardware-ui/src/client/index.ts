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
import { PlaceOrderBody } from './place-order.js'
import { ToolchainIndicator, ToolchainToastHost } from './toolchain-view.js'
import { TOOLCHAIN_ONBOARDING_STEP, ToolchainOnboarding } from './wizard.js'
import { ToolchainController } from './toolchain.js'
import type {
  ConfigFormLike, HardwareController, HardwareDestination, HardwareInstallationConfig,
  ViewerNavigationParams,
} from './model.js'
import { createHardwareStore } from './store.js'
import { COPY, HARDWARE_UI_NS, installCopyLocale, type CopyLocale } from './copy.js'
import { loadInstallations, loadProjects, openArtifact } from './transport.js'
import { installDocumentPreviews } from './document/index.js'
import { setOrderPageOpener } from './order-page.js'
import { ORDER_TAB_ID, ORDER_TAB_KIND, OrderTabBody, orderTabRegistration } from './order-tab.js'
import { OrderWatcher } from './order-watcher.js'
import type { DocumentClientContext, WorkspaceFilesRemote } from './document/contract.js'
import type { ProbeSheetFile } from './document/EcadBody.js'

/** Real Cordis service names this browser plugin waits for. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'configForms'] as const

export const HARDWARE_SETTINGS_ID = 'hardware-engineering'
export const HARDWARE_TAB_ID = '@huaqiu/dsh-hardware-ui'
export const HARDWARE_TAB_KIND = 'hardware-engineering'
/** The project-selection view that fronts the order destination. */
export const PLACE_ORDER_TAB_ID = '@huaqiu/dsh-hardware-ui/place-order'
export const PLACE_ORDER_TAB_KIND = 'hardware-place-order'
/** Host plugin row id whose volatile config backs the product settings page. */
export const HARDWARE_CONFIG_ENTRY = 'hardware-artifacts'

declare global {
  interface Window {
    /**
     * Desktop's preload surface, reached through `contextBridge` (PO-02).
     *
     * Only the member this plugin needs is declared: Desktop windows run with
     * `contextIsolation: true`, so the plugin cannot publish a callback by
     * assigning a window global — it must hand the callback to preload, which
     * the caption menu then runs.
     */
    dshDesktop?: {
      registerPlaceOrder?: (handler: () => boolean) => () => void
    }
  }
}

interface SlotSpec {
  name: string
  id?: string
  key?: string
  order?: number
  label?: () => string
  /** Makes the renderer re-derive the entry's `t` seat on a locale switch. */
  locale?: string
  store?: unknown
  inject?: (...args: unknown[]) => unknown
}

interface ClientContext {
  readonly slots?: {
    inject(key: string, callback: () => () => void): () => void
    register(spec: SlotSpec, component: unknown): () => void
  }
  /** DSH's locale service; optional so a Host without it still gets the panel. */
  readonly locale?: CopyLocale
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

  // Register the product's zh/en dictionaries with DSH's locale service and
  // bind the copy facade to the active language. Everything below reads through
  // that facade, so a language switch follows the host setting without any
  // render site knowing about locales.
  const disposeCopy = installCopyLocale(ctx.locale)
  effect(() => disposeCopy, 'hardware-ui: dictionaries')

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
    // One tab, not one per click: a menu that is pressed twice must reveal what
    // the first press opened rather than stack two project lists.
    placeOrder() {
      const tabs = ctx.sidebarRight
      if (tabs === undefined) return false
      tabs.openTab(PLACE_ORDER_TAB_KIND, { revealIfOpened: true })
      return true
    },
    /**
     * Hand the chosen project to the existing order destination. The path and
     * the project travel in the navigation params, so the viewer discovers that
     * project and the order panel packages the board — no second packaging path.
     */
    orderProject(request) {
      navigation += 1
      const params: ViewerNavigationParams = {
        destination: 'order',
        path: request.boardPath,
        kind: 'pcb',
        projectPath: request.projectPath,
        ...(request.schematicPath === undefined ? {} : { schematicPath: request.schematicPath }),
        orderKind: request.kind,
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

  // One toolchain controller for every seat (§10.5). Created here, not inside a
  // component, so the wizard step, the Settings section, the notices and the
  // sidebar dot share one poll and one idea of what is configured — and a
  // download keeps running while the user navigates or closes the panel.
  const toolchain = new ToolchainController()
  const face = { ...controller, toolchain }
  effect(() => { toolchain.start(); return () => { toolchain.stop() } }, 'hardware-ui: toolchain capability')

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

  // The Place Order view is its own tab: reachable with no engineering document
  // open, and a single instance so a second menu click only brings it forward.
  effect(() => ctx.sidebarRightTabs?.register({
    id: PLACE_ORDER_TAB_ID,
    kind: PLACE_ORDER_TAB_KIND,
    title: () => COPY.order.placeOrder.title,
  }) ?? (() => {}), 'hardware-ui: place order tab type')

  // The desktop shell's Place Order menu (PO-02) needs one thing from this
  // plugin: a way to ask for the workflow. Desktop preload owns the registry
  // (`dshDesktop.registerPlaceOrder`) and the caption entry runs whatever is
  // registered, so the menu never reaches into business logic. Leaving the
  // registration behind when the plugin unloads keeps "not loaded" honest.
  if (typeof window !== 'undefined') {
    effect(() => {
      const unregister = window.dshDesktop?.registerPlaceOrder?.(() => controller.placeOrder())
      return () => { unregister?.() }
    }, 'hardware-ui: place order handle')
  }

  const slots = ctx.slots
  if (slots === undefined) return

  effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: HARDWARE_TAB_ID,
    locale: HARDWARE_UI_NS,
    store: viewerStore,
    inject: () => face,
  }, HardwareViewerBody)), 'hardware-ui: viewer body')

  effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
    orderTabRegistration() as never,
    OrderTabBody,
  )), 'hardware-ui: order page body')

  // Project selection for the Place Order workflow: same panel seat, its own tab.
  effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: PLACE_ORDER_TAB_ID,
    locale: HARDWARE_UI_NS,
    inject: () => ({
      discover: controller.discover,
      installations: controller.installations,
      orderProject: controller.orderProject,
    }),
  }, PlaceOrderBody)), 'hardware-ui: place order body')

  effect(() => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: HARDWARE_SETTINGS_ID,
    order: 85,
    label: () => COPY.product.name,
    locale: HARDWARE_UI_NS,
    store: rootStore,
    inject: () => face,
  }, HardwareSettingsSection)), 'hardware-ui: CAD installation settings')

  // First run is a `settings.onboarding` step, not a panel drawer: the shell
  // mounts it on a blank first session, and the step owns its own modal chrome.
  // Registering here also makes `openOnboarding('hardware-engineering-toolchain')`
  // work from the launcher when a user wants the wizard back.
  effect(() => slots.inject('settings.onboarding', () => slots.register({
    name: 'settings.onboarding',
    id: TOOLCHAIN_ONBOARDING_STEP,
    order: 12,
    label: () => COPY.toolchain.onboardingTitle,
    locale: HARDWARE_UI_NS,
    inject: () => ({ toolchain, configForm: () => ctx.configForms?.get<HardwareInstallationConfig>(HARDWARE_CONFIG_ENTRY) }),
  }, ToolchainOnboarding)), 'hardware-ui: toolchain onboarding step')

  // Notices ride the shell overlay (§11): a download that finished while the
  // user was reading a schematic must still reach them, and no failure here
  // opens a modal.
  effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'hardware-ui-toolchain-toasts',
    locale: HARDWARE_UI_NS,
    inject: () => ({ controller: toolchain }),
  }, ToolchainToastHost)), 'hardware-ui: toolchain notices')

  // The quiet sidebar dot (§10.4): visible only while a tool is still missing,
  // and never a second badge on the settings toggle (that seat is single and
  // owned by the desktop-update indicator).
  effect(() => slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: 'hardware-ui-toolchain-indicator',
    order: 10,
    locale: HARDWARE_UI_NS,
    inject: () => ({ controller: toolchain }),
  }, ToolchainIndicator)), 'hardware-ui: toolchain indicator')

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
