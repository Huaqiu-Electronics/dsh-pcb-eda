/**
 * HTTP adapter: receives the browser-pushed credentials and serves the node
 * auth state (probe / boot restore). Same-origin through `ctx.webServer`:
 *
 *   POST /api/v1/huaqiu/auth/session   body { token, userId, nickname?, expiresAt? } → cache set
 *   POST /api/v1/huaqiu/auth/logout                                → cache cleared
 *   GET  /api/v1/huaqiu/auth/session   → { authenticated, user }
 *   GET  /api/v1/huaqiu/auth/config    → { hostMode }
 *
 * `config` tells the browser half whether it is running under an HQ Edge host
 * (hq-edge passes the operator credential to hq-edge itself, so the sidebar
 * login entrypoint is suppressed). These routes are the browser→node transport
 * for Phase 0A (start-p0.md §4: smallest supported extension point —
 * `apiProxy`'s dispatch table is closed, so a plugin-owned `webServer` route is
 * the documented channel).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HuaqiuAuthService, HuaqiuUserInfo } from './service.js'

export const AUTH_ROUTE_PREFIX = '/api/v1/huaqiu/auth'

export type AuthHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function normalizeUserInfo(data: Record<string, unknown>): HuaqiuUserInfo | null {
  const token = typeof data.token === 'string' && data.token.length > 0 ? data.token : null
  const id = typeof data.userId === 'string' && data.userId.length > 0
    ? data.userId
    : typeof data.userId === 'number' && Number.isFinite(data.userId) ? String(data.userId)
    : typeof data.id === 'string' && data.id.length > 0 ? data.id
    : typeof data.id === 'number' && Number.isFinite(data.id) ? String(data.id)
    : null
  if (!token || !id) return null
  const nickname = typeof data.nickname === 'string' && data.nickname.length > 0 ? data.nickname : undefined
  const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)
    ? data.expiresAt
    : undefined
  return {
    id,
    token,
    ...(nickname ? { nickname } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

export function createAuthHandler(service: HuaqiuAuthService): AuthHandler {
  return async (req, res) => {
    try {
      const url = req.url ?? ''
      const q = url.indexOf('?')
      const pathname = (q >= 0 ? url.slice(0, q) : url).replace(/\/+$/, '')

      if (req.method === 'POST' && pathname === `${AUTH_ROUTE_PREFIX}/session`) {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
        } catch {
          sendJson(res, 400, { error: 'invalid json body' })
          return
        }
        const info = normalizeUserInfo(body)
        if (!info) {
          sendJson(res, 400, { error: 'token and userId are required' })
          return
        }
        service.setCredentials(info)
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && pathname === `${AUTH_ROUTE_PREFIX}/logout`) {
        service.invalidate()
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && pathname === `${AUTH_ROUTE_PREFIX}/session`) {
        const user = await service.auth.getUserInfo()
        const authenticated = await service.auth.isAuthenticated()
        sendJson(res, 200, { authenticated, user })
        return
      }

      if (req.method === 'GET' && pathname === `${AUTH_ROUTE_PREFIX}/config`) {
        sendJson(res, 200, { hostMode: service.hostMode })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      sendJson(res, 500, { error: 'internal error', detail: String(err) })
    }
  }
}
