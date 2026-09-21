import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnalyticsEventQueue } from './tool-events.js'

export const ANALYTICS_ROUTE_PREFIX = '/api/v1/huaqiu/analytics'

export type AnalyticsHandler = (req: IncomingMessage, res: ServerResponse) => void

export function createAnalyticsHandler(queue: AnalyticsEventQueue): AnalyticsHandler {
  return (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')

    if (req.method === 'GET' && pathname === `${ANALYTICS_ROUTE_PREFIX}/events`) {
      res.statusCode = 200
      res.end(JSON.stringify({ events: queue.drain() }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not_found' }))
  }
}
