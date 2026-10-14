/**
 * `@huaqiu/dsh-auth` — node plugin entry.
 *
 * Provides the `huaqiuAuth` service (capability, not token transport) and
 * mounts the browser→node credential routes on `ctx.webServer`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import {
  DEFAULT_HOST_AUTH_PATH,
  resolveHostConfig,
  type HuaqiuAuthConfig,
} from './host.js'
import { HuaqiuApiKeySync, HUAQIU_API_KEY_REF } from './apiKeySync.js'
import { InMemoryHuaqiuAuthService, type HuaqiuAuthService } from './service.js'
import { AUTH_ROUTE_PREFIX, createAuthHandler } from './routes.js'

const log = getLogger('dsh-auth')

export type { HuaqiuAuthApi, HuaqiuAuthService, HuaqiuUserInfo } from './service.js'
export { InMemoryHuaqiuAuthService } from './service.js'
export { AUTH_ROUTE_PREFIX, createAuthHandler, type AuthHandler } from './routes.js'
export {
  DEFAULT_HUAQIU_API_KEY_SYNC_MS,
  HuaqiuApiKeySync,
  HUAQIU_API_KEY_REF,
  type CredentialStore,
} from './apiKeySync.js'
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

  // Host mode: mirror the operator token into the DSH credential reference
  // `HUAQIU_API_KEY` so the bundled `huaqiu` AI provider can resolve it per
  // request (task huaqiu-ai-gateway §5). The sync re-fetches the loopback
  // token endpoint on an immediate round plus a 5 s non-overlapping poll;
  // it is host-scoped only — standalone DSH keeps its browser-login flow and
  // the reference stays unset (missing credential → explicit
  // MISSING_CREDENTIAL, never a fallback key).
  if (service.hostMode) {
    ctx.effect(() => {
      const resolved = resolveHostConfig(config)
      const sync = new HuaqiuApiKeySync(
        resolved.hqEdgeBaseUrl ?? '',
        resolved.hostAuthPath ?? DEFAULT_HOST_AUTH_PATH,
        // Lazy per-round resolution: the `credentials` service may not be
        // activated yet while this plugin boots (activation order). Direct
        // `ctx.credentials` property access would throw "cannot get property
        // ... without inject" in that window; `ctx.get('credentials')`
        // returns undefined instead, so the round is skipped and the next
        // poll retries once the service is live (self-healing, no restart).
        () => {
          const credentials = ctx.get('credentials') as
            | { set(ref: string, value: string): Promise<void>; unset(ref: string): Promise<void> }
            | undefined
          if (credentials === undefined) return null
          return {
            set: (ref, value) => credentials.set(ref as CredentialRef, value),
            unset: (ref) => credentials.unset(ref as CredentialRef),
          }
        },
        {
          debug: (msg, ctx2) => log.debug(msg, ctx2),
          info: (msg, ctx2) => log.info(msg, ctx2),
          warn: (msg, ctx2) => log.warn(msg, ctx2),
        },
      )
      sync.start()
      return () => sync.dispose()
    })
  }

  log.info('dsh-auth node half ready', { routes: AUTH_ROUTE_PREFIX, hostMode: service.hostMode })
}
