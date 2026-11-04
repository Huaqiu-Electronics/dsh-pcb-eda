/**
 * HTTP adapter: receives the browser-pushed credentials and serves the node
 * auth state (probe / boot restore). Same-origin through `ctx.webServer`:
 *
 *   POST /api/v1/huaqiu/auth/session   body { token, userId, nickname?, expiresAt? } → cache set
 *   POST /api/v1/huaqiu/auth/logout                                → cache cleared
 *   GET  /api/v1/huaqiu/auth/session   → { authenticated, user }
 *   GET  /api/v1/huaqiu/auth/config    → { hostMode, subscriptionOrigin, subscriptionApiBaseUrl }
 *   GET  /api/v1/huaqiu/auth/user-info → { userInfo } (node-side eda.cn call)
 *   GET  /api/v1/huaqiu/auth/ai-usage  → { usage }    (node-side subscription-balances call)
 *
 * `config` tells the browser half whether it is running under an HQ Edge host
 * (hq-edge passes the operator credential to hq-edge itself, so the sidebar
 * login entrypoint is suppressed). These routes are the browser→node transport
 * for Phase 0A (start-p0.md §4: smallest supported extension point —
 * `apiProxy`'s dispatch table is closed, so a plugin-owned `webServer` route is
 * the documented channel).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getLogger, type PluginLogger } from '@huaqiu/dsh-plugin-log'
import type { HuaqiuAuthService, HuaqiuUserInfo } from './service.js'
import { aiUsageFromPayload, type AiUsage } from './subscription-balances.js'

// Lazy so test suites that `vi.mock('@deepseek-ai/dsh-home-paths', …)` before
// their TMP constant is initialised don't trigger `dshHomePath('logs')` at
// module-load time.
let _log: PluginLogger | null = null
function log(): PluginLogger {
  if (_log === null) _log = getLogger('dsh-auth')
  return _log
}

/**
 * eda.cn user-profile endpoint, reached with the access token as `X-token`
 * (the same endpoint hq-eda-ai's `/api/middleware/getUserInfo` proxies).
 * Returns `{ code: 200000, result: { id, nickname, headimage, phone, username } }`.
 */
export const EDA_USER_INFO_URL = 'https://www.eda.cn/api/chiplet/u/base/get'

export interface EdaUserProfile {
  nickname?: string
  headimage?: string
  phone?: string
  username?: string
}

/** Fetch the eda.cn profile for a token. Null on any failure (UI degrades). */
export async function fetchEdaUserProfile(
  token: string,
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<EdaUserProfile | null> {
  try {
    const res = await doFetch(EDA_USER_INFO_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-token': token,
      },
      body: '{}',
    })
    if (!res.ok) return null
    const body = (await res.json()) as { code?: number; result?: Record<string, unknown> }
    if (body.code !== 200000 || !body.result) return null
    const r = body.result
    return {
      ...(typeof r.nickname === 'string' && r.nickname ? { nickname: r.nickname } : {}),
      ...(typeof r.headimage === 'string' && r.headimage ? { headimage: r.headimage } : {}),
      ...(typeof r.phone === 'string' && r.phone ? { phone: r.phone } : {}),
      ...(typeof r.username === 'string' && r.username ? { username: r.username } : {}),
    }
  } catch (err) {
    log().warn('fetchEdaUserProfile failed', { error: String((err as Error)?.message || err) })
    return null
  }
}

export const AUTH_ROUTE_PREFIX = '/api/v1/huaqiu/auth'

// ── Subscription balances / AI usage (proxied by the node half) ──────────────

/**
 * The authoritative subscription-balances endpoint
 * (`GET /sub-api/subscriptions/balances/current`).
 *
 * It may be served over PLAIN `http`, which is why the node half must be the one
 * to call it: a WebView fetch is refused by App Transport Security ("the
 * resource could not be loaded because the App Transport Security policy
 * requires the use of a secure connection") and, independently, by CORS (the
 * response sends no `Access-Control-Allow-Origin`). Node's fetch is subject to
 * neither. The URL is injected as resolved config by HQ Edge (`HQ_AI_ENV`);
 * this module has no hardcoded environment URL, and every payload is validated
 * against the single schema in `./subscription-balances.js`.
 */

/** Upstream budget for one balances call. */
export const AI_USAGE_TIMEOUT_MS = 10_000

/** Host-only label for diagnostics (never log the full URL or the token). */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '<invalid-url>'
  }
}

/**
 * Fetch and normalize AI usage for a token.
 *
 * `quotaRemainPercent` comes straight from the AI Points group — no local ratio
 * is derived. `null` on any failure (invalid payload, timeout, network, non-2xx)
 * so the UI degrades to「—」; never throws.
 *
 * The upstream header is `X-Token` (capital T).
 */
export async function fetchAiUsage(
  token: string,
  subscriptionBalancesUrl: string,
  doFetch: typeof fetch = globalThis.fetch.bind(globalThis),
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AiUsage | null> {
  const timeoutMs = options.timeoutMs ?? AI_USAGE_TIMEOUT_MS
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const host = safeHost(subscriptionBalancesUrl)
  try {
    const res = await doFetch(subscriptionBalancesUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'X-Token': token,
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      log().warn('subscription balances request failed', { host, status: res.status })
      return null
    }
    const usage = aiUsageFromPayload(await res.json())
    if (!usage) log().warn('subscription balances payload unusable', { host })
    return usage
  } catch (err) {
    log().warn('subscription balances request failed', {
      host,
      error: String((err as Error)?.message || err),
    })
    return null
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

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
        const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
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
        // Forward through `auth.logout()` rather than invalidating locally: in
        // host mode the EDA host owns the session, so only it can log the
        // operator out. A rejected request surfaces as 500 and the browser
        // half keeps its current (authenticated) state.
        await service.auth.logout()
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
        // `subscriptionOrigin` is the SAME resolved HQ_AI_ENV value as the
        // usage endpoint; the browser half uses it to build the host-dialog
        // URL instead of hardcoding gen.eda.cn.
        sendJson(res, 200, {
          hostMode: service.hostMode,
          subscriptionOrigin: service.subscriptionOrigin,
          // Origin of the resolved balances API — lets the browser build the
          // GEN/ERC active-subscription calls without hardcoding eda.cn.
          subscriptionApiBaseUrl: service.subscriptionApiBaseUrl,
        })
        return
      }

      if (req.method === 'GET' && pathname === `${AUTH_ROUTE_PREFIX}/user-info`) {
        // Rich profile (nickname + headimage) for the sidebar when the host
        // session carries only {token, userId} — e.g. host mode under kicad.
        // The token is resolved by the node half (host → pushed → persisted).
        const token = await service.auth.getAccessToken()
        if (!token) {
          sendJson(res, 200, { userInfo: null })
          return
        }
        const userInfo = await fetchEdaUserProfile(token)
        sendJson(res, 200, { userInfo })
        return
      }

      if (req.method === 'GET' && pathname === `${AUTH_ROUTE_PREFIX}/ai-usage`) {
        // The WebView CANNOT reach this endpoint itself (plain http → ATS +
        // CORS), so the node half performs the call with the credential IT
        // resolved (host → pushed → persisted) — the same shape as /user-info
        // above. The URL itself is resolved by HQ Edge; absent → no call.
        const token = await service.auth.getAccessToken()
        if (!token || !service.subscriptionBalancesUrl) {
          sendJson(res, 200, { usage: null })
          return
        }
        const controller = new AbortController()
        const onClose = () => controller.abort()
        res.on('close', onClose)
        let usage: AiUsage | null
        try {
          usage = await fetchAiUsage(
            token,
            service.subscriptionBalancesUrl,
            globalThis.fetch.bind(globalThis),
            { signal: controller.signal },
          )
        } finally {
          res.off('close', onClose)
        }
        sendJson(res, 200, { usage })
        return
      }

      if (req.method === 'POST' && pathname === `${AUTH_ROUTE_PREFIX}/login`) {
        // Host-mode login: forward to HQ Edge, which asks EDA (KiCad) to open
        // its TriggerLoginDialog. Blocks until the dialog is completed.
        await service.auth.login()
        const user = await service.auth.getUserInfo()
        sendJson(res, 200, { ok: true, authenticated: user !== null, user })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      sendJson(res, 500, { error: 'internal error', detail: String(err) })
    }
  }
}
