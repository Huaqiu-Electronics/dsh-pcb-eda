/**
 * Browser→node credential transport over the plugin-owned webServer routes
 * (same-origin; no CORS, no external dependency). This is the chosen Phase 0A
 * browser→host channel — `apiProxy`'s dispatch table is closed, so a
 * plugin-owned `webServer` route is the smallest supported extension point.
 */
import type { AiUsage, AuthTokenPayload } from './lib.js'

export interface AuthTransport {
  pushSession(info: AuthTokenPayload): Promise<void>
  pushLogout(): Promise<void>
  /**
   * Runtime config resolved by the node half (`/config`):
   * - `hostMode`: whether the plugin runs under an HQ Edge host (in host mode
   *   the browser half's own login UI is suppressed);
   * - `subscriptionOrigin`: the SAME `HQ_AI_ENV`-resolved origin used for the
   *   subscription dialog (null → standalone PROD fallback);
   * - `subscriptionApiBaseUrl`: origin of the resolved balances API, used for
   *   the GEN/ERC active-subscription calls (null → quota unavailable).
   */
  fetchRuntimeConfig(): Promise<AuthRuntimeConfig>
  /**
   * Fetch the node half's authoritative session. The node resolves host-mode
   * credentials first (host session → pushed browser session → persisted
   * file), so in host mode this is how the browser half learns the host-owned
   * credential without ever opening the auth.eda.cn iframe.
   */
  fetchSession(): Promise<{ authenticated: boolean; user: HostSessionUser | null }>
  /**
   * Ask the node half to trigger the EDA login dialog through the host.
   * Standalone (no host) must NOT call this — login is the browser iframe
   * there. In host mode the node blocks until the dialog is completed (the
   * host route waits for AuthStateChanged), then the caller re-fetches the
   * session to pick up the fresh credential.
   */
  triggerLogin(): Promise<void>
  /**
   * Fetch the rich eda.cn profile (nickname + headimage) for the current
   * token. The node half resolves the token (host → pushed → persisted) and
   * calls eda.cn; used by the sidebar in host mode when the host session
   * carries only {token, userId} — e.g. host mode under kicad.
   */
  fetchUserInfo(): Promise<EdaUserProfile | null>
  /**
   * Fetch the account's AI usage from the NODE half (`/ai-usage`), which
   * performs the upstream subscription-balances call (endpoint resolved by HQ
   * Edge from `HQ_AI_ENV`) with the `X-Token` header. This half must NOT call
   * that endpoint itself: the TEST endpoint is plain `http`, which the WebView
   * refuses on two independent grounds — App Transport Security and CORS.
   * Null on failure (the sidebar shows「—」).
   */
  fetchAiUsage(): Promise<AiUsage | null>
}

/** Minimal session user shape returned by the node `/session` route. */
export interface HostSessionUser {
  id?: string | number
  token?: string
  nickname?: string
  expiresAt?: number
}

/** Runtime config served by the node `/config` route. */
export interface AuthRuntimeConfig {
  hostMode: boolean
  /** Absolute http(s) origin; null = standalone (client keeps its default). */
  subscriptionOrigin: string | null
  /** Origin for GEN/ERC quota calls; null = no environment configured. */
  subscriptionApiBaseUrl: string | null
}

/** Accept only an absolute http(s) origin; anything else → null. */
function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return trimmed
  } catch {
    return null
  }
}

/** Accept only a finite `quotaRemainPercent`; anything else → unavailable. */
function normalizeUsage(value: unknown): AiUsage | null {
  if (value === null || typeof value !== 'object') return null
  const percent = (value as { quotaRemainPercent?: unknown }).quotaRemainPercent
  return typeof percent === 'number' && Number.isFinite(percent)
    ? { quotaRemainPercent: percent }
    : null
}

/** Rich eda.cn profile served by the node `/user-info` route. */
export interface EdaUserProfile {
  nickname?: string
  headimage?: string
  phone?: string
  username?: string
}

export function createWebServerAuthTransport(
  base: string = '/api/v1/huaqiu/auth',
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): AuthTransport {
  return {
    async pushSession(info) {
      const res = await doFetch(`${base}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: info.token,
          userId: info.id,
          ...(info.nickname !== undefined ? { nickname: info.nickname } : {}),
          ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}),
        }),
      })
      if (!res.ok) throw new Error(`auth push failed: HTTP ${res.status}`)
    },
    async pushLogout() {
      const res = await doFetch(`${base}/logout`, { method: 'POST' })
      if (!res.ok) throw new Error(`auth logout push failed: HTTP ${res.status}`)
    },
    async fetchRuntimeConfig() {
      try {
        const res = await doFetch(`${base}/config`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) {
          return {
            hostMode: false,
            subscriptionOrigin: null,
            subscriptionApiBaseUrl: null,
          }
        }
        const body = await res.json() as {
          hostMode?: unknown
          subscriptionOrigin?: unknown
          subscriptionApiBaseUrl?: unknown
        }
        return {
          hostMode: body.hostMode === true,
          subscriptionOrigin: normalizeOrigin(body.subscriptionOrigin),
          subscriptionApiBaseUrl: normalizeOrigin(body.subscriptionApiBaseUrl),
        }
      } catch {
        // Offline/same-origin failure: fall back to standalone (show the login
        // entrypoint) rather than hiding it — a login UI is never a security
        // regression, but a missing one in standalone would lock the user out.
        return {
          hostMode: false,
          subscriptionOrigin: null,
          subscriptionApiBaseUrl: null,
        }
      }
    },
    async fetchSession() {
      const res = await doFetch(`${base}/session`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return { authenticated: false, user: null }
      const body = await res.json() as { authenticated?: unknown; user?: unknown }
      const user = body.user && typeof body.user === 'object' ? body.user as HostSessionUser : null
      return { authenticated: body.authenticated === true, user }
    },
    async triggerLogin() {
      const res = await doFetch(`${base}/login`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`auth login trigger failed: HTTP ${res.status}`)
    },
    async fetchUserInfo() {
      try {
        const res = await doFetch(`${base}/user-info`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return null
        const body = await res.json() as { userInfo?: EdaUserProfile | null }
        return body.userInfo ?? null
      } catch {
        return null
      }
    },
    async fetchAiUsage() {
      try {
        const res = await doFetch(`${base}/ai-usage`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return null
        const body = await res.json() as { usage?: unknown }
        return normalizeUsage(body.usage)
      } catch {
        return null
      }
    },
  }
}
