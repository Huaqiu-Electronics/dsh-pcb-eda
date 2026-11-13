/**
 * Tests for the plugin-update forwarding routes (`src/routes.ts`).
 *
 * A tiny in-process hq-edge stub (node:http) plays the upstream; the
 * forwarder must map every browser route to the right method + path, pass the
 * JSON body through, surface upstream status codes, and fail closed when the
 * upstream is unreachable or missing.
 */
import { createServer, type Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createUpdateForwarder,
  UPDATE_ROUTE_PREFIX,
} from '../src/routes.js'

let upstream: Server
let baseUrl = ''
const seen: Array<{ method: string; url: string; body: string }> = []

/** hq-edge stub: echoes the request as JSON (status 200) unless the path
 *  starts with /fail (→ 500), the body carries `"busy":true` (→ 409), or the
 *  unknown job id `unknown-job` is requested (→ 404 `unknown job`). */
function startUpstream(): Promise<string> {
  return new Promise((resolve) => {
    upstream = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => body += chunk)
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body })
        const path = req.url ?? ''
        if (path === '/api/v1/plugin-updates/status/unknown-job') {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown job' }))
          return
        }
        if (path.startsWith('/fail')) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'boom' }))
          return
        }
        if (body.includes('"busy":true')) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'busy' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ echoed: true, method: req.method, url: req.url }))
      })
    })
    upstream.listen(0, '127.0.0.1', () => {
      const addr = upstream.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve(baseUrl)
    })
  })
}

/** Drive the forwarder with a real http client against the DSH-side server. */
function driveRequest(
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: dshPort, method, path: url },
      (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(data)
          } catch {
            json = { raw: data }
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

let dshServer: Server
let dshPort = 0

function startDshSide(forwarder: ReturnType<typeof createUpdateForwarder>): Promise<void> {
  return new Promise((resolve) => {
    dshServer = createServer((req, res) => {
      void forwarder(req, res)
    })
    dshServer.listen(0, '127.0.0.1', () => {
      dshPort = (dshServer.address() as AddressInfo).port
      resolve()
    })
  })
}

beforeEach(async () => {
  seen.length = 0
  await startUpstream()
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (dshServer !== undefined) dshServer.close(() => resolve())
    else resolve()
  })
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve())
  })
})

describe('plugin-update forwarding routes', () => {
  it('forwards GET report → GET /api/v1/plugin-updates', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/report`)
    expect(status).toBe(200)
    expect(json).toMatchObject({ echoed: true, method: 'GET', url: '/api/v1/plugin-updates' })
  })

  it('forwards POST install with the body and maps status codes', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'POST',
      `${UPDATE_ROUTE_PREFIX}/install`,
      JSON.stringify({ setVersion: '0.5.21' }),
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({ echoed: true, method: 'POST', url: '/api/v1/plugin-updates/install' })
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/plugin-updates/install',
      body: JSON.stringify({ setVersion: '0.5.21' }),
    })
  })

  it('maps upstream 409 (busy) through to the browser', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'POST',
      `${UPDATE_ROUTE_PREFIX}/install`,
      JSON.stringify({ setVersion: '0.5.21', busy: true }),
    )
    expect(status).toBe(409)
    expect(json).toMatchObject({ error: 'busy' })
  })

  it('returns 503 when no base URL is resolvable', async () => {
    const forwarder = createUpdateForwarder(() => undefined)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/report`)
    expect(status).toBe(503)
    expect(json).toMatchObject({ error: expect.stringContaining('no base URL') as unknown })
  })

  it('returns 404 for unknown sub-paths and 405 for bad methods', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const unknown = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/nope`)
    expect(unknown.status).toBe(404)
    const bad = await driveRequest('DELETE', `${UPDATE_ROUTE_PREFIX}/report`)
    expect(bad.status).toBe(405)
  })

  /**
   * `/activity` is the re-attach read: it must reach hq-edge AND carry the
   * caller's `?job=`, which is the only thing that identifies the job after the
   * server that started it was replaced. No other route passes a query through.
   */
  it('forwards GET activity → GET /api/v1/plugin-updates/activity with ?job=', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'GET',
      `${UPDATE_ROUTE_PREFIX}/activity?job=uj_1793255677245_2fi1x0dltt`,
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'GET',
      url: '/api/v1/plugin-updates/activity?job=uj_1793255677245_2fi1x0dltt',
    })
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: '/api/v1/plugin-updates/activity?job=uj_1793255677245_2fi1x0dltt',
    })
  })

  it('forwards GET activity without a query, and rejects a write on it', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const bare = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/activity`)
    expect(bare.status).toBe(200)
    expect(seen[0]).toMatchObject({ url: '/api/v1/plugin-updates/activity' })

    const post = await driveRequest('POST', `${UPDATE_ROUTE_PREFIX}/activity`, '{}')
    expect(post.status).toBe(405)
  })

  it('forwards POST runtime-request → POST /api/v1/runtime-update/request', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'POST',
      `${UPDATE_ROUTE_PREFIX}/runtime-request`,
      JSON.stringify({ targetVersion: '0.2.12' }),
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'POST',
      url: '/api/v1/runtime-update/request',
    })
    // The target version must reach hq-edge verbatim — it is the whole request.
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/runtime-update/request',
      body: JSON.stringify({ targetVersion: '0.2.12' }),
    })
  })

  it('forwards GET runtime-source → GET /api/v1/runtime-update/source', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/runtime-source`)
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'GET',
      url: '/api/v1/runtime-update/source',
    })
  })

  it('forwards POST runtime-source with the URL body verbatim', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'POST',
      `${UPDATE_ROUTE_PREFIX}/runtime-source`,
      JSON.stringify({ url: 'https://staging.example.invalid/manifest.json' }),
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'POST',
      url: '/api/v1/runtime-update/source',
    })
    // The URL must reach hq-edge verbatim — it is the whole request.
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/runtime-update/source',
      body: JSON.stringify({ url: 'https://staging.example.invalid/manifest.json' }),
    })
  })

  it('answers 405 for a method /runtime-source does not serve', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    // The sub-path carries a read AND a write; anything else is a client
    // error caught locally, never forwarded to a 404 upstream.
    const bad = await driveRequest('PUT', `${UPDATE_ROUTE_PREFIX}/runtime-source`)
    expect(bad.status).toBe(405)
    expect(seen).toHaveLength(0)
  })

  it('forwards GET plugin-source → GET /api/v1/plugin-updates/source', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/plugin-source`)
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'GET',
      url: '/api/v1/plugin-updates/source',
    })
  })

  it('forwards POST plugin-source with the URL body verbatim', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'POST',
      `${UPDATE_ROUTE_PREFIX}/plugin-source`,
      JSON.stringify({ url: 'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json' }),
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'POST',
      url: '/api/v1/plugin-updates/source',
    })
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/plugin-updates/source',
      body: JSON.stringify({ url: 'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json' }),
    })
  })

  it('answers 405 for a method /plugin-source does not serve', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const bad = await driveRequest('PUT', `${UPDATE_ROUTE_PREFIX}/plugin-source`)
    expect(bad.status).toBe(405)
    expect(seen).toHaveLength(0)
  })

  it('routes /check /ignore /unignore /runtime to the right upstream paths', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    await driveRequest('POST', `${UPDATE_ROUTE_PREFIX}/check`)
    await driveRequest('POST', `${UPDATE_ROUTE_PREFIX}/ignore`, '{"setVersion":"0.5.21"}')
    await driveRequest('POST', `${UPDATE_ROUTE_PREFIX}/unignore`, '{"setVersion":"0.5.21"}')
    await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/runtime`)
    expect(seen.map((s) => s.url)).toEqual([
      '/api/v1/plugin-updates/check',
      '/api/v1/plugin-updates/ignore',
      '/api/v1/plugin-updates/unignore',
      '/api/v1/runtime-update',
    ])
  })

  it('forwards the per-plugin ignore routes the card action calls', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    // The browser half calls `/plugin-ignore` / `/plugin-unignore`; the
    // forwarder used to answer 404 for both, and the caller swallowed it, so
    // 忽略 on a card wrote nothing and the sidebar count never moved.
    const ignored = await driveRequest(
      'POST',
      `${UPDATE_ROUTE_PREFIX}/plugin-ignore`,
      '{"setVersion":"0.6.10","name":"@huaqiu/dsh-analytics"}',
    )
    const restored = await driveRequest(
      'POST',
      `${UPDATE_ROUTE_PREFIX}/plugin-unignore`,
      '{"setVersion":"0.6.10","name":"@huaqiu/dsh-analytics"}',
    )
    expect(ignored.status).toBe(200)
    expect(restored.status).toBe(200)
    expect(seen.map((s) => s.url)).toEqual([
      '/api/v1/plugin-updates/plugin-ignore',
      '/api/v1/plugin-updates/plugin-unignore',
    ])
    expect(seen[0]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ setVersion: '0.6.10', name: '@huaqiu/dsh-analytics' }),
    })
  })

  it('answers 405 (not 404) for GET /plugin-ignore — a known POST-only route', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const bad = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/plugin-ignore`)
    expect(bad.status).toBe(405)
    expect(seen).toHaveLength(0)
  })

  it('returns 502 when the upstream is unreachable', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    const forwarder = createUpdateForwarder(() => 'http://127.0.0.1:1', 500)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/report`)
    expect(status).toBe(502)
    expect(json).toMatchObject({ error: expect.stringContaining('failed') as unknown })
  })

  it('forwards GET /status → GET /api/v1/plugin-updates/status', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/status`)
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'GET',
      url: '/api/v1/plugin-updates/status',
    })
  })

  it('forwards GET /status/<id> with the id passed through verbatim', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'GET',
      `${UPDATE_ROUTE_PREFIX}/status/job-8f3a`,
    )
    expect(status).toBe(200)
    expect(json).toMatchObject({
      echoed: true,
      method: 'GET',
      url: '/api/v1/plugin-updates/status/job-8f3a',
    })
  })

  it('passes an upstream 404 unknown-job through verbatim (not a plugin 500)', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const { status, json } = await driveRequest(
      'GET',
      `${UPDATE_ROUTE_PREFIX}/status/unknown-job`,
    )
    expect(status).toBe(404)
    expect(json).toMatchObject({ error: 'unknown job' })
  })

  it('answers 405 (not 404) for POST /status — a known route under a bad method', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    const bad = await driveRequest('POST', `${UPDATE_ROUTE_PREFIX}/status`)
    expect(bad.status).toBe(405)
    expect(seen).toHaveLength(0)
  })

  it('does not treat /status nested paths as job ids', async () => {
    const forwarder = createUpdateForwarder(() => baseUrl)
    await startDshSide(forwarder)
    // A nested segment is an unknown sub-path → 404, never a forwarded GET.
    const { status } = await driveRequest('GET', `${UPDATE_ROUTE_PREFIX}/status/a/b`)
    expect(status).toBe(404)
  })
})
