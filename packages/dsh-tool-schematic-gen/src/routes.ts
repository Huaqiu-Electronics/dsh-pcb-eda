/**
 * HTTP adapter for live run progress (browser half of the progress flow).
 *
 * Browser → same-origin DSH webServer → `ctx.webServer` prefix route
 * `/api/v1/huaqiu/schematic-gen/progress`. Follows the `@huaqiu/dsh-artifacts`
 * precedent exactly (one prefix route, sub-paths parsed in the handler) because
 * the DSH `WebRoute` supports exact or prefix matches only — there are no `:id`
 * path params, and two prefix routes on the same base path would collide.
 *
 *   GET /api/v1/huaqiu/schematic-gen/progress          → every live run
 *   GET /api/v1/huaqiu/schematic-gen/progress/<callId> → one run's progress doc
 *
 * The `<callId>` is percent-decoded, because DSH tool call ids can contain
 * characters (`|`, `:`) that a client may encode.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProgressStore } from './progress.js'

export const PROGRESS_ROUTE_PREFIX = '/api/v1/huaqiu/schematic-gen/progress'

export type ProgressHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void

function sendJson(res: ServerResponse, status: number, body: unknown, omitBody = false): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Progress is live — never let a proxy serve a stale snapshot.
    'cache-control': 'no-store',
  })
  res.end(omitBody ? undefined : payload)
}

/** Split the sub-path off the prefix. Returns `null` on a bad shape. */
function parsePath(req: IncomingMessage): { callId: string | null } | null {
  const url = req.url ?? ''
  const q = url.indexOf('?')
  const pathname = q >= 0 ? url.slice(0, q) : url
  if (!pathname.startsWith(PROGRESS_ROUTE_PREFIX)) return null
  const rest = pathname.slice(PROGRESS_ROUTE_PREFIX.length)
  if (rest === '') return { callId: null }
  if (!rest.startsWith('/')) return null
  const segs = rest.split('/').filter(Boolean)
  if (segs.length !== 1) return null
  let callId: string
  try {
    callId = decodeURIComponent(segs[0]!)
  } catch {
    return null // malformed percent-encoding
  }
  return { callId: callId.length > 0 ? callId : null }
}

export function createProgressHandler(store: ProgressStore): ProgressHandler {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const omitBody = req.method === 'HEAD'
    const parsed = parsePath(req)
    if (!parsed) {
      sendJson(res, 404, { error: 'not found' }, omitBody)
      return
    }
    if (parsed.callId === null) {
      // No id: hand back every live run so a client without a callId (e.g. a
      // card mounted on replay) can still find its run.
      sendJson(res, 200, { runs: store.list() }, omitBody)
      return
    }
    const doc = store.get(parsed.callId)
    if (!doc) {
      sendJson(res, 404, { error: 'no live run for this call id' }, omitBody)
      return
    }
    sendJson(res, 200, doc, omitBody)
  }
}
