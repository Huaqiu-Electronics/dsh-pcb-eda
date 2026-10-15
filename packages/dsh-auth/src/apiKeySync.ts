/**
 * Huaqiu AI gateway credential sync (host mode).
 *
 * The bundled DSH's `huaqiu` provider resolves its api key through the
 * `HUAQIU_API_KEY` credential reference (overlay `apiKeyEnv`). In host mode the
 * authoritative credential lives in HQ Edge (mirroring the EDA/KiCad host), and
 * Workstream A strips `HUAQIU_API_KEY` from the child environment — so this
 * sync is the ONLY source of that credential (task huaqiu-ai-gateway §5.5).
 *
 * The sync watches the HQ Edge token endpoint directly with a per-call
 * loopback GET — deliberately NOT `hqEdge.auth.getAccessToken()`, whose
 * initial-null cache has no invalidation path — and mirrors the token into
 * `ctx.credentials` under the `HUAQIU_API_KEY` reference:
 *
 *   - authenticated host session → `set` (only when the token value changed);
 *   - explicit unauthenticated verdict (2xx + `authenticated: false`, or a 2xx
 *     payload without a usable credential) → `unset`;
 *   - transient network error / non-2xx host answer → warn and leave the
 *     current value untouched (a blip must never log the operator out).
 *
 * The same path serves both the `hq-eda` and `kicad` hosts — host identity is
 * HQ Edge configuration, never this plugin's concern.
 */
import { normalizeHostUser, type ResolvedHostUser } from './host.js'

/** Credential reference the `huaqiu` provider resolves per request. */
export const HUAQIU_API_KEY_REF = 'HUAQIU_API_KEY'

/** Default poll interval: 5 s, matching the DSH browser half's host refresh. */
export const DEFAULT_HUAQIU_API_KEY_SYNC_MS = 5000

/** Minimal writable credential store (the DSH `ctx.credentials` seam). */
export interface CredentialStore {
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/**
 * Resolves the credential store lazily on every sync round.
 *
 * The DSH `credentials` service may not be activated yet when this plugin
 * boots (service activation order), and direct `ctx.credentials` property
 * access throws "cannot get property ... without inject" in that window.
 * Resolving through `ctx.get('credentials')` per round returns `undefined`
 * while the service is unavailable — the round is skipped and retried on the
 * next poll, so the sync self-heals once the service activates, without a
 * restart (cordis guidance: "switch to `ctx.get('x')` with an absence check").
 */
export type CredentialStoreProvider = () => CredentialStore | null

/** Logger surface used by the sync (kept small so tests can pass a spy). */
export interface SyncLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
}

export class HuaqiuApiKeySync {
  private timer: NodeJS.Timeout | null = null
  /** Guards the poll timer so overlapping rounds can never run (task §5.4). */
  private inFlight = false
  /** Last token mirrored into the credential store (change detection). */
  private lastToken: string | null = null

  constructor(
    /** HQ Edge base URL ("" → disabled, matches HostSessionResolver.enabled). */
    readonly baseUrl: string,
    /** Token path on the host; default "/api/v1/auth/token". */
    readonly path: string,
    private readonly storeProvider: CredentialStoreProvider,
    private readonly log: SyncLogger,
    private readonly intervalMs: number = DEFAULT_HUAQIU_API_KEY_SYNC_MS,
    private readonly doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  /** Host-mode sync is active iff a base URL was configured. */
  get enabled(): boolean {
    return this.baseUrl.length > 0
  }

  /** Kick off an immediate sync, then poll on a non-overlapping interval. */
  start(): void {
    void this.syncNow()
    this.timer = setInterval(() => {
      if (this.inFlight) return
      this.inFlight = true
      void this.syncNow().finally(() => {
        this.inFlight = false
      })
    }, this.intervalMs)
    // Never keep the DSH process alive just for this timer.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Stop the poll timer. Safe to call more than once. */
  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One sync round: fetch the host token endpoint and mirror the verdict into
   * the credential store. Exported separately from `start()` so tests can run
   * rounds deterministically without timers.
   */
  async syncNow(): Promise<void> {
    // Resolve the credential store lazily: the `credentials` service may not
    // be activated yet while this plugin boots (activation order). Skipping
    // the round is safe — the next poll retries once the service is live.
    const store = this.storeProvider()
    if (store === null) {
      this.log.debug('huaqiu api-key sync skipped: credentials service unavailable')
      return
    }
    const url = `${this.baseUrl}${this.path}`
    let res: Response | null = null
    let info: ResolvedHostUser | null = null
    try {
      res = await this.doFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      })
      if (res.ok) {
        info = normalizeHostUser(await res.json() as Record<string, unknown>)
      }
    } catch (err) {
      // Transient network error: never unset — a blip must not log the
      // operator out (task §5.4).
      this.log.warn('huaqiu api-key sync fetch failed', { url, error: String(err) })
      return
    }
    if (info !== null && info.authenticated) {
      if (info.token !== this.lastToken) {
        this.lastToken = info.token
        await store.set(HUAQIU_API_KEY_REF, info.token)
        this.log.info('huaqiu api-key credential synced', { userId: info.id })
      }
      return
    }
    // A 2xx answer without a usable authenticated credential is the HOST'S
    // explicit verdict (logout / not-yet-logged-in / cleared token) — mirror
    // the cleared state. Anything else (non-2xx) is a host-side error: warn
    // and keep the current value.
    if (res !== null && res.ok) {
      if (this.lastToken !== null) {
        this.lastToken = null
        await store.unset(HUAQIU_API_KEY_REF)
        this.log.info('huaqiu api-key credential cleared', { explicit: true })
      }
      return
    }
    this.log.warn('huaqiu api-key sync rejected by host', {
      url,
      status: res?.status ?? null,
    })
  }
}
