/**
 * `@huaqiu/dsh-auth` — browser half (the Phase 0A POC).
 *
 * Opens the auth.eda.cn login page in an overlay iframe, STRICTLY validates
 * the postMessage origin, caches credentials in localStorage (reload restore),
 * and pushes them to the node half over the plugin-owned webServer routes.
 * Provides the client-side `huaqiuAuth` service mirroring the node surface.
 *
 * On top of the credential flow it wires the two UI surfaces the login UX
 * needs:
 *   - `sidebar.footer.action` — a persistent 华秋EDA login entrypoint at the
 *     bottom of the sidebar (login/logout, live state).
 *   - `tool.call.toolview` (keyed per Huaqiu tool) — when a node tool returns
 *     `status: "needs_auth"` the tool card becomes the login HIT: an embedded
 *     auth.eda.cn iframe + login-state line, so login is a step of the
 *     conversation instead of a dead error the agent has to relay.
 */
import { createAuthStorage } from './storage.js'
import { createWebServerAuthTransport } from './transport.js'
import { createAuthClient, type AuthClient } from './client.js'
import { disposeAuth, registerAuth, registerAuthSync, registerHqEdgeGetter } from './auth-state.js'
import { HuaqiuToolView } from './ui/needs-auth-toolview.jsx'
import { HuaqiuAuthSidebarAction } from './ui/sidebar-action.jsx'
import { disposeUiEnv } from './ui-env.js'

/**
 * Client cordis inject: REAL service names only (the loader maps these to
 * `ctx.inject([...])` dependencies). The `slots` registry service comes from
 * `@deepseek-ai/dsh-client-ui-slots`; it is required to register the toolview
 * and sidebar entries. The PACKAGE-level `dsh.client.inject` in package.json
 * (graph ordering) stays as-is and is NOT this export.
 */
export const inject: string[] = ['slots']

/**
 * Huaqiu tools that still surface the auth login card via this plugin.
 *
 * Currently EMPTY: all five Huaqiu tools now own their keyed HIT cards in
 * their own plugins (`@huaqiu/dsh-tool-symbol-footprint` for the three
 * symbol/footprint generators, `@huaqiu/dsh-tool-schematic-gen` for the two
 * schematic/system generators), and each renders its own inline login card for
 * `needs_auth`. Keeping the toolview keys here would double-register the same
 * `tool.call.toolview` slot with an ambiguous winner.
 *
 * The auth plugin remains the credential owner: the `huaqiuAuth` client
 * service, the sidebar login entrypoint and the webServer credential channel.
 */
export const AUTH_TOOL_NAMES: readonly string[] = []

/**
 * How often the browser re-pulls the host-owned session in host mode.
 *
 * KiCad's HQ auth token watcher polls the credential file every 3s and
 * publishes an `auth_state_changed` event on change, so 5s bounds the
 * end-to-end lag of an EDA-side login/logout reaching this UI at well under
 * ten seconds while staying negligible against two loopback requests.
 */
const HOST_RESYNC_INTERVAL_MS = 5000

/** Minimal structural client context (dsh-client-runtime provides this). */
export interface ClientContext {
  provide?(name: string, value: unknown): () => void
  get?<T>(name: string): T | undefined
  slots?: {
    inject(key: string, callback: () => () => void): () => void
    register(spec: { name: string; key?: string; id?: string }, component: unknown): unknown
  }
}

export function apply(ctx: ClientContext): () => void {
  const client: AuthClient = createAuthClient({
    storage: createAuthStorage(localStorage),
    transport: createWebServerAuthTransport(),
    windowLike: window,
    documentLike: document,
    // Host mode subscription dialog: the EDA host owns the UI. Open its
    // native window through the hqEdge service's DialogService.OpenUrl
    // bridge (fire-and-forget); absent hqEdge → no-op, the caller's
    // subscribe button stays usable and reports the limitation.
    openHostDialog: async (url, options) => {
      const hqEdge = ctx.get?.<{
        openUrl?(url: string, opts?: Record<string, unknown>): Promise<unknown>
      } | undefined>('hqEdge')
      if (!hqEdge || typeof hqEdge.openUrl !== 'function') return
      await hqEdge.openUrl(url, {
        ...(options.title ? { title: options.title } : {}),
        ...(options.size ? { size: options.size } : {}),
        ...(options.key ? { key: options.key } : {}),
      })
    },
  })

  // The sidebar needs the host identity (targetHost) to decide whether the
  // host already has its own login surface (hq-eda hides the trigger; kicad /
  // generic keep it). Lazy so edge-bridge load order never matters.
  registerHqEdgeGetter(() => ctx.get?.('hqEdge'))

  const disposers: Array<() => void> = []
  let disposed = false
  const disposeProvide = ctx.provide?.('huaqiuAuth', { auth: client.auth })
  registerAuth(client.auth)
  registerAuthSync(() => { void client.syncNow() })
  void client.restore()
  disposers.push(client.auth.onAuthStateChanged((info) => {
    void client.syncNow()
  }))

  // Healing: the node half keeps auth in memory, so a server restart drops it
  // while the browser still holds the token. Re-sync whenever the tab regains
  // focus/visibility so the tool gate flips back to authenticated without a
  // reload. In host mode there is nothing stored locally to push, so instead
  // re-pull the host-owned session — an EDA-side login/logout performed while
  // this tab was hidden can only be discovered by asking.
  const sync = (): void => {
    void client.syncNow()
    if (client.auth.isHostMode()) void client.refreshHost().catch(() => undefined)
  }
  window.addEventListener('focus', sync)
  document.addEventListener('visibilitychange', sync)
  disposers.push(() => {
    window.removeEventListener('focus', sync)
    document.removeEventListener('visibilitychange', sync)
  })

  /**
   * In HQ Edge host mode (config.hqEdgeBaseUrl set on the node half), EDA
   * launches hq-edge WITH the operator credential, so hq-edge — not this
   * plugin — owns authentication for the session. `refreshHost()` resolves
   * that host mode and adopts the host-owned session as the browser
   * credential, so the auth gate / HIT cards read authenticated immediately.
   *
   * The sidebar entrypoint is registered UNCONDITIONALLY and decides its own
   * visibility: it hides itself only when the host is hq-eda (which has a
   * native login button + status badge). Standalone DSH and other hosts
   * (kicad, generic — no login surface of their own) keep the trigger. The
   * mode is read from the node half over the plugin-owned webServer route
   * (async), so the component re-renders when the host session lands
   * (auth-state emits on adopt).
   */
  const slots = ctx.slots
  void client.refreshHost().catch(() => undefined).then(() => {
    if (disposed) return

    // Host-mode credential watch.
    //
    // In host mode the credential is owned by EDA (KiCad), not by this plugin:
    // the operator can log in or out from EDA's own dialog, from another
    // webview (online library), or through hq-edge — none of which can reach
    // into this webview, because the DSH panel is deliberately not part of the
    // copilot WEBVIEW_CONTROLLER broadcast set (it has no JS bridge at all).
    // So the host session must be re-pulled to notice changes; otherwise the
    // UI stays stale until KiCad is restarted and the page re-loads.
    //
    // `refreshHost()` only emits when the token actually changed, so this poll
    // costs two loopback requests per tick and no re-render when nothing moved.
    if (client.auth.isHostMode()) {
      let polling = false
      const timer = window.setInterval(() => {
        if (polling) return
        polling = true
        void client.refreshHost()
          .catch(() => undefined)
          .finally(() => { polling = false })
      }, HOST_RESYNC_INTERVAL_MS)
      disposers.push(() => { window.clearInterval(timer) })
    }

    if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
      for (const toolName of AUTH_TOOL_NAMES) {
        disposers.push(slots.inject('tool.call.toolview', () => slots.register({ name: 'tool.call.toolview', key: toolName }, HuaqiuToolView) as () => void))
      }
      disposers.push(slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'huaqiu-auth' }, HuaqiuAuthSidebarAction) as () => void))
    }
  })

  return () => {
    disposed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
    disposeProvide?.()
    client.dispose()
    disposeAuth()
    disposeUiEnv()
  }
}
