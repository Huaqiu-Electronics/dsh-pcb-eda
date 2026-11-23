/**
 * Tests for the standalone credential bridge (`standaloneCredentials.ts`).
 *
 * Contract under test:
 *  - a credential that already exists at boot reaches `HUAQIU_API_KEY` without
 *    waiting for a new login (silent restore / pushed session);
 *  - every push (login, refresh) mirrors the token in memory;
 *  - an unchanged token writes nothing (no store churn);
 *  - logout unsets the reference so the next request fails as
 *    MISSING_CREDENTIAL rather than silently reusing a dead token;
 *  - a credentials service that is not active yet does not crash the boot — the
 *    next push retries;
 *  - dispose() stops listening.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  HUAQIU_API_KEY_REF,
  type SyncLogger,
} from '../src/apiKeySync.js'
import {
  HuaqiuStandaloneCredentialBridge,
  type StandaloneAuthPort,
} from '../src/standaloneCredentials.js'

type Listener = (info: { token: string } | null) => void

function fakeAuth(initial: { id: string, token: string } | null) {
  const listeners = new Set<Listener>()
  const auth: StandaloneAuthPort & { push: (token: string | null) => void, listenerCount: () => number } = {
    getUserInfo: vi.fn().mockResolvedValue(initial),
    onAuthStateChanged: vi.fn((listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    push: (token) => {
      for (const listener of listeners) listener(token === null ? null : { token })
    },
    listenerCount: () => listeners.size,
  }
  return auth
}

function fakeStore() {
  return {
    set: vi.fn().mockResolvedValue(undefined),
    unset: vi.fn().mockResolvedValue(undefined),
    setVolatile: vi.fn().mockResolvedValue(undefined),
    unsetVolatile: vi.fn().mockResolvedValue(undefined),
  }
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as SyncLogger

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

describe('HuaqiuStandaloneCredentialBridge', () => {
  it('mirrors an existing credential at start()', async () => {
    const store = fakeStore()
    const auth = fakeAuth({ id: 'u1', token: 'tok-existing' })
    const bridge = new HuaqiuStandaloneCredentialBridge(auth, () => store, logger)
    bridge.start()
    await flush()
    expect(store.setVolatile).toHaveBeenCalledWith(HUAQIU_API_KEY_REF, 'tok-existing')
    expect(store.set).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('mirrors a push and skips an unchanged token', async () => {
    const store = fakeStore()
    const auth = fakeAuth(null)
    const bridge = new HuaqiuStandaloneCredentialBridge(auth, () => store, logger)
    auth.push('tok-1')
    await flush()
    expect(store.setVolatile).toHaveBeenCalledTimes(1)
    auth.push('tok-1')
    await flush()
    expect(store.setVolatile).toHaveBeenCalledTimes(1)
    auth.push('tok-2')
    await flush()
    expect(store.setVolatile).toHaveBeenLastCalledWith(HUAQIU_API_KEY_REF, 'tok-2')
    bridge.dispose()
  })

  it('clears the reference on logout', async () => {
    const store = fakeStore()
    const auth = fakeAuth({ id: 'u1', token: 'tok-1' })
    const bridge = new HuaqiuStandaloneCredentialBridge(auth, () => store, logger)
    await bridge.mirror('tok-1')
    auth.push(null)
    await flush()
    expect(store.unsetVolatile).toHaveBeenCalledWith(HUAQIU_API_KEY_REF)
    // Nothing to clear twice.
    auth.push(null)
    await flush()
    expect(store.unsetVolatile).toHaveBeenCalledTimes(1)
    bridge.dispose()
  })

  it('does not crash when the credentials service is not active yet', async () => {
    const auth = fakeAuth({ id: 'u1', token: 'tok-1' })
    const bridge = new HuaqiuStandaloneCredentialBridge(auth, () => null, logger)
    bridge.start()
    await flush()
    expect(logger.debug).toHaveBeenCalled()
    // Once the service appears, the same bridge mirrors the next push.
    const store = fakeStore()
    const live = new HuaqiuStandaloneCredentialBridge(auth, () => store, logger)
    auth.push('tok-2')
    await flush()
    expect(store.setVolatile).toHaveBeenCalledWith(HUAQIU_API_KEY_REF, 'tok-2')
    bridge.dispose()
    live.dispose()
  })

  it('stops listening after dispose()', async () => {
    const store = fakeStore()
    const auth = fakeAuth(null)
    const bridge = new HuaqiuStandaloneCredentialBridge(auth, () => store, logger)
    expect(auth.listenerCount()).toBe(1)
    bridge.dispose()
    expect(auth.listenerCount()).toBe(0)
    auth.push('tok-3')
    await flush()
    expect(store.setVolatile).not.toHaveBeenCalled()
  })
})
