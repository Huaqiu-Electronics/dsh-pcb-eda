/**
 * Node-side Loader seat for the browser-only About plugin.
 *
 * Mounts a same-origin version route on `ctx.webServer` (the same channel
 * `@huaqiu/dsh-auth` uses for its credential routes): `GET
 * /api/v1/huaqiu/about` returns `{ version }` with the DSH version bundled
 * with the running harness. The browser half fetches it when the About row
 * renders.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveDshVersion } from './dsh-version'

export const inject = ['webServer'] as const

export const ABOUT_ROUTE_PREFIX = '/api/v1/huaqiu/about'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Install the About version route on the running context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ABOUT_ROUTE_PREFIX,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      sendJson(res, 200, { version: resolveDshVersion() })
    },
  }), 'huaqiu about: bundled DSH version route')
}
