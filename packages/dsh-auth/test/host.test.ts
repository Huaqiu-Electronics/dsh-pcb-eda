import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryHuaqiuAuthService } from '../src/service.js'
import { HostSessionResolver, normalizeHostUser, resolveHostConfig } from '../src/host.js'
import { authFetch } from './helpers.js'

// Redirect the persisted-session directory to a temp dir so the disk round-trip
// is real (no mocking of fs) but never touches ~/.dsh.
const TMP = join(tmpdir(), `dsh-auth-host-test-${process.pid}`)
vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  dshHomePath: () => TMP,
}))

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }) })
afterEach(() => { rmSync(TMP, { recursive: true, force: true }) })

function fakeFetchOnce(payload: Record<string, unknown> | null, ok = true) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 401,
    json: async () => payload,
  })) as unknown as typeof fetch
}

describe('resolveHostConfig', () => {
  it('prefers overlay config over env', () => {
    const c = resolveHostConfig(
      { hqEdgeBaseUrl: 'http://overlay:1' },
      { HQ_EDGE_BASE_URL: 'http://env:2', HQ_EDGE_HOST_TTL_SECONDS: '99' },
    )
    expect(c.hqEdgeBaseUrl).toBe('http://overlay:1')
    // env still fills the unconfigured keys
    expect(c.hostSessionTtlSeconds).toBe(99)
  })

  it('falls back to env when overlay is silent', () => {
    const c = resolveHostConfig(undefined, {
      HQ_EDGE_BASE_URL: 'http://env:2',
      HQ_EDGE_AUTH_PATH: '/x',
    })
    expect(c.hqEdgeBaseUrl).toBe('http://env:2')
    expect(c.hostAuthPath).toBe('/x')
  })

  it('applies defaults when nothing is configured', () => {
    const c = resolveHostConfig(undefined, {})
    expect(c.hqEdgeBaseUrl).toBe('')
    expect(c.hostAuthPath).toBe('/api/v1/auth/token')
    expect(c.hostSessionTtlSeconds).toBe(300)
  })

  // Standalone builds have no supervisor to inject the AI endpoints, so the
  // `HQ_AI_ENV` table must drive ALL of them — gateway, balances, subscription
  // origin and profile URL — otherwise a `test` build mixes environments.
  it('resolves every AI endpoint from HQ_AI_ENV in standalone (prod default)', () => {
    const c = resolveHostConfig(undefined, {})
    expect(c.aiEnvironment).toBe('prod')
    expect(c.aiGatewayBaseUrl).toBe('https://www.eda.cn/user-rest/ai/v1')
    expect(c.subscriptionBalancesUrl).toBe('https://www.eda.cn/sub-api/subscriptions/balances/current')
    expect(c.subscriptionOrigin).toBe('https://gen.eda.cn')
    expect(c.profileUrl).toBe('https://www.eda.cn/account/profile')
  })

  it('switches every AI endpoint to the test table', () => {
    const c = resolveHostConfig(undefined, { HQ_AI_ENV: 'test' })
    expect(c.aiEnvironment).toBe('test')
    expect(c.aiGatewayBaseUrl).toBe('http://www.fdatasheets.com/user-rest/ai/v1')
    expect(c.subscriptionBalancesUrl).toBe('http://www.fdatasheets.com/sub-api/subscriptions/balances/current')
    expect(c.subscriptionOrigin).toBe('http://gen.fdatasheets.com')
    // TEST serves the account page one level higher than PROD.
    expect(c.profileUrl).toBe('http://www.fdatasheets.com/account')
  })

  it('lets the host overlay win over the environment table', () => {
    const c = resolveHostConfig({
      hqEdgeBaseUrl: 'http://localhost:18080',
      aiGatewayBaseUrl: 'http://127.0.0.1:9443/ai/v1',
      subscriptionBalancesUrl: 'http://127.0.0.1:9443/balances',
      subscriptionOrigin: 'http://127.0.0.1:9443',
      profileUrl: 'http://127.0.0.1:9443/profile',
    }, { HQ_AI_ENV: 'test' })
    expect(c.aiGatewayBaseUrl).toBe('http://127.0.0.1:9443/ai/v1')
    expect(c.subscriptionBalancesUrl).toBe('http://127.0.0.1:9443/balances')
    expect(c.subscriptionOrigin).toBe('http://127.0.0.1:9443')
    expect(c.profileUrl).toBe('http://127.0.0.1:9443/profile')
  })

  it('keeps host mode strict: no injection means no endpoint, not a preset', () => {
    const c = resolveHostConfig({ hqEdgeBaseUrl: 'http://localhost:18080' }, { HQ_AI_ENV: 'test' })
    expect(c.subscriptionBalancesUrl).toBe('')
    expect(c.subscriptionOrigin).toBe('')
    expect(c.profileUrl).toBe('')
  })

  it('prefers a non-empty per-endpoint env override over the preset', () => {
    const c = resolveHostConfig(undefined, {
      HQ_AI_ENV: 'prod',
      HQ_AI_PROFILE_URL: 'http://local:9000/account/',
      HQ_AI_SUBSCRIPTION_ORIGIN: 'http://gen.local:9000/',
    })
    expect(c.profileUrl).toBe('http://local:9000/account')
    expect(c.subscriptionOrigin).toBe('http://gen.local:9000')
    expect(c.subscriptionBalancesUrl).toBe('https://www.eda.cn/sub-api/subscriptions/balances/current')
  })
})

describe('normalizeHostUser', () => {
  it('requires both token and id', () => {
    expect(normalizeHostUser({ token: 't' })).toBeNull()
    expect(normalizeHostUser({ userId: 'u' })).toBeNull()
  })
  it('accepts userId / id / user_id', () => {
    expect(normalizeHostUser({ token: 't', id: 'u' })?.id).toBe('u')
    expect(normalizeHostUser({ token: 't', userId: 'u2' })?.id).toBe('u2')
    expect(normalizeHostUser({ token: 't', user_id: 'u3' })?.id).toBe('u3')
  })
  it('carries nickname', () => {
    expect(normalizeHostUser({ token: 't', id: 'u', nickname: 'Bob' })?.nickname).toBe('Bob')
  })
})

describe('HostSessionResolver', () => {
  it('is disabled and returns null without a base url', async () => {
    const r = new HostSessionResolver('', '/api/v1/auth/token', 300_000)
    expect(r.enabled).toBe(false)
    expect(await r.resolve()).toBeNull()
  })

  it('re-fetches each call and never holds a stale positive cache', async () => {
    const fetchImpl = fakeFetchOnce({ token: 'tok', userId: 'u' })
    const r = new HostSessionResolver('http://hq', '/api/v1/auth/token', 300_000, fetchImpl)
    // Hosts without an explicit `authenticated` field are taken as the old
    // contract was: a usable token+id means authenticated. The resolver must
    // carry that verdict through so downstream `validate()` does not
    // re-probe a public endpoint that does not know this token class.
    expect(await r.resolve()).toEqual({ id: 'u', token: 'tok', authenticated: true })
    expect(await r.resolve()).toEqual({ id: 'u', token: 'tok', authenticated: true })
    // No stale positive cache: every resolve re-asks the host so a credential
    // clear (logout) is observed on the very next poll. fetch is hit each time.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('clear() forces a re-fetch', async () => {
    const fetchImpl = fakeFetchOnce({ token: 'tok', userId: 'u' })
    const r = new HostSessionResolver('http://hq', '/api/v1/auth/token', 300_000, fetchImpl)
    await r.resolve()
    r.clear()
    await r.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('falls back to a recent cached session on a transient network error', async () => {
    const fetchImpl = vi.fn()
    fetchImpl.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'tok', userId: 'u' }),
    }))
    fetchImpl.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const r = new HostSessionResolver(
      'http://hq',
      '/api/v1/auth/token',
      300_000,
      fetchImpl as unknown as typeof fetch,
    )
    expect(await r.resolve()).toEqual({ id: 'u', token: 'tok', authenticated: true })
    // Second call errors, but the recent successful cache is returned (within TTL)
    // so a transient host blip does not log the operator out.
    expect(await r.resolve()).toEqual({ id: 'u', token: 'tok', authenticated: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT fall back to cache when the TTL window is zero', async () => {
    const fetchImpl = vi.fn()
    fetchImpl.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: 'tok', userId: 'u' }),
    }))
    fetchImpl.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const r = new HostSessionResolver(
      'http://hq',
      '/api/v1/auth/token',
      0 /* no error-fallback window — the cache must never be used */,
      fetchImpl as unknown as typeof fetch,
    )
    expect(await r.resolve()).toEqual({ id: 'u', token: 'tok', authenticated: true })
    // With no fallback window the error is surfaced rather than masked.
    expect(await r.resolve()).toBeNull()
  })
})

describe('InMemoryHuaqiuAuthService host mode', () => {
  it('resolves the host session ahead of a pushed session', async () => {
    const fetchImpl = fakeFetchOnce({ token: 'host-tok', userId: 'host-u' })
    const svc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://hq' },
      { fetchImpl },
    )
    // A browser push should NOT override the authoritative host session.
    svc.setCredentials({ id: 'pushed-u', token: 'pushed-tok' })
    expect(await svc.auth.getAccessToken()).toBe('host-tok')
    expect((await svc.auth.getUserInfo())?.id).toBe('host-u')
  })

  it('does NOT fall back to standalone credentials when the host has none (regression)', async () => {
    // hq-edge is up but has no auth info: GET /api/v1/auth/token → 200 {token:null}.
    const fetchImpl = authFetch({ hostPayload: { token: null, userId: undefined } })
    const svc = new InMemoryHuaqiuAuthService({ hqEdgeBaseUrl: 'http://hq' }, { fetchImpl })
    // A stale standalone session exists on disk (the reported bug scenario).
    mkdirSync(TMP, { recursive: true })
    writeFileSync(join(TMP, 'session.json'), JSON.stringify({ id: 'stale-u', token: 'stale-tok' }))
    // A browser push also exists in memory.
    svc.setCredentials({ id: 'pushed-u', token: 'pushed-tok' })
    // Host mode must treat the absent host credential as UNAUTHENTICATED —
    // never silently reuse a stale standalone/pushed token.
    expect(await svc.auth.getAccessToken()).toBeNull()
    expect(await svc.auth.getUserInfo()).toBeNull()
    expect(await svc.auth.isAuthenticated()).toBe(false)
    await expect(svc.auth.validate()).resolves.toEqual({ status: 'invalid', reason: 'invalid' })
  })

  it('does not write pushed credentials to the standalone store in host mode', async () => {
    const fetchImpl = authFetch({ hostPayload: { token: 'host-tok', userId: 'host-u' } })
    const svc = new InMemoryHuaqiuAuthService({ hqEdgeBaseUrl: 'http://hq' }, { fetchImpl })
    svc.setCredentials({ id: 'pushed-u', token: 'pushed-tok' })
    expect(existsSync(join(TMP, 'session.json'))).toBe(false)
  })

  it('falls back to standalone when host config is missing/invalid', async () => {
    const svc = new InMemoryHuaqiuAuthService({ hqEdgeBaseUrl: '' }, { fetchImpl: authFetch() })
    svc.setCredentials({ id: 'u', token: 'tok' })
    expect(await svc.auth.isAuthenticated()).toBe(true)
    expect(await svc.auth.getAccessToken()).toBe('tok')
  })

  it('invalid() clears the host cache so the next resolve re-fetches', async () => {
    const fetchImpl = fakeFetchOnce({ token: 'tok', userId: 'u' })
    const svc = new InMemoryHuaqiuAuthService(
      { hqEdgeBaseUrl: 'http://hq' },
      { fetchImpl },
    )
    await svc.auth.getAccessToken()
    svc.invalidate()
    await svc.auth.getAccessToken()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('InMemoryHuaqiuAuthService node-side persistence', () => {
  it('writes the session to disk on setCredentials', async () => {
    const svc = new InMemoryHuaqiuAuthService()
    svc.setCredentials({ id: 'u', token: 'tok', nickname: 'Al' })
    const file = join(TMP, 'session.json')
    expect(existsSync(file)).toBe(true)
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written).toEqual({ id: 'u', token: 'tok', nickname: 'Al' })
  })

  it('reads the persisted session as a fallback after a restart-like gap', async () => {
    // Simulate a prior session: a fresh service finds the file with no in-memory state.
    mkdirSync(TMP, { recursive: true })
    const file = join(TMP, 'session.json')
    writeFileSync(file, JSON.stringify({ id: 'restored', token: 'rtok' }))
    const svc = new InMemoryHuaqiuAuthService({}, { fetchImpl: authFetch() })
    expect(await svc.auth.isAuthenticated()).toBe(true)
    expect(await svc.auth.getAccessToken()).toBe('rtok')
    expect((await svc.auth.getUserInfo())?.id).toBe('restored')
  })

  it('clears the persisted file on invalidate()', async () => {
    const svc = new InMemoryHuaqiuAuthService()
    svc.setCredentials({ id: 'u', token: 'tok' })
    const file = join(TMP, 'session.json')
    expect(existsSync(file)).toBe(true)
    svc.invalidate()
    expect(existsSync(file)).toBe(false)
    expect(await svc.auth.getUserInfo()).toBeNull()
  })
})
