/**
 * Tests for HuaqiuApiKeySync — the host-mode mirror of the operator token into
 * the DSH credential reference `HUAQIU_API_KEY` (task huaqiu-ai-gateway §5).
 *
 * Coverage (acceptance list from task §7.2):
 *  - authenticated 2xx  → set with the token value;
 *  - unchanged token    → no rewrite (set called once);
 *  - changed token      → rewritten with the new value;
 *  - explicit `authenticated: false` (2xx) → unset;
 *  - 2xx without a usable credential        → unset;
 *  - non-2xx host answer → warn, neither set nor unset;
 *  - network throw       → warn, neither set nor unset;
 *  - start() runs an immediate round (no timer wait);
 *  - dispose() stops polling;
 *  - polling rounds never overlap (in-flight latch);
 *  - enabled=false with an empty base URL.
 *
 * No real network is touched: fetch is injected, credentials are spies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HUAQIU_API_KEY_SYNC_MS,
  HuaqiuApiKeySync,
  HUAQIU_API_KEY_REF,
  type CredentialStore,
  type CredentialStoreProvider,
  type SyncLogger,
} from '../src/apiKeySync.js'

const TOKEN_URL = 'http://localhost:18080/api/v1/auth/token'

interface FetchBehavior {
  payload?: Record<string, unknown> | null
  status?: number
  throwNetwork?: boolean
}

function fetchStub(behavior: FetchBehavior = {}): typeof fetch {
  const { payload = { token: 'tok-1', userId: 'u1', authenticated: true, version: 1 }, status = 200, throwNetwork = false } = behavior
  return vi.fn(async (input: RequestInfo | URL) => {
    if (throwNetwork) throw new Error('network unavailable')
    const ok = status >= 200 && status < 300
    const body = payload ?? {}
    return { ok, status, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
}

function makeHarness(behavior: FetchBehavior = {}) {
  const fetchImpl = fetchStub(behavior)
  const credentials: CredentialStore & { set: ReturnType<typeof vi.fn>; unset: ReturnType<typeof vi.fn> } = {
    set: vi.fn().mockResolvedValue(undefined),
    unset: vi.fn().mockResolvedValue(undefined),
  }
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as SyncLogger & {
    debug: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
  }
  const sync = new HuaqiuApiKeySync(
    'http://localhost:18080',
    '/api/v1/auth/token',
    () => credentials,
    logger,
    50,
    fetchImpl,
  )
  return { sync, credentials, logger, fetchImpl }
}

/** Test-only handle to the sync's private mirror state. */
function lastTokenOf(sync: HuaqiuApiKeySync): string | null {
  return (sync as unknown as { lastToken: string | null }).lastToken
}

describe('HuaqiuApiKeySync', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mirrors an authenticated host session into the HUAQIU_API_KEY reference', async () => {
    const { sync, credentials } = makeHarness()
    await sync.syncNow()
    expect(credentials.set).toHaveBeenCalledTimes(1)
    expect(credentials.set).toHaveBeenCalledWith(HUAQIU_API_KEY_REF, 'tok-1')
    expect(credentials.unset).not.toHaveBeenCalled()
  })

  it('does not rewrite the credential when the token is unchanged', async () => {
    const { sync, credentials } = makeHarness()
    await sync.syncNow()
    await sync.syncNow()
    expect(credentials.set).toHaveBeenCalledTimes(1)
  })

  it('rewrites the credential when the host token changes', async () => {
    const { sync, credentials } = makeHarness()
    await sync.syncNow()
    expect(credentials.set).toHaveBeenCalledTimes(1)
    // Host replaces the credential (version bump → different token).
    const next = makeHarness({ payload: { token: 'tok-2', userId: 'u1', authenticated: true, version: 2 } })
    ;(next.sync as unknown as { lastToken: string | null }).lastToken = lastTokenOf(sync)
    await next.sync.syncNow()
    expect(next.credentials.set).toHaveBeenCalledTimes(1)
    expect(next.credentials.set).toHaveBeenCalledWith(HUAQIU_API_KEY_REF, 'tok-2')
  })

  it('unsets on an explicit unauthenticated verdict (2xx + authenticated: false)', async () => {
    const { sync, credentials } = makeHarness()
    await sync.syncNow()
    expect(credentials.set).toHaveBeenCalledTimes(1)
    const loggedOut = makeHarness({ payload: { token: 'tok-1', userId: 'u1', authenticated: false, version: 2 } })
    ;(loggedOut.sync as unknown as { lastToken: string | null }).lastToken = 'tok-1'
    await loggedOut.sync.syncNow()
    expect(loggedOut.credentials.unset).toHaveBeenCalledWith(HUAQIU_API_KEY_REF)
    expect(loggedOut.credentials.set).not.toHaveBeenCalled()
  })

  it('unsets on a 2xx payload without a usable credential', async () => {
    const { sync, credentials } = makeHarness()
    await sync.syncNow()
    expect(credentials.set).toHaveBeenCalledTimes(1)
    const cleared = makeHarness({ payload: null, status: 200 })
    ;(cleared.sync as unknown as { lastToken: string | null }).lastToken = 'tok-1'
    await cleared.sync.syncNow()
    expect(cleared.credentials.unset).toHaveBeenCalledWith(HUAQIU_API_KEY_REF)
    expect(cleared.credentials.set).not.toHaveBeenCalled()
  })

  it('keeps the credential untouched on a non-2xx host answer (warn only)', async () => {
    const { sync, credentials, logger } = makeHarness({ status: 500 })
    await sync.syncNow()
    expect(credentials.set).not.toHaveBeenCalled()
    expect(credentials.unset).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('keeps the credential untouched on a network error (warn only)', async () => {
    const { sync, credentials, logger } = makeHarness({ throwNetwork: true })
    await sync.syncNow()
    expect(credentials.set).not.toHaveBeenCalled()
    expect(credentials.unset).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('start() runs an immediate round without waiting for the poll interval', async () => {
    vi.useFakeTimers()
    const { sync, credentials } = makeHarness()
    sync.start()
    await vi.advanceTimersByTimeAsync(0) // flush the immediate syncNow round
    expect(credentials.set).toHaveBeenCalledTimes(1)
    sync.dispose()
  })

  it('dispose() stops polling (no further rounds after clearInterval)', async () => {
    vi.useFakeTimers()
    const { sync, credentials } = makeHarness()
    sync.start()
    await vi.advanceTimersByTimeAsync(0) // immediate round settles first
    const callsAfterStart = credentials.set.mock.calls.length
    sync.dispose()
    await vi.advanceTimersByTimeAsync(DEFAULT_HUAQIU_API_KEY_SYNC_MS * 3)
    expect(credentials.set.mock.calls.length).toBe(callsAfterStart)
  })

  it('poll rounds never overlap while a round is in flight', async () => {
    vi.useFakeTimers()
    // Controllable gate: the fetch hangs until the test releases it, so the
    // in-flight latch can be observed across several timer ticks.
    const gate: { release: () => void } = { release: () => {} }
    const fetchImpl = (async () => {
      await new Promise<void>((r) => {
        gate.release = r as () => void
      })
      return { ok: true, status: 200, json: async () => ({ token: 'tok-1', userId: 'u1', authenticated: true }) } as unknown as Response
    }) as unknown as typeof fetch
    const credentials: CredentialStore & { set: ReturnType<typeof vi.fn> } = {
      set: vi.fn().mockResolvedValue(undefined),
      unset: vi.fn().mockResolvedValue(undefined),
    }
    const sync = new HuaqiuApiKeySync(
      'http://localhost:18080',
      '/api/v1/auth/token',
      () => credentials,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      50,
      fetchImpl,
    )
    sync.start()
    await vi.advanceTimersByTimeAsync(50) // first poll fires, fetch hangs
    const pendingRound = (sync as unknown as { inFlight: boolean }).inFlight
    expect(pendingRound).toBe(true)
    await vi.advanceTimersByTimeAsync(200) // more ticks while still in flight
    expect(credentials.set).toHaveBeenCalledTimes(0) // nothing completed yet
    gate.release()
    await vi.advanceTimersByTimeAsync(0) // flush the released round
    expect(credentials.set).toHaveBeenCalledTimes(1) // exactly one round completed
    sync.dispose()
  })

  it('skips the round (no throw, no write) while the credentials service is unavailable', async () => {
    // Boot-order window: `ctx.credentials` is not injected yet. Direct property
    // access would throw "cannot get property ... without inject"; the sync
    // must resolve lazily and defer to the next poll instead.
    const fetchImpl = fetchStub()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as SyncLogger & {
      debug: ReturnType<typeof vi.fn>
      info: ReturnType<typeof vi.fn>
      warn: ReturnType<typeof vi.fn>
    }
    const sync = new HuaqiuApiKeySync(
      'http://localhost:18080',
      '/api/v1/auth/token',
      () => null,
      logger,
      50,
      fetchImpl,
    )
    await expect(sync.syncNow()).resolves.toBeUndefined()
    expect(logger.debug).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('recovers once the credentials service becomes available (provider flips to a store)', async () => {
    // Self-healing: a skipped round does not wedge the sync; the next round
    // writes the token as soon as the service is resolvable.
    let store: CredentialStore | null = null
    const credentials: CredentialStore & { set: ReturnType<typeof vi.fn>; unset: ReturnType<typeof vi.fn> } = {
      set: vi.fn().mockResolvedValue(undefined),
      unset: vi.fn().mockResolvedValue(undefined),
    }
    const sync = new HuaqiuApiKeySync(
      'http://localhost:18080',
      '/api/v1/auth/token',
      () => store,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      50,
      fetchStub(),
    )
    await sync.syncNow() // skipped: service unavailable
    store = credentials // service activates
    await sync.syncNow() // next round writes
    expect(credentials.set).toHaveBeenCalledTimes(1)
    expect(credentials.set).toHaveBeenCalledWith(HUAQIU_API_KEY_REF, 'tok-1')
  })

  it('is disabled with an empty base URL', () => {
    const sync = new HuaqiuApiKeySync(
      '',
      '/api/v1/auth/token',
      () => null,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    )
    expect(sync.enabled).toBe(false)
  })
})
