import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { AnalyticsEventQueue } from '../src/tool-events.js'
import { ANALYTICS_ROUTE_PREFIX, createAnalyticsHandler } from '../src/routes.js'

describe('analytics browser transport', () => {
  let server: http.Server
  let base: string
  let queue: AnalyticsEventQueue

  beforeEach(async () => {
    queue = new AnalyticsEventQueue()
    server = http.createServer(createAnalyticsHandler(queue))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('drains queued node events for the browser SDK exactly once', async () => {
    queue.push({ event: 'tool_call', properties: { tool_name: 'bash' } })

    const first = await fetch(`${base}${ANALYTICS_ROUTE_PREFIX}/events`)
    const second = await fetch(`${base}${ANALYTICS_ROUTE_PREFIX}/events`)

    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      events: [{ event: 'tool_call', properties: { tool_name: 'bash' } }],
    })
    expect(await second.json()).toEqual({ events: [] })
  })

  it('does not expose unrelated routes', async () => {
    expect((await fetch(`${base}${ANALYTICS_ROUTE_PREFIX}/unknown`)).status).toBe(404)
  })
})
