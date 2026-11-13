import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { InMemoryHuaqiuAuthService } from '../src/service.js'
import { AUTH_ROUTE_PREFIX, createAuthHandler, fetchAiUsage } from '../src/routes.js'
import { authFetch } from './helpers.js'

// Test-environment values the way HQ Edge resolves them from HQ_AI_ENV=test.
const TEST_BALANCES_URL = 'http://www.fdatasheets.com/sub-api/subscriptions/balances/current'
const TEST_PROFILE_URL = 'http://www.fdatasheets.com/account'
const TEST_SUBSCRIPTION_ORIGIN = 'http://gen.fdatasheets.com'

// Isolate the persisted-session directory to a temp dir so the standalone
// (browser-login) tests never read a real `~/.dsh/auth/session.json` left by
// another run — `isAuthenticated()` consults that file as a fallback.
const TMP = join(tmpdir(), `dsh-auth-routes-test-${process.pid}`)
vi.mock('@deepseek-ai/dsh-home-paths', () => ({ dshHomePath: () => TMP }))

describe('auth webServer routes (browser→node transport)', () => {
  let server: http.Server
  let base: string
  let svc: InMemoryHuaqiuAuthService

  beforeEach(async () => {
    rmSync(TMP, { recursive: true, force: true })
    svc = new InMemoryHuaqiuAuthService(
      {
        subscriptionBalancesUrl: TEST_BALANCES_URL,
        subscriptionOrigin: TEST_SUBSCRIPTION_ORIGIN,
        profileUrl: TEST_PROFILE_URL,
      },
      { fetchImpl: authFetch() },
    )
    server = http.createServer(createAuthHandler(svc))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(TMP, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  async function post(p: string, body?: unknown): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        base + p,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      req.on('error', reject)
      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })
  }

  async function get(p: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.get(base + p, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
    })
  }

  it('accepts a session push and exposes it to the node auth capability (group A)', async () => {
    const res = await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 'tok-9', userId: 'u9', nickname: 'Nine' })
    expect(res.status).toBe(200)
    expect(await svc.auth.isAuthenticated()).toBe(true)
    expect(await svc.auth.getAccessToken()).toBe('tok-9')
    expect(await svc.auth.getUserInfo()).toEqual({ id: 'u9', token: 'tok-9', nickname: 'Nine' })
  })

  it('accepts expiresAt in a session push and uses it for local expiry', async () => {
    const past = 1
    await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 'tok-e', userId: 'ue', expiresAt: past })
    expect(await svc.auth.isAuthenticated()).toBe(false)
    expect(await svc.auth.getAccessToken()).toBe('tok-e') // credential kept for recovery
  })

  it('GET /session reports the current node auth state', async () => {
    const before = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/session`)).text)
    expect(before.authenticated).toBe(false)
    await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 't', userId: 'u' })
    const after = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/session`)).text)
    expect(after.authenticated).toBe(true)
    expect(after.user.token).toBe('t')
  })

  it('logout invalidates the node cache (group C)', async () => {
    await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 't', userId: 'u' })
    const res = await post(`${AUTH_ROUTE_PREFIX}/logout`)
    expect(res.status).toBe(200)
    expect(await svc.auth.isAuthenticated()).toBe(false)
    expect(await svc.auth.getAccessToken()).toBeNull()
  })

  it('rejects a session push without a token or userId', async () => {
    expect((await post(`${AUTH_ROUTE_PREFIX}/session`, { token: '' })).status).toBe(400)
    expect((await post(`${AUTH_ROUTE_PREFIX}/session`, { userId: 'u' })).status).toBe(400)
    expect(await svc.auth.isAuthenticated()).toBe(false)
  })

  it('404s unknown paths', async () => {
    expect((await get(`${AUTH_ROUTE_PREFIX}/nope`)).status).toBe(404)
    expect((await post(`${AUTH_ROUTE_PREFIX}/nope`, {})).status).toBe(404)
  })

  it('GET /config reports standalone mode (hostMode=false) and no AI origin', async () => {
    // Only HQ Edge supplies the resolved endpoints; standalone (no overlay
    // config, no env) reports no origin and no quota API base.
    const standaloneSvc = new InMemoryHuaqiuAuthService({})
    expect(standaloneSvc.hostMode).toBe(false)
    expect(standaloneSvc.subscriptionOrigin).toBeNull()
    expect(standaloneSvc.subscriptionApiBaseUrl).toBeNull()
    expect(standaloneSvc.profileUrl).toBeNull()
  })

  it('GET /config exposes the subscription origin resolved from the same AI env', async () => {
    const res = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/config`)).text)
    expect(res.subscriptionOrigin).toBe(TEST_SUBSCRIPTION_ORIGIN)
    // The GEN/ERC quota calls take the balances endpoint's origin, so they
    // follow the same HQ_AI_ENV resolution and no host is hardcoded.
    expect(res.subscriptionApiBaseUrl).toBe('http://www.fdatasheets.com')
    // The profile URL keeps its own path (/account vs /account/profile), which
    // is why the full URL — not an origin — crosses the route.
    expect(res.profileUrl).toBe(TEST_PROFILE_URL)
  })

  it('GET /config reports host mode when an HQ Edge base URL is configured', async () => {
    // A host-mode service (overlay `config.hqEdgeBaseUrl` set) must expose
    // hostMode=true so the browser half suppresses its own login entrypoint.
    const hostSvc = new InMemoryHuaqiuAuthService({ hqEdgeBaseUrl: 'http://localhost:9999' })
    const hostServer = http.createServer(createAuthHandler(hostSvc))
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve))
    try {
      const port = (hostServer.address() as AddressInfo).port
      const res = JSON.parse(
        await new Promise<string>((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}${AUTH_ROUTE_PREFIX}/config`, (r) => {
            const chunks: Buffer[] = []
            r.on('data', (c) => chunks.push(c))
            r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          }).on('error', reject)
        }),
      )
      expect(res.hostMode).toBe(true)
    } finally {
      await new Promise<void>((resolve) => hostServer.close(() => resolve()))
    }
  })

  it('GET /user-info returns null when no credential is resolved', async () => {
    const res = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/user-info`)).text)
    expect(res).toEqual({ userInfo: null })
  })

  it('GET /user-info fetches the rich eda.cn profile (nickname + headimage)', async () => {
    await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 'tok-9', userId: 'u9' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/chiplet/u/base/get')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 200000, result: { id: 9, nickname: '老铁', headimage: 'https://file.eda.cn/avatar.png' } }),
        } as Response
      }
      throw new Error('unexpected fetch: ' + url)
    }))
    const res = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/user-info`)).text)
    expect(res.userInfo).toMatchObject({ nickname: '老铁', headimage: 'https://file.eda.cn/avatar.png' })
  })

  it('GET /user-info degrades to null when eda.cn rejects the token', async () => {
    await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 'tok-bad', userId: 'u9' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/chiplet/u/base/get')) {
        return { ok: true, status: 200, json: async () => ({ code: 400001 }) } as Response
      }
      throw new Error('unexpected fetch: ' + url)
    }))
    const res = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/user-info`)).text)
    expect(res).toEqual({ userInfo: null })
  })

  // ── AI usage (plain-http upstream, so the node half must be the caller) ────

  /** `result[]` verbatim from the documented curl for the new endpoint. */
  const AI_BALANCES_RESULT = [
    {
      id: 574,
      userId: 6388241,
      subscriptionId: 278,
      quotaGroupId: 28,
      groupCode: 'internal',
      groupName: 'erc内部组',
      periodStart: 1793326077000,
      periodEnd: 1796004477000,
      quotaTotal: 999,
      quotaUsed: 0,
      quotaRemain: 999,
      quotaRemainPercent: null,
      aiPoints: false,
      status: 1,
    },
    {
      id: 575,
      userId: 6388241,
      subscriptionId: 278,
      quotaGroupId: 32,
      groupCode: 'internal-auto-design',
      groupName: 'sch内部组',
      quotaTotal: 999,
      quotaUsed: 0,
      quotaRemain: 999,
      quotaRemainPercent: null,
      aiPoints: false,
      status: 1,
    },
    {
      id: 576,
      userId: 6388241,
      subscriptionId: 278,
      quotaGroupId: 36,
      groupCode: 'internal-ai-points',
      groupName: 'AI点数内部组',
      quotaTotal: null,
      quotaUsed: null,
      quotaRemain: null,
      quotaRemainPercent: 99.68,
      aiPoints: true,
      status: 1,
    },
  ]

  it('GET /ai-usage returns null when no credential is resolved', async () => {
    const res = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/ai-usage`)).text)
    expect(res).toEqual({ usage: null })
  })

  it('GET /ai-usage selects the AI Points group and authenticates with X-Token', async () => {
    await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 'tok-9', userId: 'u9' })
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init])
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200000, message: 'success', result: AI_BALANCES_RESULT }),
      } as Response
    }))

    const res = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/ai-usage`)).text)
    // Only the AI group's remaining percentage reaches the browser — the
    // non-AI groups and their null percentages are ignored.
    expect(res.usage).toEqual({ quotaRemainPercent: 99.68 })
    // Exactly one upstream call, made by the node half — the endpoint is plain
    // http, so the browser must never be the caller (ATS + CORS reject it).
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(TEST_BALANCES_URL)
    expect((calls[0]![1]!.headers as Record<string, string>)['X-Token']).toBe('tok-9')
  })

  it('GET /ai-usage degrades to null on a bad envelope or a rejected token', async () => {
    await post(`${AUTH_ROUTE_PREFIX}/session`, { token: 'tok-bad', userId: 'u9' })
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: true, status: 200, json: async () => ({ code: 400001, message: 'invalid token' }) } as Response
    )))
    expect(JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/ai-usage`)).text)).toEqual({ usage: null })

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 } as Response)))
    expect(JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/ai-usage`)).text)).toEqual({ usage: null })

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/ai-usage`)).text)).toEqual({ usage: null })
  })

  it('fetchAiUsage passes the resolved URL and X-Token and returns quotaRemainPercent', async () => {
    const doFetch = vi.fn(async () => (
      { ok: true, status: 200, json: async () => ({ code: 200000, result: AI_BALANCES_RESULT }) } as Response
    )) as unknown as typeof fetch
    const usage = await fetchAiUsage('tok-1', TEST_BALANCES_URL, doFetch)
    expect(usage).toEqual({ quotaRemainPercent: 99.68 })
    const [url, init] = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(TEST_BALANCES_URL)
    expect((init.headers as Record<string, string>)['X-Token']).toBe('tok-1')
  })

  it('fetchAiUsage returns null when no group is flagged aiPoints', async () => {
    const doFetch = vi.fn(async () => (
      { ok: true, status: 200, json: async () => ({ code: 200000, result: AI_BALANCES_RESULT.slice(0, 2) }) } as Response
    )) as unknown as typeof fetch
    await expect(fetchAiUsage('t', TEST_BALANCES_URL, doFetch)).resolves.toBeNull()
  })

  it('fetchAiUsage returns null when the AI group has no quotaRemainPercent', async () => {
    const payload = AI_BALANCES_RESULT.map((group) => (
      group.aiPoints ? { ...group, quotaRemainPercent: null } : group
    ))
    const doFetch = vi.fn(async () => (
      { ok: true, status: 200, json: async () => ({ code: 200000, result: payload }) } as Response
    )) as unknown as typeof fetch
    await expect(fetchAiUsage('t', TEST_BALANCES_URL, doFetch)).resolves.toBeNull()
  })

  it('fetchAiUsage returns null for an object result or a malformed group', async () => {
    for (const payload of [
      { code: 200000, result: { availablePoints: 198735 } },
      { code: 200000, result: [{ ...AI_BALANCES_RESULT[2], aiPoints: 'yes' }] },
      { code: 200000, result: 'nope' },
    ]) {
      const doFetch = vi.fn(async () => (
        { ok: true, status: 200, json: async () => payload } as Response
      )) as unknown as typeof fetch
      await expect(fetchAiUsage('t', TEST_BALANCES_URL, doFetch)).resolves.toBeNull()
    }
  })

  it('fetchAiUsage aborts on the timeout budget and returns null', async () => {
    const doFetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    await expect(
      fetchAiUsage('t', TEST_BALANCES_URL, doFetch, { timeoutMs: 5 }),
    ).resolves.toBeNull()
  })
})
