/**
 * Node-side Loader seat for the browser-only About plugin.
 *
 * Mounts a same-origin version route on `ctx.webServer` (the same channel
 * `@huaqiu/dsh-auth` uses for its credential routes): `GET
 * /api/v1/huaqiu/about` returns `{ version, dshVersion }` — this plugin's own
 * declared version (read from the package manifest next to this entry) and the
 * DSH version bundled with the running harness. The browser half fetches them
 * when the About row renders.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolveDshVersion } from './dsh-version'

export const inject = ['webServer'] as const

export const ABOUT_ROUTE_PREFIX = '/api/v1/huaqiu/about'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** This plugin's declared version from `package.json`, or null when unreadable. */
export function pluginVersion(): string | null {
  try {
    const manifestUrl = new URL('../package.json', import.meta.url)
    const manifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : null
  } catch {
    return null
  }
}

/**
 * Install the About version route on the running context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ABOUT_ROUTE_PREFIX,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      sendJson(res, 200, {
        version: pluginVersion(),
        dshVersion: resolveDshVersion(),
      })
    },
  }), 'huaqiu about: plugin + DSH version route')
}
