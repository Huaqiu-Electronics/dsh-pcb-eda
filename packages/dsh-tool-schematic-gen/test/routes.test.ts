import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROGRESS_ROUTE_PREFIX, createProgressHandler } from '../src/routes.js'
import { ProgressStore } from '../src/progress.js'
import { collectTraceEvents } from '../src/trace.js'

/** Minimal response recorder — enough for the handler's writeHead/end usage. */
function stubRes() {
  const out = {
    status: 0,
    headers: {} as Record<string, string>,
    raw: '',
    json: null as unknown,
  }
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status
      out.headers = headers
    },
    end(body?: string) {
      out.raw = body ?? ''
      out.json = out.raw ? JSON.parse(out.raw) : null
    },
  } as unknown as ServerResponse
  return { res, out }
}

function req(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage
}

function seededStore(): ProgressStore {
  const store = new ProgressStore({ now: () => 1000 })
  store.start('call-1', 'generate_schematic_from_description', 'schematic')
  store.updateState('call-1', { requirement: 'x' })
  store.pushTrace('call-1', collectTraceEvents({ kind: 'tool', phase: 'start', scope: 'root', name: 'search_parts', ts: 500 }))
  return store
}

describe('progress route', () => {
  it('serves one run doc for a known call id', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('GET', `${PROGRESS_ROUTE_PREFIX}/call-1`), res)
    expect(out.status).toBe(200)
    expect(out.json).toMatchObject({
      callId: 'call-1',
      kind: 'schematic',
      status: 'running',
      stage: { index: 1, total: 5, key: 'architecture' },
    })
    expect((out.json as { frames: unknown[] }).frames).toHaveLength(1)
  })

  it('404s an unknown call id', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('GET', `${PROGRESS_ROUTE_PREFIX}/nope`), res)
    expect(out.status).toBe(404)
  })

  it('percent-decodes the call id, because DSH ids can contain | and :', async () => {
    const store = new ProgressStore()
    store.start('call|1:2', 't', 'system')
    const handler = createProgressHandler(store)
    const { res, out } = stubRes()
    await handler(req('GET', `${PROGRESS_ROUTE_PREFIX}/call%7C1%3A2`), res)
    expect(out.status).toBe(200)
    expect((out.json as { callId: string }).callId).toBe('call|1:2')
  })

  it('404s a malformed percent-encoding instead of throwing', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('GET', `${PROGRESS_ROUTE_PREFIX}/%E0%A4%A`), res)
    expect(out.status).toBe(404)
  })

  it('lists every live run when no id is given', async () => {
    const store = seededStore()
    store.start('call-2', 'generate_system_module_graph', 'system')
    const handler = createProgressHandler(store)
    const { res, out } = stubRes()
    await handler(req('GET', PROGRESS_ROUTE_PREFIX), res)
    expect(out.status).toBe(200)
    const runs = (out.json as { runs: Array<{ callId: string }> }).runs
    expect(runs.map((r) => r.callId).sort()).toEqual(['call-1', 'call-2'])
  })

  it('ignores the query string', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('GET', `${PROGRESS_ROUTE_PREFIX}/call-1?ts=1&x=2`), res)
    expect(out.status).toBe(200)
  })

  it('rejects a deeper sub-path', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('GET', `${PROGRESS_ROUTE_PREFIX}/call-1/extra`), res)
    expect(out.status).toBe(404)
  })

  it('rejects non-GET methods', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('POST', `${PROGRESS_ROUTE_PREFIX}/call-1`), res)
    expect(out.status).toBe(405)
  })

  it('answers HEAD without a body', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('HEAD', `${PROGRESS_ROUTE_PREFIX}/call-1`), res)
    expect({ status: out.status, raw: out.raw, json: out.json }).toEqual({
      status: 200,
      raw: '',
      json: null,
    })
  })

  it('marks the response no-store so no proxy can serve a stale snapshot', async () => {
    const handler = createProgressHandler(seededStore())
    const { res, out } = stubRes()
    await handler(req('GET', `${PROGRESS_ROUTE_PREFIX}/call-1`), res)
    expect(out.headers['cache-control']).toBe('no-store')
    expect(out.headers['content-type']).toMatch(/application\/json/)
  })
})
