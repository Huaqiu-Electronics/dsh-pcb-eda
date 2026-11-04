/**
 * HQ Edge host mode for `dsh-auth`.
 *
 * In standalone DSH, credentials arrive only when the user logs in through the
 * browser (auth.eda.cn iframe → postMessage → `webServer` route →
 * `setCredentials`). That means the node half is empty until a browser tab
 * focuses the card, and every tool returns `needs_auth` in the gap — including
 * across a process restart (the in-memory cache is gone).
 *
 * Host mode removes that gap. When HQ Edge is the host, it already holds the
 * operator-supplied token + user id, and exposes them on a loopback route. The
 * node half fetches them on boot and is authoritative immediately, without
 * waiting for a browser. The browser half is untouched — host mode is *mode*,
 * not API (spec §5/§14).
 *
 * Resolution order inside `getUserInfo()` (spec §6.2):
 *   1. host session   — HQ Edge configured → fetch + cache (TTL)
 *   2. pushed session — what the browser half sent (today's behaviour)
 *   3. persisted file — node-side `~/.dsh/auth/session.json`, written on every set
 *   4. null           → tools return needs_auth
 */

import { getLogger, type PluginLogger } from '@huaqiu/dsh-plugin-log'

// Lazy so test suites that `vi.mock('@deepseek-ai/dsh-home-paths', …)` before
// the test's TMP constant is initialised don't trigger `dshHomePath('logs')` at
// module-load time. Every site goes through `log()` instead of holding a module
// reference to the logger.
let _log: PluginLogger | null = null
function log(): PluginLogger {
  if (_log === null) _log = getLogger('dsh-auth')
  return _log
}

export interface HuaqiuAuthConfig {
  /** HQ Edge base URL, e.g. "http://localhost:18080". Absent → standalone. */
  hqEdgeBaseUrl?: string
  /** Path on the host; default "/api/v1/auth/token". */
  hostAuthPath?: string
  /** Host endpoint that triggers the EDA login dialog; default "/api/v1/auth/login". */
  hostLoginPath?: string
  /** Host endpoint that requests EDA logout; default "/api/v1/auth/logout". */
  hostLogoutPath?: string
  /** Seconds a host session is reused before re-fetching. Default 300. */
  hostSessionTtlSeconds?: number
  /** Seconds remote token-validation results are cached. Default 60. */
  validationTtlSeconds?: number
  /**
   * Subscription balances endpoint resolved by HQ Edge from `HQ_AI_ENV`
   * (`GET /sub-api/subscriptions/balances/current`). Absent → `/ai-usage`
   * returns null instead of calling a stale/default endpoint.
   */
  subscriptionBalancesUrl?: string
  /**
   * Subscription landing-page origin resolved by HQ Edge from the SAME
   * `HQ_AI_ENV`. Absent → the browser half keeps its standalone PROD default.
   */
  subscriptionOrigin?: string
}

export const DEFAULT_HOST_AUTH_PATH = '/api/v1/auth/token'
export const DEFAULT_HOST_LOGIN_PATH = '/api/v1/auth/login'
export const DEFAULT_HOST_LOGOUT_PATH = '/api/v1/auth/logout'
export const DEFAULT_HOST_TTL_SECONDS = 300
export const DEFAULT_VALIDATION_TTL_SECONDS = 60

/**
 * Resolve the effective config: overlay `config` (highest) > env (safety net
 * for non-supervisor installs) > defaults. Centralised here so only `dsh-auth`
 * inspects these variables (spec §8).
 */
export function resolveHostConfig(
  config?: Partial<HuaqiuAuthConfig> | null,
  env: NodeJS.ProcessEnv = process.env,
): HuaqiuAuthConfig {
  const baseUrl = config?.hqEdgeBaseUrl
    ?? env.HQ_EDGE_BASE_URL
    ?? ''
  const hostAuthPath = config?.hostAuthPath
    ?? env.HQ_EDGE_AUTH_PATH
    ?? DEFAULT_HOST_AUTH_PATH
  const hostLoginPath = config?.hostLoginPath
    ?? env.HQ_EDGE_LOGIN_PATH
    ?? DEFAULT_HOST_LOGIN_PATH
  const hostLogoutPath = config?.hostLogoutPath
    ?? env.HQ_EDGE_LOGOUT_PATH
    ?? DEFAULT_HOST_LOGOUT_PATH
  const ttlRaw = config?.hostSessionTtlSeconds ?? env.HQ_EDGE_HOST_TTL_SECONDS
  let ttl = DEFAULT_HOST_TTL_SECONDS
  if (typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw > 0) {
    ttl = ttlRaw
  } else if (typeof ttlRaw === 'string' && ttlRaw.trim().length > 0) {
    const parsed = Number.parseInt(ttlRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) ttl = parsed
  }
  const vTtlRaw = config?.validationTtlSeconds ?? env.HQ_EDGE_VALIDATION_TTL_SECONDS
  let validationTtlSeconds = DEFAULT_VALIDATION_TTL_SECONDS
  if (typeof vTtlRaw === 'number' && Number.isFinite(vTtlRaw) && vTtlRaw > 0) {
    validationTtlSeconds = vTtlRaw
  } else if (typeof vTtlRaw === 'string' && vTtlRaw.trim().length > 0) {
    const parsed = Number.parseInt(vTtlRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) validationTtlSeconds = parsed
  }
  // Resolved AI endpoints: overlay config (what HQ Edge injects) wins; explicit
  // env URLs are the standalone escape hatch. HQ_AI_ENV itself is NOT read here
  // — the prod/test mapping lives only in HQ Edge's central config.
  const subscriptionBalancesUrl = (
    config?.subscriptionBalancesUrl
    ?? env.HQ_AI_SUBSCRIPTION_BALANCES_URL
    ?? ''
  ).trim()
  const subscriptionOrigin = (config?.subscriptionOrigin ?? env.HQ_AI_SUBSCRIPTION_ORIGIN ?? '')
    .trim()
    .replace(/\/+$/, '')
  return {
    hqEdgeBaseUrl: baseUrl,
    hostAuthPath,
    hostLoginPath,
    hostLogoutPath,
    hostSessionTtlSeconds: ttl,
    validationTtlSeconds,
    subscriptionBalancesUrl,
    subscriptionOrigin,
  }
}

export interface HostSession {
  info: ResolvedHostUser
  fetchedAt: number
}

export interface ResolvedHostUser {
  id: string
  token: string
  nickname?: string
  /**
   * The HOST's own verdict on the credential.
   *
   * HQ Edge receives its credential from EDA (`AuthStateChanged`) and reports
   * `authenticated` alongside the token; that verdict is authoritative for host
   * mode. This plugin must not substitute its own guess: the token class EDA
   * hands to HQ Edge is not necessarily known to the public `www.eda.cn`
   * token-validation endpoint, so a remote probe there can answer "not valid"
   * for a credential the operator's own editor considers live.
   */
  authenticated: boolean
  /**
   * Host-side state version (HQ Edge bumps it on every credential replace and
   * clear). A change means "this is a different credential than the one you
   * looked at", which is how a 401-driven invalidation gets undone.
   */
  version?: number
  /** Unix seconds, when the host knows the expiry. */
  expiresAt?: number
}

/**
 * Fetches the host (HQ Edge) session over the loopback `GET` on EVERY call.
 * The GET is in-memory and loopback-cheap, and the DSH browser half polls this
 * resolver every few seconds (client/index.tsx `refreshHost`) — so re-fetching
 * is exactly what makes a host logout (token cleared) become visible within one
 * poll instead of leaving the UI "logged in" until a page reload.
 *
 * Caching rule — **a usable (authenticated) session is NEVER held across a
 * clear**. We fetch fresh each time and drop the cache the moment the host
 * reports no credential (logout / not-yet-logged-in). The only thing the cache
 * is now used for is a TRANSIENT ERROR FALLBACK: if the host is momentarily
 * unreachable we return a recent usable session (within `ttlMs`) rather than
 * spuriously logging the operator out — but never past the TTL, or a stale
 * fallback would mask a real logout that happened while the host was down.
 */
export class HostSessionResolver {
  private cache: HostSession | null = null

  constructor(
    readonly baseUrl: string,
    readonly path: string,
    readonly ttlMs: number,
    private readonly doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  /** Host mode is active iff a base URL was configured. */
  get enabled(): boolean {
    return this.baseUrl.length > 0
  }

  async resolve(): Promise<ResolvedHostUser | null> {
    if (!this.enabled) return null
    const now = Date.now()
    const url = `${this.baseUrl}${this.path}`
    let info: ResolvedHostUser | null = null
    let status: number | null = null
    try {
      const res = await this.doFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      })
      status = res.status
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>
        info = normalizeHostUser(data)
      }
    } catch (err) {
      // Network error: the host is momentarily unreachable. Fall back to a
      // RECENT usable cache so a transient blip does not log the operator out —
      // but only within the TTL window, or a stale fallback would mask a real
      // logout that happened while the host was down.
      log().warn('host session fetch failed', { url, error: String(err) })
      if (this.cache !== null && now - this.cache.fetchedAt < this.ttlMs) {
        return this.cache.info
      }
      return null
    }
    if (info !== null && info.authenticated) {
      this.cache = { info, fetchedAt: now }
      // Never log the credential itself — id/version are enough to correlate
      // this plugin with the HQ Edge log line that served it.
      log().debug('host session resolved', {
        url,
        status,
        userId: info.id,
        version: info.version ?? null,
        authenticated: info.authenticated,
      })
      return info
    }
    // Unusable (unreachable, unparseable, or the host says it has no
    // credential — including a logout that just cleared the token). Drop the
    // cache so the very next call re-asks the host and sees the state flip.
    // We NEVER hold a positive (authenticated) session across a clear: the DSH
    // browser half polls every few seconds and would otherwise miss the logout
    // for the whole TTL and stay "logged in" until a reload (see
    // client/index.tsx refreshHost).
    this.cache = null
    log().info('no usable host session', {
      url,
      status,
      parsed: info !== null,
      hostAuthenticated: info?.authenticated ?? null,
    })
    return null
  }

  /** Drop the cached value so the next `resolve()` re-fetches (reactive invalidation). */
  clear(): void {
    this.cache = null
  }
}

function asId(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return null
}

/**
 * Parse the host route payload into a credential, tolerating key-name drift.
 *
 * HQ Edge answers `GET /api/v1/auth/token` with
 * `{ authenticated, token, userId, version }`. The `authenticated` flag is the
 * host's own verdict and is carried through verbatim; hosts that predate it
 * (or a minimal `{ token, userId }` stub) omit the key, in which case the
 * presence of a usable token+id is taken as the old contract was: authenticated.
 */
export function normalizeHostUser(data: Record<string, unknown>): ResolvedHostUser | null {
  const token = typeof data.token === 'string' && data.token.length > 0
    ? data.token
    : null
  const id = asId(data.userId)
    ?? asId(data.id)
    ?? asId(data.user_id)
  if (!token || !id) return null
  const nickname = typeof data.nickname === 'string' && data.nickname.length > 0
    ? data.nickname
    : undefined
  const authenticated = data.authenticated === undefined ? true : data.authenticated === true
  const version = typeof data.version === 'number' && Number.isFinite(data.version)
    ? data.version
    : undefined
  const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)
    ? data.expiresAt
    : undefined
  return {
    id,
    token,
    authenticated,
    ...(nickname ? { nickname } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}
