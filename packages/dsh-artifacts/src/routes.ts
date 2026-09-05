/**
 * HTTP adapter for `@huaqiu/dsh-artifacts` (browser half of the preview flow).
 *
 * Browser → same-origin DSH webServer → `ctx.webServer` prefix route
 * `/api/v1/huaqiu/artifacts` (the `edge-bridge` `/hq-edge` precedent, but
 * plugin-owned). Parameterized sub-paths are parsed in the handler:
 *
 *   GET /api/v1/huaqiu/artifacts/<id>          → metadata JSON
 *   GET /api/v1/huaqiu/artifacts/<id>/content  → raw bytes
 *
 * A single prefix route is used because the DSH `WebRoute` supports exact or
 * prefix matches only (no `:id` path params), and two prefix routes on the
 * same base path would collide.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HuaqiuArtifacts } from './service.js'

export const ARTIFACTS_ROUTE_PREFIX = '/api/v1/huaqiu/artifacts'

export type ArtifactsHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Parse `<id>` or `<id>/content` off the route prefix. Returns null on bad shape. */
function parsePath(req: IncomingMessage): { id: string; content: boolean } | null {
  const url = req.url ?? ''
  const q = url.indexOf('?')
  const pathname = q >= 0 ? url.slice(0, q) : url
  if (pathname !== ARTIFACTS_ROUTE_PREFIX && !pathname.startsWith(`${ARTIFACTS_ROUTE_PREFIX}/`)) {
    return null
  }
  const rest = pathname.slice(ARTIFACTS_ROUTE_PREFIX.length)
  // rest === '' or startsWith('/')
  if (rest === '') return null
  const segs = rest.split('/').filter(Boolean)
  if (segs.length === 1) return { id: segs[0]!, content: false }
  if (segs.length === 2 && segs[1] === 'content') return { id: segs[0]!, content: true }
  return null
}

export function createArtifactsHandler(service: HuaqiuArtifacts): ArtifactsHandler {
  return async (req, res) => {
    try {
      const parsed = parsePath(req)
      if (!parsed) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const { id, content } = parsed

      if (content) {
        const meta = await service.get(id)
        if (!meta) {
          sendJson(res, 404, { error: 'artifact not found or expired' })
          return
        }
        const bytes = await service.readContent(id)
        if (!bytes) {
          sendJson(res, 404, { error: 'artifact content missing' })
          return
        }
        const safeFilename = encodeURIComponent(meta.filename)
        res.writeHead(200, {
          'content-type': meta.mimeType || 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'content-disposition': `inline; filename*=UTF-8''${safeFilename}`,
          'cache-control': 'no-store',
        })
        res.end(Buffer.from(bytes))
        return
      }

      const meta = await service.get(id)
      if (!meta) {
        sendJson(res, 404, { error: 'artifact not found or expired' })
        return
      }
      sendJson(res, 200, {
        id: meta.id,
        type: meta.type,
        filename: meta.filename,
        mimeType: meta.mimeType,
        size: meta.size,
        createdAt: meta.createdAt,
      })
    } catch (err) {
      sendJson(res, 500, { error: 'internal error resolving artifact', detail: String(err) })
    }
  }
}
