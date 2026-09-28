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
    const tracked = isTrackedTool(exec.name)
    if (tracked) toolStartTimes.set(exec, Date.now())
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    const tracked = isTrackedTool(exec.name)
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
