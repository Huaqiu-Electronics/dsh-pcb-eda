import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { InMemoryHuaqiuAuthService, HostLoginIncompleteError } from '../src/service.js'
import { authFetch } from './helpers.js'

// Isolate the persisted-session directory so `isAuthenticated()`'s file fallback
// never reads a stray `~/.dsh/auth/session.json` from another run.
const TMP = join(tmpdir(), `dsh-auth-service-test-${process.pid}`)
vi.mock('@deepseek-ai/dsh-home-paths', () => ({ dshHomePath: () => TMP }))

describe('InMemoryHuaqiuAuthService', () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }))
  afterEach(() => rmSync(TMP, { recursive: true, force: true }))

  it('starts unauthenticated and reports null credentials', async () => {
    const svc = new InMemoryHuaqiuAuthService()
    expect(svc.hostMode).toBe(false)
    expect(await svc.auth.isAuthenticated()).toBe(false)
    expect(await svc.auth.getAccessToken()).toBeNull()
    expect(await svc.auth.getUserInfo()).toBeNull()
  })

  it('hostMode reflects an HQ Edge host base URL config', () => {
    expect(new InMemoryHuaqiuAuthService().hostMode).toBe(false)
    expect(new InMemoryHuaqiuAuthService({}).hostMode).toBe(false)
    expect(new InMemoryHuaqiuAuthService({ hqEdgeBaseUrl: 'http://localhost:9999' }).hostMode).toBe(true)
  })

  it('stores credentials and exposes them via the auth capability', async () => {
    const svc = new InMemoryHuaqiuAuthService({}, { fetchImpl: authFetch() })
    svc.setCredentials({ id: 'u1', token: 'tok-1', nickname: 'Alice' })
    expect(await svc.auth.isAuthenticated()).toBe(true)
    expect(await svc.auth.getAccessToken()).toBe('tok-1')
    expect(await svc.auth.getUserInfo()).toEqual({ id: 'u1', token: 'tok-1', nickname: 'Alice' })
  })

  it('update replaces the previous credentials (acceptance group B)', async () => {
    const svc = new InMemoryHuaqiuAuthService()
    svc.setCredentials({ id: 'u1', token: 'old' })
    svc.setCredentials({ id: 'u1', token: 'new' })
    expect(await svc.auth.getAccessToken()).toBe('new')
  })

  it('logout invalidates node state (acceptance group C)', async () => {
    const svc = new InMemoryHuaqiuAuthService()
    svc.setCredentials({ id: 'u1', token: 'tok' })
    await svc.auth.logout()
    expect(await svc.auth.isAuthenticated()).toBe(false)
    expect(await svc.auth.getAccessToken()).toBeNull()
  })

  it('notifies listeners on set and invalidate', () => {
    const svc = new InMemoryHuaqiuAuthService()
    const seen: Array<unknown> = []
    svc.auth.onAuthStateChanged((info) => seen.push(info))
    svc.setCredentials({ id: 'u1', token: 't' })
    svc.invalidate()
    expect(seen).toEqual([{ id: 'u1', token: 't' }, null])
  })

  it('onAuthStateChanged returns a working unsubscriber', () => {
    const svc = new InMemoryHuaqiuAuthService()
    const spy = vi.fn()
    const off = svc.auth.onAuthStateChanged(spy)
    off()
    svc.setCredentials({ id: 'u1', token: 't' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('standalone login stays a no-op (login is a browser action)', async () => {
    const svc = new InMemoryHuaqiuAuthService({}, { fetchImpl: authFetch() })
    await expect(svc.auth.login()).resolves.toBeUndefined()
    expect(await svc.auth.getAccessToken()).toBeNull()
  })

  it('host-mode login calls the host login endpoint and refreshes the session', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/v1/auth/login')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, authenticated: true }) } as Response
      }
      if (url.includes('/api/token/validate')) {
        return { ok: true, status: 200, json: async () => ({ result: true }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ token: 'host-tok', userId: 'host-u' }) } as Response
    }) as unknown as typeof fetch

    const svc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://localhost:9999' },
      { fetchImpl },
    )
    expect(svc.hostMode).toBe(true)
    await svc.auth.login()
    expect(calls.some((u) => u.endsWith('/api/v1/auth/login'))).toBe(true)
    // After the dialog completed the cached host session is refreshed.
    expect(await svc.auth.getAccessToken()).toBe('host-tok')
    expect(await svc.auth.isAuthenticated()).toBe(true)
  })

  it('host-mode logout requests EDA logout through hq-edge (never fakes it locally)', async () => {
    const calls: string[] = []
    // The host confirms the logout: it now reports `authenticated: false`.
    let hostAuthenticated = true
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/v1/auth/logout')) {
        hostAuthenticated = false
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
      }
      if (url.includes('/api/token/validate')) {
        return { ok: true, status: 200, json: async () => ({ result: true }) } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: 'host-tok',
          userId: 'host-u',
          authenticated: hostAuthenticated,
        }),
      } as Response
    }) as unknown as typeof fetch

    const svc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://localhost:9999' },
      { fetchImpl },
    )
    expect(await svc.auth.isAuthenticated()).toBe(true)

    await svc.auth.logout()

    // The request reached the host's logout endpoint (→ TriggerLogout).
    expect(calls.some((u) => u.endsWith('/api/v1/auth/logout'))).toBe(true)
    // The unauthenticated verdict comes from the HOST, re-read after the
    // request — not from a local flag set when logout() resolved.
    expect(hostAuthenticated).toBe(false)
    expect(await svc.auth.isAuthenticated()).toBe(false)
  })

  it('host-mode logout keeps the session when the host rejects the request', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/logout')) {
        return { ok: false, status: 502, json: async () => ({ ok: false }) } as Response
      }
      if (url.includes('/api/token/validate')) {
        return { ok: true, status: 200, json: async () => ({ result: true }) } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: 'host-tok', userId: 'host-u', authenticated: true }),
      } as Response
    }) as unknown as typeof fetch

    const svc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://localhost:9999' },
      { fetchImpl },
    )
    await expect(svc.auth.logout()).rejects.toThrow('host logout not completed')
    // The operator is still logged in — we never pretended otherwise.
    expect(await svc.auth.isAuthenticated()).toBe(true)
    expect(await svc.auth.getAccessToken()).toBe('host-tok')
  })

  it('host-mode login propagates a not-completed dialog', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/login')) {
        return { ok: false, status: 401, json: async () => ({ ok: false }) } as Response
      }
      if (url.includes('/api/token/validate')) {
        return { ok: true, status: 200, json: async () => ({ result: true }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ token: 'host-tok', userId: 'host-u' }) } as Response
    }) as unknown as typeof fetch

    const svc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://localhost:9999' },
      { fetchImpl },
    )
    await expect(svc.auth.login()).rejects.toThrow('host login not completed')
  })

  it('host-mode login reports a DISMISSED dialog as such (not as a server fault)', async () => {
    // The host answers 401 the moment the dialog closes, so a cancellation
    // settles here immediately. It must be typed: the routes layer turns this
    // into 401 "still signed out", while an unexpected status stays a 500.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/login')) {
        return { ok: false, status: 401, json: async () => ({ ok: false }) } as Response
      }
      // The host still has no session (that is what a dismissal means).
      return {
        ok: true,
        status: 200,
        json: async () => ({ authenticated: false, token: null, userId: null }),
      } as Response
    }) as unknown as typeof fetch

    const svc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://localhost:9999' },
      { fetchImpl },
    )
    const err = await svc.auth.login().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HostLoginIncompleteError)
    expect((err as HostLoginIncompleteError).reason).toBe('dismissed')
    // Still signed out — never a credential invented from a cancelled dialog.
    expect(await svc.auth.isAuthenticated()).toBe(false)
    expect(await svc.auth.getAccessToken()).toBeNull()
  })

  it('host-mode login types a non-401 host failure as `failed` and a timeout as `timeout`', async () => {
    const hostSvc = (status: number): InMemoryHuaqiuAuthService =>
      new InMemoryHuaqiuAuthService(
        { hqEdgeBaseUrl: 'http://localhost:9999' },
        {
          fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url.endsWith('/api/v1/auth/login')) {
              return { ok: false, status, json: async () => ({ ok: false }) } as Response
            }
            return { ok: true, status: 200, json: async () => ({ token: 't', userId: 'u' }) } as Response
          }) as unknown as typeof fetch,
        },
      )
    const failed = await hostSvc(502).auth.login().then(() => null, (e: unknown) => e)
    expect((failed as HostLoginIncompleteError).reason).toBe('failed')

    // A bounded wait that expires rejects with a TimeoutError — the operator
    // could still be looking at a dialog, so this is NOT "dismissed".
    const timeoutSvc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://localhost:9999' },
      {
        fetchImpl: vi.fn(async () => {
          const e = new Error('The operation was aborted due to timeout')
          e.name = 'TimeoutError'
          throw e
        }) as unknown as typeof fetch,
      },
    )
    const timedOut = await timeoutSvc.auth.login().then(() => null, (e: unknown) => e)
    expect((timedOut as HostLoginIncompleteError).reason).toBe('timeout')
    expect((timedOut as Error).message).toContain('did not answer in time')
  })
})
