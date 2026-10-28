/**
 * `@huaqiu/dsh-auth` — node plugin entry.
 *
 * Provides the `huaqiuAuth` service (capability, not token transport) and
 * mounts the browser→node credential routes on `ctx.webServer`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import type { HuaqiuAuthConfig } from './host.js'
import { InMemoryHuaqiuAuthService, type HuaqiuAuthService } from './service.js'
import { AUTH_ROUTE_PREFIX, createAuthHandler } from './routes.js'

const log = getLogger('dsh-auth')

export type { HuaqiuAuthApi, HuaqiuAuthService, HuaqiuUserInfo } from './service.js'
export { InMemoryHuaqiuAuthService } from './service.js'
export { AUTH_ROUTE_PREFIX, createAuthHandler, type AuthHandler } from './routes.js'
export type { HuaqiuAuthConfig } from './host.js'

export const name = '@huaqiu/dsh-auth'
export const inject = ['webServer'] as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    huaqiuAuth: HuaqiuAuthService
  }
}

/**
 * @param ctx cordis context
 * @param config overlay `config` (hq-edge supervisor injects `hqEdgeBaseUrl`
 *   here). When present with a base URL, the plugin runs in HQ Edge host mode:
 *   the node half fetches the credential from HQ Edge instead of waiting for a
 *   browser login. Env (`HQ_EDGE_BASE_URL` …) is the fallback for installs
 *   without a supervisor (spec §6.4).
 */
export function apply(ctx: Context, config?: Partial<HuaqiuAuthConfig>): void {
  // The single most useful line when a harness upgrade "loses" the credential:
  // it proves whether the overlay `config` still reached `apply(ctx, config)`.
  // When `hostMode` is false under HQ Edge, the endpoint was not delivered and
  // every tool will report `needs_auth` no matter what the browser does.
  log.info('applying dsh-auth node half', {
    hasConfig: config != null,
    configKeys: config != null ? Object.keys(config) : [],
    hqEdgeBaseUrl: config?.hqEdgeBaseUrl ?? null,
  })

  const service = new InMemoryHuaqiuAuthService(config)
  ctx.effect(() => ctx.provide('huaqiuAuth', service))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: AUTH_ROUTE_PREFIX,
    handler: createAuthHandler(service),
  }))

  log.info('dsh-auth node half ready', { routes: AUTH_ROUTE_PREFIX, hostMode: service.hostMode })
}
