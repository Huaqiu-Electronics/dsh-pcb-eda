/**
 * Node-side `huaqiuAuth` service.
 *
 * Holds the credential used by the tools (`getAccessToken()` → `x-user-token`,
 * `getUserInfo()` → `x-user-id`). Two sources feed it:
 *
 *  - **pushed** — the browser half owns the login flow (auth.eda.cn iframe +
 *    postMessage) and pushes credentials over a plugin-owned `webServer` route
 *    (`setCredentials`).
 *  - **host** — when HQ Edge is the host, the node half fetches the operator
 *    token directly from HQ Edge's loopback route (host mode, `src/host.ts`).
 *
 * `huaqiuAuth.auth` is a capability (`isAuthenticated`/`getAccessToken`/
 * `getUserInfo`), NOT a promise that the browser and node tokens are the same
 * value (migration plan review #7).
 *
 * Resolution order inside `getUserInfo()` (spec §6.2):
 *   1. host session   — HQ Edge configured → fetch + cache (TTL)
 *   2. pushed session — what the browser half sent
 *   3. persisted file — `~/.dsh/auth/session.json`, written on every set
 *   4. null           → tools return needs_auth
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { getLogger, type PluginLogger } from '@huaqiu/dsh-plugin-log'
import {
  HostSessionResolver,
  resolveHostConfig,
  type HuaqiuAuthConfig,
  type ResolvedHostUser,
} from './host.js'
import { TokenValidator, type AuthValidationResult } from './validation.js'

export interface HuaqiuUserInfo {
  id: string
  token: string
  nickname?: string
  /** Unix seconds; known for browser-pushed sessions (auth.eda.cn window). */
  expiresAt?: number
}

export interface HuaqiuAuthApi {
  /**
   * Authoritative async check: a credential exists AND is known to be valid
   * (local expiry + cached remote validation). Never a mere token-presence
   * check — a host token supplied by hq-edge is not assumed valid just because
   * it exists (spec §10). Short-circuits to `false` after `invalidate()` until
   * re-validated or a fresh credential arrives.
   */
  isAuthenticated(): Promise<boolean>
  getAccessToken(): Promise<string | null>
  getUserInfo(): Promise<HuaqiuUserInfo | null>
  /** Node-side no-op in standalone: login always happens in the browser. */
  login(): Promise<void>
  /**
   * Request logout.
   *
   * In host mode this asks the EDA host (through hq-edge) to log out — it is
   * a REQUEST, never a local declaration. The authoritative state keeps coming
   * from the host, so on success we only drop the cached host session and let
   * the next `resolve()` re-ask hq-edge. A failed request throws and leaves
   * the current authentication state untouched.
   */
  logout(): Promise<void>
  /**
   * Single authoritative validation path (spec §7). Works identically for
   * standalone and host credentials; never depends on hq-edge.
   */
  validate(): Promise<AuthValidationResult>
  /**
   * Mark the current credential's validation state stale without deleting the
   * credential (kept for recovery). Next validation cannot reuse a previous
   * "valid" result (spec §9/§11). Call this when an API request returns 401.
   */
  invalidate(): void
  onAuthStateChanged(listener: (info: HuaqiuUserInfo | null) => void): () => void
}

export interface HuaqiuAuthService {
  auth: HuaqiuAuthApi
  /**
   * Node-only setters used by the webServer route handlers.
   * NOTE: `service.invalidate()` is the FULL reset (logout: drops the pushed
   * credential, persisted file and host cache). The capability-level
   * `auth.invalidate()` is validation-scoped and keeps the credential.
   */
  setCredentials(info: HuaqiuUserInfo): void
  invalidate(): void
  /**
   * True when running in HQ Edge host mode (a host base URL was configured —
   * overlay `config.hqEdgeBaseUrl` or `HQ_EDGE_BASE_URL`). The browser half
   * reads this over the webServer config route to decide whether the sidebar
   * login entrypoint is needed: in host mode EDA hands the credential to
   * hq-edge, so the auth plugin's own login UI is suppressed.
   */
  readonly hostMode: boolean
  /**
   * Resolved subscription balances endpoint injected by HQ Edge
   * (`config.subscriptionBalancesUrl`), or null when none was configured.
   * `/ai-usage` never falls back to a stale hardcoded environment endpoint.
   */
  readonly subscriptionBalancesUrl: string | null
  /**
   * Origin of {@link subscriptionBalancesUrl} (e.g. `https://www.eda.cn`), used
   * by the browser half for the GEN/ERC active-subscription calls. Null when no
   * endpoint was configured — DSH Auth never hardcodes a production host.
   */
  readonly subscriptionApiBaseUrl: string | null
  /**
   * Resolved subscription origin injected by HQ Edge (`config.subscriptionOrigin`),
   * or null when none was configured (standalone keeps its PROD default).
   */
  readonly subscriptionOrigin: string | null
  /**
   * Full「Go to profile」URL injected by HQ Edge (`config.profileUrl`), or null
   * when none was configured — the browser half then keeps its PROD default.
   */
  readonly profileUrl: string | null
}

const PERSIST_FILE = 'session.json'
const PERSIST_DIR = () => dshHomePath('auth')

/** Host-only label for diagnostics (never log a complete AI usage URL). */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '<invalid-url>'
  }
}

/** Scheme + host origin of a URL, or null when it does not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Bounded wait for the host to confirm a logout. Shorter than the login wait
 * (which must cover a human completing the EDA dialog): logout is a host-side
 * operation, so a confirmation that takes longer than this means it failed.
 */
const LOGOUT_WAIT_MS = 30_000

/**
 * Returns the persisted session, or null if absent/unreadable. Best-effort: a
 * corrupt or unreadable file is treated as "no session" rather than thrown.
 */
function readPersisted(): HuaqiuUserInfo | null {
  try {
    const file = join(PERSIST_DIR(), PERSIST_FILE)
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null
    const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : null
    if (!id || !token) return null
    const nickname = typeof raw.nickname === 'string' && raw.nickname.length > 0
      ? raw.nickname
      : undefined
    const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)
      ? raw.expiresAt
      : undefined
    return {
      id,
      token,
      ...(nickname ? { nickname } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
  } catch {
    return null
  }
}

function writePersisted(info: HuaqiuUserInfo): void {
  try {
    const dir = PERSIST_DIR()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, PERSIST_FILE)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(info), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* persistence is best-effort; never break the auth flow over a disk error */
  }
}

function deletePersisted(): void {
  try {
    const file = join(PERSIST_DIR(), PERSIST_FILE)
    if (existsSync(file)) rmSync(file, { force: true })
  } catch {
    /* best-effort */
  }
}

export class InMemoryHuaqiuAuthService implements HuaqiuAuthService {
  private current: HuaqiuUserInfo | null = null
  private listeners = new Set<(info: HuaqiuUserInfo | null) => void>()
  private readonly host: HostSessionResolver
  private readonly validator: TokenValidator
  private readonly doFetch: typeof fetch
  private readonly hostLoginPath: string
  private readonly hostLogoutPath: string
  /** Bound on the host login RPC (user must complete the EDA dialog). */
  private readonly loginWaitMs: number
  /**
   * True once the current credential has been rejected (API 401) or explicitly
   * invalidated. Keeps the credential for recovery but makes `isAuthenticated()`
   * short-circuit to false and forces a fresh remote validation next time.
   */
  private stale = false
  /** Last host credential version seen; see `observeHostVersion`. */
  private lastHostVersion: number | null = null
  private _log: PluginLogger | null = null
  private get log(): PluginLogger {
    if (this._log === null) this._log = getLogger('dsh-auth')
    return this._log
  }

  constructor(
    config?: Partial<HuaqiuAuthConfig> | null,
    opts?: { fetchImpl?: typeof fetch },
  ) {
    const resolved = resolveHostConfig(config)
    this.doFetch = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.host = new HostSessionResolver(
      resolved.hqEdgeBaseUrl ?? '',
      resolved.hostAuthPath ?? '/api/v1/auth/token',
      (resolved.hostSessionTtlSeconds ?? 300) * 1000,
      this.doFetch,
    )
    this.hostLoginPath = resolved.hostLoginPath ?? '/api/v1/auth/login'
    this.hostLogoutPath = resolved.hostLogoutPath ?? '/api/v1/auth/logout'
    this.loginWaitMs = 5 * 60_000
    this.validator = new TokenValidator({
      ttlMs: (resolved.validationTtlSeconds ?? 60) * 1000,
      fetchImpl: this.doFetch,
    })
    this.hostMode = this.host.enabled
    this.subscriptionBalancesUrl = resolved.subscriptionBalancesUrl?.length
      ? resolved.subscriptionBalancesUrl
      : null
    this.subscriptionApiBaseUrl = this.subscriptionBalancesUrl
      ? originOf(this.subscriptionBalancesUrl)
      : null
    this.subscriptionOrigin = resolved.subscriptionOrigin?.length
      ? resolved.subscriptionOrigin
      : null
    this.profileUrl = resolved.profileUrl?.length ? resolved.profileUrl : null
    this.log.info('auth service started', {
      hostMode: this.hostMode,
      hostAuthPath: resolved.hostAuthPath,
      hostSessionTtlSeconds: resolved.hostSessionTtlSeconds,
      // Hosts only — never a complete URL that could carry a credential.
      subscriptionBalancesHost: this.subscriptionBalancesUrl
        ? safeHost(this.subscriptionBalancesUrl)
        : null,
      subscriptionOrigin: this.subscriptionOrigin,
    })
  }

  /** Host mode is active iff a host base URL was configured (see HostSessionResolver.enabled). */
  readonly hostMode: boolean
  /** Subscription balances endpoint resolved by HQ Edge (`HQ_AI_ENV`); null → no call. */
  readonly subscriptionBalancesUrl: string | null
  /** Origin used for GEN/ERC active-subscription calls; null → unavailable. */
  readonly subscriptionApiBaseUrl: string | null
  /** Subscription origin resolved by HQ Edge (`HQ_AI_ENV`); null → standalone. */
  readonly subscriptionOrigin: string | null
  /**「Go to profile」URL resolved by HQ Edge (`HQ_AI_ENV`); null → standalone. */
  readonly profileUrl: string | null

  readonly auth: HuaqiuAuthApi = {
    isAuthenticated: async () => {
      // `stale` is "an upstream 401 was reported against a previous credential".
      // Run resolve() *first* so the host's version comparator can run — HQ Edge
      // bumps its credential version when the operator re-authes, and a newer
      // version means the previous 401 no longer applies. Only after that
      // observation do we honour the stale latch (if the credential is
      // unchanged). Without this ordering, a 401-driven invalidation would
      // keep the operator logged out even after HQ Edge swapped credentials.
      const info = await this.resolve()
      if (info === null) return false
      if (this.stale) return false
      return (await this.validateInternal()).status === 'valid'
    },
    getAccessToken: async () => (await this.resolve())?.token ?? null,
    getUserInfo: async () => this.resolve(),
    login: async () => {
      // Standalone: login is a browser action (auth.eda.cn iframe) — no-op.
      if (!this.host.enabled) return
      // Host mode: the browser-side iframe is suppressed, so clicking login
      // must ask the host (hq-edge → EDA TriggerLoginDialog) to open the EDA
      // login dialog. The host route blocks until AuthStateChanged flips the
      // credential (bounded), then we drop the cached host session so the next
      // resolve() re-fetches the fresh token.
      const res = await this.doFetch(`${this.host.baseUrl}${this.hostLoginPath}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.loginWaitMs),
      })
      if (!res.ok) {
        throw new Error(`host login not completed: HTTP ${res.status}`)
      }
      this.host.clear()
      this.stale = false
      this.validator.invalidate()
      this.emit()
    },
    logout: async () => {
      // Standalone: the browser owns the credential — drop it locally.
      if (!this.host.enabled) {
        this.invalidate()
        return
      }
      // Host mode: the EDA host (KiCad) owns the session, so logout is a
      // REQUEST forwarded through hq-edge (→ AuthService.TriggerLogout).
      // Success only means the host accepted/performed it; the authoritative
      // state is whatever the host reports next, so we drop the cached host
      // session and let the following resolve() re-ask hq-edge instead of
      // declaring the operator logged out ourselves.
      const res = await this.doFetch(`${this.host.baseUrl}${this.hostLogoutPath}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(LOGOUT_WAIT_MS),
      })
      if (!res.ok) {
        throw new Error(`host logout not completed: HTTP ${res.status}`)
      }
      this.host.clear()
      this.stale = true
      this.validator.invalidate()
      this.emit()
    },
    validate: () => this.validateInternal(),
    invalidate: () => this.markStale(),
    onAuthStateChanged: (listener) => this.on(listener),
  }

  /**
   * Spec §6.2 resolution order: host → pushed → persisted → null.
   *
   * Host mode is STRICT: an enabled host is the single source of truth. If the
   * host yields no credential, the operator is unauthenticated — we must NOT
   * fall back to a pushed/persisted credential left behind by an earlier
   * standalone (auth.eda.cn) login. Otherwise a stale `~/.dsh/auth/session.json`
   * would let the DSH plugins keep calling the backend while hq-edge itself has
   * no auth info. The standalone fallbacks only apply when no host is configured.
   *
   * A host credential the host itself reports as `authenticated: false` counts
   * as "no credential" — otherwise `/session` would hand the browser half a user
   * object its own `authenticated` flag contradicts, and the browser half (which
   * adopts the session only when `authenticated` is true) would silently drop
   * it. That mismatch is exactly how "the token reached HQ Edge but never
   * reached the plugin" presents.
   */
  private async resolve(): Promise<HuaqiuUserInfo | null> {
    if (this.host.enabled) {
      const host = await this.host.resolve()
      if (!host || !host.authenticated) {
        this.log.debug('host session unusable', {
          hostReachable: host !== null,
          hostAuthenticated: host?.authenticated ?? null,
        })
        return null
      }
      this.observeHostVersion(host.version)
      return toUserInfo(host)
    }
    if (this.current) return this.current
    return readPersisted()
  }

  /**
   * Track the host's credential version so a replaced credential re-arms the
   * session after a 401.
   *
   * `invalidate()` (called when a backend answers 401) must keep the session
   * down — but only for *that* credential. HQ Edge bumps `version` whenever EDA
   * replaces or clears its credential, so a new version means the operator has
   * a new token and the previous rejection no longer applies.
   */
  private observeHostVersion(version?: number): void {
    if (typeof version !== 'number' || !Number.isFinite(version)) return
    if (this.lastHostVersion !== null && version !== this.lastHostVersion) {
      this.stale = false
      this.validator.invalidate()
      this.log.info('host credential replaced — re-arming session', { version })
    }
    this.lastHostVersion = version
  }

  /**
   * Spec §7: resolve → local expiry → remote validation → update state.
   *
   * In HOST mode there is no remote validation: the host is the authority. It
   * received the credential from EDA and publishes its own `authenticated`
   * verdict, so probing `www.eda.cn/api/token/validate` here is not just
   * redundant — it is wrong. That endpoint does not know the credential class
   * EDA hands to HQ Edge (it answers `result: false`) and is unreachable in
   * offline deployments, so gating on it made every host-mode session read as
   * unauthenticated even while hq-edge reported `authenticated: true`.
   */
  private async validateInternal(): Promise<AuthValidationResult> {
    const info = await this.resolve()
    if (!info) {
      // Host mode deliberately does NOT latch `stale` here: an unreachable or
      // not-yet-logged-in host is a transient condition, and latching would
      // freeze the session even after the host recovers.
      if (!this.host.enabled) this.stale = true
      return { status: 'invalid', reason: 'invalid' }
    }
    if (this.host.enabled) {
      if (this.validator.isLocallyExpired(info.expiresAt)) {
        this.validator.invalidate(info.token)
        this.stale = true
        return { status: 'invalid', reason: 'expired' }
      }
      return { status: 'valid', userId: info.id, ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}) }
    }
    // Local expiry is an optimization; remote validation stays authoritative.
    if (this.validator.isLocallyExpired(info.expiresAt)) {
      this.validator.invalidate(info.token)
      this.stale = true
      return { status: 'invalid', reason: 'expired' }
    }
    const result = await this.validator.validate(info.token, { expiresAt: info.expiresAt })
    if (result.status === 'valid') this.stale = false
    else if (result.status === 'invalid') this.stale = true
    // 'unavailable' leaves the stale flag untouched — a network blip never
    // declares the credential invalid (spec §17).
    return result
  }

  /** Validation-scoped invalidation: keep the credential, drop cached validity.
   *
   *  In host mode the host cache *is* the cached validity — the validator only
   *  confirmed what the host already said — so the next call must re-fetch:
   *  otherwise a 401-driven `auth.invalidate()` would keep stale=true latched
   *  for the full `hostSessionTtlSeconds` (default 300 s), and an HQ-Edge
   *  credential replace in between would be invisible until the cache expired.
   */
  private markStale(): void {
    this.stale = true
    this.validator.invalidate()
    if (this.host.enabled) this.host.clear()
  }

  setCredentials(info: HuaqiuUserInfo): void {
    this.current = info
    this.stale = false
    this.validator.invalidate()
    // Never persist to the standalone store while running under a host: the
    // host (hq-edge) owns the credential in host mode, and a stale standalone
    // session must not leak across modes. Persistence is only meaningful in
    // standalone (silent-login restore).
    if (!this.hostMode) void writePersisted(info)
    this.emit()
  }

  invalidate(): void {
    const was = this.host.enabled || this.current !== null || readPersisted() !== null
    this.current = null
    this.host.clear()
    this.stale = true
    this.validator.invalidate()
    deletePersisted()
    if (was) this.emit()
  }

  private on(listener: (info: HuaqiuUserInfo | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = this.current
    for (const listener of this.listeners) listener(snapshot)
  }
}

function toUserInfo(host: ResolvedHostUser): HuaqiuUserInfo {
  return {
    id: host.id,
    token: host.token,
    ...(host.nickname !== undefined ? { nickname: host.nickname } : {}),
    ...(host.expiresAt !== undefined ? { expiresAt: host.expiresAt } : {}),
  }
}
