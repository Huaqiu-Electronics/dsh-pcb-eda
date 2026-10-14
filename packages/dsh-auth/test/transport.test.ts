// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createWebServerAuthTransport } from '../src/client/transport.js'

describe('createWebServerAuthTransport', () => {
  it('fetchHostMode returns true when the node config route reports host mode', async () => {
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hostMode: true }),
    })) as unknown as typeof fetch
    const t = createWebServerAuthTransport('/api/v1/huaqiu/auth', doFetch)
    expect(await t.fetchHostMode()).toBe(true)
    expect(doFetch).toHaveBeenCalledWith('/api/v1/huaqiu/auth/config', expect.objectContaining({ method: 'GET' }))
  })

  it('fetchHostMode returns false for standalone mode', async () => {
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hostMode: false }),
    })) as unknown as typeof fetch
    expect(await createWebServerAuthTransport('/api/v1/huaqiu/auth', doFetch).fetchHostMode()).toBe(false)
  })

  it('fetchHostMode falls back to false (standalone) when the route is unreachable', async () => {
    const doFetch = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await createWebServerAuthTransport('/api/v1/huaqiu/auth', doFetch).fetchHostMode()).toBe(false)
  })

  it('fetchSession parses an authenticated host session', async () => {
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        authenticated: true,
        user: { id: '6215935', token: 'host-tok', nickname: '老铁' },
      }),
    })) as unknown as typeof fetch
    const t = createWebServerAuthTransport('/api/v1/huaqiu/auth', doFetch)
    const session = await t.fetchSession()
    expect(session).toEqual({
      authenticated: true,
      user: { id: '6215935', token: 'host-tok', nickname: '老铁' },
    })
    expect(doFetch).toHaveBeenCalledWith('/api/v1/huaqiu/auth/session', expect.objectContaining({ method: 'GET' }))
  })

  it('fetchSession returns authenticated=false on a non-ok response', async () => {
    const doFetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    const t = createWebServerAuthTransport('/api/v1/huaqiu/auth', doFetch)
    await expect(t.fetchSession()).resolves.toEqual({ authenticated: false, user: null })
  })

  it('fetchSession tolerates a missing user object', async () => {
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ authenticated: true }),
    })) as unknown as typeof fetch
    const t = createWebServerAuthTransport('/api/v1/huaqiu/auth', doFetch)
    await expect(t.fetchSession()).resolves.toEqual({ authenticated: true, user: null })
  })

  it('fetchAiUsage reads the /ai-usage route (never the external endpoint)', async () => {
    const usage = {
      availablePoints: 198735,
      availableQuota: 9936735,
      availableUsd: 19.87347,
      usedPoints: 1265,
      usedQuota: 63265,
      usedUsd: 0.12653,
    }
    const doFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ usage }),
    })) as unknown as typeof fetch
    const t = createWebServerAuthTransport('/api/v1/huaqiu/auth', doFetch)
    await expect(t.fetchAiUsage()).resolves.toEqual(usage)
    // Same-origin node route — the plain-http fdatasheets URL must not appear
    // here (the WebView refuses it on ATS + CORS grounds).
    const [url] = (doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(url).toBe('/api/v1/huaqiu/auth/ai-usage')
    expect(url).not.toContain('fdatasheets')
    expect(doFetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET' }))
  })

  it('fetchAiUsage returns null on a non-ok response, a missing payload, or a network error', async () => {
    const notOk = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    await expect(createWebServerAuthTransport('/api/v1/huaqiu/auth', notOk).fetchAiUsage()).resolves.toBeNull()

    const empty = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch
    await expect(createWebServerAuthTransport('/api/v1/huaqiu/auth', empty).fetchAiUsage()).resolves.toBeNull()

    const offline = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(createWebServerAuthTransport('/api/v1/huaqiu/auth', offline).fetchAiUsage()).resolves.toBeNull()
  })
})
