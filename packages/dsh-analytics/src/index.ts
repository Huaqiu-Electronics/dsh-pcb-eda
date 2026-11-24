import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import { ANALYTICS_ROUTE_PREFIX, createAnalyticsHandler } from './routes.js'
import { AnalyticsEventQueue, isTrackedTool, toToolAnalyticsEvent, type AnalyticsEvent } from './tool-events.js'

export const name = '@huaqiu/dsh-analytics'
export const inject = ['webServer', 'tools'] as const

export interface HuaqiuAnalyticsService {
  track(event: string, properties?: Record<string, unknown>): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    huaqiuAnalytics: HuaqiuAnalyticsService
  }
}

export function apply(ctx: Context): void {
  const log = getLogger('dsh-analytics')
  const queue = new AnalyticsEventQueue()
  installModelCallAnalytics(ctx, queue)
  const toolStartTimes = new WeakMap<object, number>()
  const service: HuaqiuAnalyticsService = {
    track(event, properties) {
      queue.push({ event, properties })
    },
  }

  ctx.effect(() => ctx.provide('huaqiuAnalytics', service))
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ANALYTICS_ROUTE_PREFIX,
    handler: createAnalyticsHandler(queue),
  }))
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tracked = isTrackedTool(exec)
    if (tracked) toolStartTimes.set(exec, Date.now())
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    const tracked = isTrackedTool(exec)
    if (!tracked) return
    const startedAt = toolStartTimes.get(exec)
    toolStartTimes.delete(exec)
    const event = toToolAnalyticsEvent(exec, result, startedAt === undefined ? 0 : Date.now() - startedAt)
    queue.push(event)
  })

  log.info('analytics ready', { route: ANALYTICS_ROUTE_PREFIX })
}

export { ANALYTICS_ROUTE_PREFIX, createAnalyticsHandler } from './routes.js'
export { AnalyticsEventQueue, isTrackedTool, toToolAnalyticsEvent, type AnalyticsEvent } from './tool-events.js'

interface UserInfo { id: string; token: string }
interface ModelCallAuth {
  auth: { getUserInfo(): Promise<UserInfo | null> }
  readonly subscriptionApiBaseUrl: string | null
}
interface RequestPosition {
  agent: { session: { id: string } }
  turn: number
  step: number
  signal: AbortSignal
}
interface ModelRequest {
  provider: string
  model: string
  sessionId?: string
  signal?: AbortSignal
  purpose?: string
}
interface ModelAnalyticsContext {
  on(name: 'agent/request', listener: (position: RequestPosition, next: () => Promise<unknown>) => Promise<unknown>): unknown
  on(name: 'llm/stream', listener: (request: ModelRequest, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>): unknown
}

/** Read the existing active subscription contract, without a package-ID enum. */
async function fetchPackageId(
  user: UserInfo,
  baseUrl: string,
): Promise<number | undefined> {
  try {
    const url = new URL('/sub-api/subscriptions/active', baseUrl)
    url.searchParams.set('userId', user.id)
    url.searchParams.set('productCode', 'auto-design')
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'x-token': user.token, 'X-User-Id': user.id },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return undefined
    const body = await response.json() as { code?: number; result?: { packageId?: unknown }; data?: { packageId?: unknown } }
    if (body.code !== 200 && body.code !== 200000) return undefined
    const value = (body.result ?? body.data)?.packageId
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined
    const id = Number(value)
    return Number.isFinite(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** Capture backend calls; delivery continues through the existing browser queue. */
function installModelCallAnalytics(ctx: Context, queue: AnalyticsEventQueue): void {
  const events = ctx as unknown as ModelAnalyticsContext
  // An agent retries the same turn/step; normal tool continuations advance step.
  // Signals scope this state to the live turn, avoiding replay and session leaks.
  const positions = new WeakMap<AbortSignal, Map<string, { turn: number; step: number; attempts: number }>>()
  events.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    let sessions = positions.get(signal)
    if (!sessions) positions.set(signal, sessions = new Map())
    const previous = sessions.get(agent.session.id)
    if (!previous || previous.turn !== turn || previous.step !== step) {
      sessions.set(agent.session.id, { turn, step, attempts: 0 })
    }
    return next()
  })

  async function capture(properties: Record<string, unknown>): Promise<void> {
    try {
      const service = ctx.get('huaqiuAuth') as ModelCallAuth | undefined
      const user = await service?.auth.getUserInfo()
      if (user) {
        properties.uid = user.id
        if (service?.subscriptionApiBaseUrl) {
          try {
            const id = await fetchPackageId(user, service.subscriptionApiBaseUrl)
            if (id !== undefined) properties.package_id = id
          } catch { /* Subscription failures never suppress a model-call event. */ }
        }
      }
    } catch {
      // Missing auth must not suppress otherwise valid model-call events.
    }
    try { queue.push({ event: 'ai_model_call', properties }) } catch { /* Never interrupt streaming. */ }
  }

  events.on('llm/stream', (request, next) => (async function* () {
    if (!request.signal?.aborted) {
      const position = !request.purpose && request.signal && request.sessionId
        ? positions.get(request.signal)?.get(request.sessionId)
        : undefined
      const isRetry = position ? position.attempts++ > 0 : false
      // Start enrichment without adding a subscription round trip to model latency.
      void capture({
        model_source: request.provider === 'huaqiu' ? 'huaqiu' : 'custom',
        model_provider: request.provider,
        model_id: request.model,
        is_retry: isRetry,
      })
    }
    yield* next()
  })())
}
