/**
 * Auth client core — the Phase 0A POC logic, factored as a testable factory.
 * `apply()` in index.ts wires this to the real window/document/localStorage.
 */
import {
  AUTH_ORIGIN,
  buildLoginUrl,
  buildSubscriptionUrl,
  fetchSubscriptionQuota,
  handleAuthMessage,
  SUBSCRIPTION_PREFERRED_SIZE,
  type AuthMessageEventLike,
  type AuthTokenPayload,
  type LoginOptions,
  type SubscriptionQuota,
} from './lib.js'
import { closeLoginDialog, isLoginDialogOpen, openLoginDialog } from './ui/login-dialog.js'
import { closeSubscriptionDialog, isSubscriptionDialogOpen, openSubscriptionDialog } from './ui/subscription-dialog.js'
import type { AuthStorage } from './storage.js'
import type { AuthTransport } from './transport.js'

export interface AuthClientDeps {
  storage: AuthStorage
  transport: AuthTransport
  /** Strict origin gate; defaults to auth.eda.cn. */
  trustedOrigin?: string
  loginUrl?: string
  windowLike: Pick<Window, 'addEventListener' | 'removeEventListener'>
  documentLike: Pick<Document, 'createElement' | 'body'>
  /**
   * Host-side native dialog opener (wired by the client entry from the lazy
   * `hqEdge` service). In host mode the subscription dialog must be opened by
   * the EDA host through DialogService.OpenUrl (hqEdge.openUrl) — a browser
   * iframe cannot be shown over the host UI. Absent/undefined = the host has
   * no dialog service; `openSubscriptionDialog()` then no-ops and the caller
   * degrades gracefully.
   */
  openHostDialog?: (url: string, options: {
    title?: string
    size?: { width?: number; height?: number }
    key?: string
  }) => Promise<void>
}

export interface AuthClient {
  auth: {
    isAuthenticated(): boolean
    /** HQ Edge host mode: EDA owns the credential; login triggers the EDA dialog. */
    isHostMode(): boolean
    getAccessToken(): Promise<string | null>
    getUserInfo(): Promise<AuthTokenPayload | null>
    /**
     * Rich eda.cn profile (nickname + headimage) for the current token. The
     * node half resolves the token and calls eda.cn — used by the sidebar in
     * host mode when the host session carries only {token, userId} (e.g.
     * kicad). Null on failure; the UI degrades to the HQ icon.
     */
    getUserProfile(): Promise<{ nickname?: string; headimage?: string } | null>
    login(options?: LoginOptions): Promise<void>
    /**
     * Request logout. In host mode this asks the EDA host (through the node
     * half → hq-edge → TriggerLogout) to log out; it never declares the
     * operator logged out locally. Throws when the request is rejected, so
     * the UI keeps showing the authenticated state.
     */
    logout(): Promise<void>
    /**
     * Active subscription quota for one eda.cn product, fetched DIRECTLY from
     * eda.cn (`/sub-api/subscriptions/active`) — no hq-edge hop, so the
     * sidebar can show live quota even in standalone DSH. Null on fetch
     * failure / no credential (callers decide fail-open vs fail-closed).
     */
    getSubscriptionQuota(productCode: string): Promise<SubscriptionQuota | null>
    /**
     * Open the subscription landing page (`gen.eda.cn/subscription` with the
     * token). Host mode: ask the EDA host to open its NATIVE dialog through
     * DialogService.OpenUrl (preferred size 1400×740). Standalone DSH: open
     * the in-app iframe dialog at the same preferred size. No-op when the
     * credential is missing; host mode without a dialog service no-ops too
     * (the UI falls back to its own subscribe button + error copy).
     */
    openSubscriptionDialog(): Promise<void>
    onAuthStateChanged(listener: (info: AuthTokenPayload | null) => void): () => void
  }
  /** Route window 'message' events here. Exposed for direct testing. */
  handleMessageEvent(event: AuthMessageEventLike): void
  /** Re-push persisted credentials on boot (acceptance group D). */
  restore(): Promise<void>
  /** Re-push persisted credentials on demand (heals a reset/absent node half). */
  syncNow(): Promise<void>
  /**
   * Resolve host mode from the node half and, when active, adopt the host-owned
   * session as the browser credential. Resolves `hostMode`; the resolved
   * session is emitted through `onAuthStateChanged` so apps and the HIT cards
   * flip to authenticated without ever opening the auth.eda.cn iframe.
   */
  refreshHost(): Promise<boolean>
  /** Browser→node transport (used to read host mode before UI registration). */
  transport: AuthTransport
  dispose(): void
}

export function createAuthClient(deps: AuthClientDeps): AuthClient {
  const trustedOrigin = deps.trustedOrigin ?? AUTH_ORIGIN
  const loginUrl = deps.loginUrl ?? `${AUTH_ORIGIN}/`
  const { storage, transport } = deps
  const listeners = new Set<(info: AuthTokenPayload | null) => void>()

  // Host-mode credential state. In host mode hq-edge owns the session (EDA
  // hands the operator token over on launch) — the node half resolves it and
  // the browser adopts it through `/session`, so the auth gate, the HIT cards
  // and the sidebar all read authenticated without an iframe login.
  let hostMode = false
  let hostSession: AuthTokenPayload | null = null
  let hostSessionLoaded = false

  const emit = (info: AuthTokenPayload | null): void => {
    for (const listener of listeners) listener(info)
  }
  const closeIframe = (): void => {
    // The dialog module owns the DOM. Tear it down on any close path
    // (token success, logout, close_dialog postMessage, dispose).
    if (isLoginDialogOpen()) closeLoginDialog()
  }
  /**
   * Open the login dialog (backdrop + centered card + auth.eda.cn iframe).
   *
   * The dialog is ALWAYS transparent (no `transparent` option exists): the
   * embedded doc sets its own root to `background: transparent` (we never
   * send `fill=full`), and the iframe sits inside a host-painted card so
   * Blink's white base canvas never reaches the user. See the long header
   * in `ui/login-dialog.ts` for the full why.
   */
  const openIframe = (options: LoginOptions = {}): void => {
    if (isLoginDialogOpen()) return
    const baseUrl = loginUrl
    openLoginDialog(
      {
        ...(options.lang ? { lang: options.lang } : {}),
        ...(options.theme ? { theme: options.theme } : {}),
      },
      () => {
        // Re-render safety: nothing to do here — the auth client's own state
        // is just the dialog-open boolean, which `isLoginDialogOpen()` reads
        // directly from the dialog module.
        void baseUrl
      },
    )
  }

  /**
   * Adopt the host-owned session as the browser credential (host mode only).
   * Kept synchronous for `isAuthenticated()`'s first-paint fast path — callers
   * that need the resolved payload use `getUserInfo()` / `getAccessToken()`,
   * which await host resolution before returning.
   */
  const resolveHost = async (): Promise<void> => {
    hostSessionLoaded = true
    if (!hostMode) {
      hostSession = null
      return
    }
    try {
      const session = await transport.fetchSession()
      hostSession = session.authenticated ? normalizeHostUserPayload(session.user) : null
    } catch {
      // Host unreachable: stay logged out rather than inventing a session.
      hostSession = null
    }
  }

  const auth = {
    // Host mode is STRICT (mirrors the node half): hq-edge is the single
    // source of truth, so a pushed/persisted credential left behind by an
    // earlier standalone login must never report the operator as logged in
    // while the host has no session — that mismatch is exactly how the HIT
    // card reads "logged in" while the tool still gates on needs_auth.
    isAuthenticated: (): boolean => (hostMode ? hostSession !== null : storage.get() !== null),
    isHostMode: (): boolean => hostMode,
    getAccessToken: async (): Promise<string | null> => {
      if (hostMode && !hostSessionLoaded) await resolveHost()
      return hostMode
        ? (hostSession?.token ?? null)
        : (hostSession?.token ?? storage.get()?.token ?? null)
    },
    getUserInfo: async (): Promise<AuthTokenPayload | null> => {
      if (hostMode && !hostSessionLoaded) await resolveHost()
      return hostMode ? hostSession : (hostSession ?? storage.get())
    },
    getUserProfile: async (): Promise<{ nickname?: string; headimage?: string } | null> => {
      if (hostMode && !hostSessionLoaded) await resolveHost()
      if (!(await auth.getAccessToken())) return null
      return transport.fetchUserInfo()
    },
    login: async (options?: LoginOptions): Promise<void> => {
      // Host mode: hq-edge owns the session — ask the host (EDA) to open its
      // own login dialog instead of the auth.eda.cn iframe. The node route
      // blocks until the dialog completes; then re-resolve and emit (only on
      // a real change, so a redundant trigger never re-renders every card).
      if (hostMode) {
        const prevToken = hostSession?.token
        await transport.triggerLogin()
        hostSessionLoaded = false
        await resolveHost()
        if (hostSession?.token !== prevToken) emit(hostSession)
        return
      }
      openIframe(options ?? {})
    },
    logout: async (): Promise<void> => {
      if (hostMode) {
        // Host-owned session: ask the EDA host to log out (node half →
        // hq-edge → AuthService.TriggerLogout). Success only means the
        // request was accepted, so re-resolve the host session and emit the
        // HOST's verdict — never a locally invented "logged out". A rejected
        // request throws and leaves `hostSession` (the real state) intact.
        await transport.pushLogout()
        hostSessionLoaded = false
        await resolveHost()
        emit(hostSession)
        return
      }
      storage.clear()
      try {
        await transport.pushLogout()
      } catch {
        /* node may be absent — local state is still cleared */
      }
      emit(null)
      closeIframe()
    },
    getSubscriptionQuota: async (productCode: string): Promise<SubscriptionQuota | null> => {
      if (hostMode && !hostSessionLoaded) await resolveHost()
      const token = await auth.getAccessToken()
      const id = hostMode
        ? (hostSession?.id ?? null)
        : (hostSession?.id ?? storage.get()?.id ?? null)
      if (!token || !id) return null
      return fetchSubscriptionQuota({ userId: id, token, productCode })
    },
    openSubscriptionDialog: async (): Promise<void> => {
      if (hostMode && !hostSessionLoaded) await resolveHost()
      const token = await auth.getAccessToken()
      if (!token) return
      const url = buildSubscriptionUrl({ token })
      if (hostMode) {
        // The EDA host owns the UI — open its native dialog (fire-and-forget).
        // No dialog service → no-op; the caller keeps its subscribe button.
        if (!deps.openHostDialog) return
        await deps.openHostDialog(url, {
          title: 'Huaqiu EDA subscription',
          size: { width: SUBSCRIPTION_PREFERRED_SIZE.width, height: SUBSCRIPTION_PREFERRED_SIZE.height },
          key: 'hq-subscription-dialog',
        })
        return
      }
      if (isSubscriptionDialogOpen()) return
      openSubscriptionDialog(url, { size: SUBSCRIPTION_PREFERRED_SIZE })
    },
    onAuthStateChanged: (listener: (info: AuthTokenPayload | null) => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  const handleMessageEvent = (event: AuthMessageEventLike): void => {
    // Offline deployment: no origin gate (see lib.ts). Envelope validation is
    // the only gate, so unrelated window messages can never corrupt state.
    const msg = handleAuthMessage(event)
    if (!msg) return
    if (msg.kind === 'token') {
      hostSession = null
      storage.set(msg.info)
      void transport.pushSession(msg.info).catch(() => { /* node push is best-effort; syncNow heals */ })
      emit(msg.info)
      closeIframe()
    } else if (msg.kind === 'logout') {
      hostSession = null
      storage.clear()
      emit(null)
      void transport.pushLogout().catch(() => { /* local state already cleared */ })
      closeIframe()
    } else if (msg.kind === 'close') {
      closeIframe()
    }
  }

  const onWindowMessage = (event: MessageEvent): void => {
    handleMessageEvent({ origin: event.origin, data: event.data })
  }

  deps.windowLike.addEventListener('message', onWindowMessage)

  const restore = async (): Promise<void> => {
    const restored = storage.get()
    if (restored) {
      try {
        await transport.pushSession(restored)
      } catch {
        /* boot push is best-effort; syncNow heals */
      }
    }
  }

  return {
    auth,
    handleMessageEvent,
    restore,
    /**
     * Resolve host mode + host session from the node half and emit the result.
     * Called at apply() boot; also re-runnable on demand (e.g. focus) so a
     * late host handover still flips the gate.
     */
    async refreshHost(): Promise<boolean> {
      // Remember what callers currently believe, so we only notify on a real
      // change. This routine is re-run periodically in host mode (there is no
      // push channel into the webview), and re-emitting an identical payload
      // would re-render every mounted card and HIT for nothing.
      const prevToken = hostSession?.token ?? storage.get()?.token ?? null
      let mode = false
      try {
        mode = await transport.fetchHostMode()
      } catch {
        mode = false
      }
      hostMode = mode
      hostSessionLoaded = false
      await resolveHost()
      const next = hostSession ?? storage.get()
      if (next?.token !== prevToken) emit(next)
      return hostMode
    },
    /**
     * Browser→node transport. Exposed so the client entry can read host mode
     * (whether an HQ Edge host supplies the credential and the login UI should
     * be suppressed) before registering the sidebar entrypoint.
     */
    transport,
    /**
     * Re-push the persisted credential to the node half. Healing path: the
     * node keeps auth in memory, so a `dsh web` restart (or a failed first
     * push) drops it while the browser still has the token. Callers re-sync on
     * focus / visibilitychange / login-card mount so the tool gate reflects
     * the actual browser login without requiring a page reload.
     */
    async syncNow(): Promise<void> {
      const info = storage.get()
      if (!info) return
      try {
        await transport.pushSession(info)
      } catch {
        /* sync is best-effort; a later focus event retries */
      }
    },
    dispose() {
      deps.windowLike.removeEventListener('message', onWindowMessage)
      closeIframe()
      if (isSubscriptionDialogOpen()) closeSubscriptionDialog()
      hostMode = false
      hostSession = null
      hostSessionLoaded = false
      void trustedOrigin // referenced for clarity: the auth iframe URL comes from it
    },
  }
}

/** Map the node `/session` user into the client payload shape. */
function normalizeHostUserPayload(
  user: { id?: string | number; token?: string; nickname?: string; expiresAt?: number } | null,
): AuthTokenPayload | null {
  if (!user) return null
  const token = typeof user.token === 'string' && user.token.length > 0 ? user.token : null
  const id = typeof user.id === 'string' && user.id.length > 0
    ? user.id
    : typeof user.id === 'number' && Number.isFinite(user.id) ? String(user.id)
    : null
  if (!token || !id) return null
  return {
    id,
    token,
    ...(user.nickname !== undefined && typeof user.nickname === 'string' ? { nickname: user.nickname } : {}),
    ...(user.expiresAt !== undefined && typeof user.expiresAt === 'number' ? { expiresAt: user.expiresAt } : {}),
  }
}
