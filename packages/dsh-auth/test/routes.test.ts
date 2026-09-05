import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { InMemoryHuaqiuAuthService } from '../src/service.js'
import { AUTH_ROUTE_PREFIX, createAuthHandler } from '../src/routes.js'
import { authFetch } from './helpers.js'

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
    svc = new InMemoryHuaqiuAuthService({}, { fetchImpl: authFetch() })
    server = http.createServer(createAuthHandler(svc))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(TMP, { recursive: true, force: true })
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
      if (body !== undefined) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body))
      }
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

  it('rejects malformed session JSON as a client error', async () => {
    const res = await post(`${AUTH_ROUTE_PREFIX}/session`, '{"token":')
    expect({ status: res.status, body: JSON.parse(res.text) }).toEqual({
      status: 400,
      body: { error: 'invalid json body' },
    })
    expect(svc.auth.isAuthenticated()).toBe(false)
  })

  it('404s unknown paths', async () => {
    expect((await get(`${AUTH_ROUTE_PREFIX}/nope`)).status).toBe(404)
    expect((await post(`${AUTH_ROUTE_PREFIX}/nope`, {})).status).toBe(404)
  })

  it('GET /config reports standalone mode (hostMode=false)', async () => {
    const res = JSON.parse((await get(`${AUTH_ROUTE_PREFIX}/config`)).text)
    expect(res.hostMode).toBe(false)
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
})
