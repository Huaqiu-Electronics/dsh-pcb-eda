/**
 * Module-level auth state store shared by the client React components.
 *
 * The DSH slot system injects React components with props, not the cordis ctx,
 * so the components read login state through this tiny external store
 * (`useSyncExternalStore`), fed by the singleton `huaqiuAuth` client service
 * created in `apply()`. When the user logs in (in the sidebar overlay or an
 * embedded card iframe), `onAuthStateChanged` fires and every mounted card /
 * sidebar button re-renders.
 */
import type { AuthClient } from './client.js'

export interface AuthState {
  authenticated: boolean
  nickname?: string
  /** Avatar URL for the sidebar trigger; absent → the HQ icon is shown. */
  avatar?: string
  /**
   * Access token, needed by「Go to profile」(eda.cn takes it from the query
   * and hides it itself). Kept in the store, never rendered or logged.
   */
  token?: string
  /** Bound mobile number, forwarded to the profile page as `phone=`. */
  phone?: string
  /**
   * Rich eda.cn profile fetched in host mode (host session carries only
   * {token, userId}): nickname + headimage, merged above the host session.
   */
  profile?: { nickname?: string; headimage?: string }
}

/** Snapshot for one credential payload (`null` = logged out). */
function stateOf(info: AuthTokenPayloadLike | null): AuthState {
  if (!info) return { authenticated: false }
  return {
    authenticated: true,
    ...(info.nickname ? { nickname: info.nickname } : {}),
    ...(info.avatar ? { avatar: info.avatar } : {}),
    ...(info.token ? { token: info.token } : {}),
    ...(info.phone ? { phone: info.phone } : {}),
  }
}

type AuthTokenPayloadLike = { nickname?: string; avatar?: string; token?: string; phone?: string } | null

let auth: AuthClient['auth'] | null = null
let state: AuthState = { authenticated: false }
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | null = null
let syncNow: (() => void) | null = null

function setState(next: AuthState): void {
  state = next
  for (const l of listeners) l()
}

/** Attach the singleton auth capability and push the initial snapshot. */
export function registerAuth(a: AuthClient['auth']): void {
  unsubscribe?.()
  unsubscribe = null
  auth = a
  unsubscribe = a.onAuthStateChanged((info) => {
    setState(stateOf(info))
  })
  void a.getUserInfo()
    .then((info) => setState(stateOf(info)))
    .catch(() => setState({ authenticated: false }))
}

/** The live auth capability (for login()/logout() from components). */
export function getAuth(): AuthClient['auth'] | null {
  return auth
}

/** Current snapshot, for `useSyncExternalStore`'s getSnapshot. */
export function getAuthState(): AuthState {
  return state
}

/** Subscribe, for `useSyncExternalStore`'s subscribe. */
export function subscribeAuth(callback: () => void): () => void {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

/**
 * Merge the rich eda.cn profile (nickname + headimage) into the store —
 * sidebar components call this after `auth.getUserProfile()` in host mode.
 * The trigger then renders the real name/photo instead of the bare HQ icon.
 */
export function setProfile(profile: { nickname?: string; headimage?: string } | null | undefined): void {
  setState({ ...state, profile: profile ?? undefined })
}

/** Current profile (nickname + headimage) resolved from the host, if any. */
export function getProfile(): { nickname?: string; headimage?: string } | undefined {
  return state.profile
}

/** Register the node re-sync hook (wired in apply(); called by the login card on mount). */
export function registerAuthSync(fn: () => void): void {
  syncNow = fn
}

/**
 * Lazy host-identity getter (edge-bridge browser half), registered by
 * `apply()` via `ctx.get('hqEdge')`. The sidebar needs it to decide whether
 * the host already exposes its own login surface: hq-eda does (native login
 * button + status badge), so the sidebar trigger is hidden there; other hosts
 * (kicad, generic) have no login entrypoint of their own, so the trigger
 * stays. Registered lazily so plugin load order never matters.
 */
export interface HqEdgeContextLike {
  context?: {
    getTargetHost?(): string
  }
}
let hqEdgeGetter: (() => HqEdgeContextLike | undefined) | null = null
export function registerHqEdgeGetter(get: () => HqEdgeContextLike | undefined): void {
  hqEdgeGetter = get
}
export function getHqEdge(): HqEdgeContextLike | undefined {
  return hqEdgeGetter ? hqEdgeGetter() : undefined
}

/** Re-push the persisted credential to the node half, if one is available. */
export function syncAuthNow(): void {
  syncNow?.()
}

export function disposeAuth(): void {
  unsubscribe?.()
  unsubscribe = null
  auth = null
  syncNow = null
  hqEdgeGetter = null
  listeners.clear()
  state = { authenticated: false }
}
