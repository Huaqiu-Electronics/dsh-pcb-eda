/**
 * `@huaqiu/dsh-auth` — node plugin entry.
 *
 * Provides the `huaqiuAuth` service (capability, not token transport) and
 * mounts the browser→node credential routes on `ctx.webServer`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { getLogger, type PluginLogger } from '@huaqiu/dsh-plugin-log'
import {
  DEFAULT_HOST_AUTH_PATH,
  resolveHostConfig,
  type HuaqiuAuthConfig,
} from './host.js'
import {
  HuaqiuApiKeySync,
  HUAQIU_API_KEY_REF,
  type CredentialStore,
  type VolatileCredentialStore,
} from './apiKeySync.js'
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
        //
        // The store prefers the mounted provider's in-memory `setVolatile`
        // channel when it exists, so the HQ Edge token mirrors into RAM only —
        // no `.credentials.yaml` write, no cross-process lock. When the mounted
        // provider predates that channel the durable `set`/`unset` fallback is
        // used (the previous persistent behavior).
        () => {
          const credentials = ctx.get('credentials') as
            | (CredentialProvider & Partial<VolatileCredentialStore>)
            | undefined
          if (credentials === undefined) return null
          const store: CredentialStore & Partial<VolatileCredentialStore> = {
            set: (ref, value) => credentials.set(ref as CredentialRef, value),
            unset: (ref) => credentials.unset(ref as CredentialRef),
          }
          if (typeof credentials.setVolatile === 'function') {
            store.setVolatile = (ref, value) => credentials.setVolatile!(ref as CredentialRef, value)
            store.unsetVolatile = (ref) => credentials.unsetVolatile!(ref as CredentialRef)
          }
          return store
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

  // React to a LIVE failed Huaqiu request, not to the durable turn/end node:
  // Cordis events are in-memory and are not replayed when a session is restored,
  // so reopening DSH can never pop the native login dialog for an old failure.
  // The harness owns the `agent/request-error` event typings and dsh-auth does
  // not depend on them, so register through the narrow structural view below.
  ;(ctx as unknown as {
    on(event: 'agent/request-error', listener: RequestErrorListenerView): unknown
  }).on('agent/request-error', createHuaqiuMissingCredentialLoginListener(service))
}

/**
 * Narrow structural view of the harness `agent/request-error` waterfall. Only
 * the fields this plugin reads are modelled; the real payload also carries
 * `agent`, `turn`, `step`, `retryPolicy` and a required `signal`.
 */
export interface RequestErrorPayloadView {
  readonly provider: string
  readonly failure: { readonly code: string }
  readonly signal?: AbortSignal
}

export type RequestErrorActionView = { readonly kind: 'retry' } | undefined

export type RequestErrorListenerView = (
  payload: RequestErrorPayloadView,
  next: () => Promise<RequestErrorActionView>,
) => Promise<RequestErrorActionView>

/** The slice of `HuaqiuAuthService` the automatic-login hook depends on. */
export interface AutoLoginAuthView {
  readonly hostMode: boolean
  readonly auth: { login(): Promise<void> }
}

/**
 * Build the live-failure login hook. One instance per running DSH process, so
 * `loginInFlight` coalesces simultaneous failures and is cleared once login
 * settles — successfully or otherwise — without ever retrying the model turn.
 */
export function createHuaqiuMissingCredentialLoginListener(
  service: AutoLoginAuthView,
  warn: PluginLogger['warn'] = (message, fields) => log.warn(message, fields),
): RequestErrorListenerView {
  let loginInFlight: Promise<void> | undefined

  return async (payload, next) => {
    // Delegate first: an inner retry policy may own this failure, in which
    // case the dialog must not open and the original action is preserved.
    const action = await next()
    if (action?.kind === 'retry') return action

    if (
      service.hostMode &&
      payload.provider === 'huaqiu' &&
      payload.failure.code === 'MISSING_CREDENTIAL' &&
      payload.signal?.aborted !== true &&
      loginInFlight === undefined
    ) {
      // Fire and forget: the host login route can block for minutes, while the
      // failed turn must close immediately. Catching here keeps a login error
      // from replacing the original LLM failure in the waterfall.
      loginInFlight = service.auth.login()
        .catch((error: unknown) => {
          warn('automatic Huaqiu login failed', { error: String(error) })
        })
        .finally(() => {
          loginInFlight = undefined
        })
    }
    return action
  }
}
