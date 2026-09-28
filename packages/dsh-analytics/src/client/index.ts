import sensors from 'sa-sdk-javascript'
import {
  createAnalytics,
  trackLogin,
  type HuaqiuAnalytics,
  type SensorsClient,
} from './analytics.js'
import type { AnalyticsEvent } from '../tool-events.js'

export const inject: string[] = []

interface AuthInfo {
  id?: string
  userId?: string
}

interface AuthApi {
  isAuthenticated(): boolean
  getUserInfo(): Promise<AuthInfo | null>
  onAuthStateChanged(listener: (info: AuthInfo | null) => void): () => void
}

interface HqEdgeService {
  context?: { getTargetHost?(): string }
}

interface ClientContext {
  provide?(name: string, value: unknown): () => void
  get?<T>(name: string): T | undefined
}

const POLL_INTERVAL_MS = 1000

async function resolveHostMode(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/huaqiu/auth/config', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const body = await response.json() as { hostMode?: unknown }
    return body.hostMode === true
  } catch {
    return false
  }
}

async function drainNodeEvents(analytics: HuaqiuAnalytics): Promise<void> {
  try {
    const response = await fetch('/api/v1/huaqiu/analytics/events', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return
    const body = await response.json() as { events?: AnalyticsEvent[] }
    for (const item of body.events ?? []) {
      if (typeof item?.event === 'string' && item.event.length > 0) {
        analytics.track(item.event, item.properties)
      }
    }
  } catch {
    // Analytics must never affect the host application.
  }
}

export function apply(ctx: ClientContext): () => void {
  const disposers: Array<() => void> = []
  let disposed = false

  void resolveHostMode().then((hostMode) => {
    if (disposed) return
    const targetHost = ctx.get?.<HqEdgeService>('hqEdge')?.context?.getTargetHost?.() ?? ''
    const analytics = createAnalytics(sensors as unknown as SensorsClient, { hostMode, targetHost })

    const disposeProvide = ctx.provide?.('huaqiuAnalytics', analytics)
    if (disposeProvide) disposers.push(disposeProvide)

    const auth = ctx.get?.<{ auth?: AuthApi }>('huaqiuAuth')?.auth
    if (auth) {
      let wasAuthenticated = auth.isAuthenticated()
      void auth.getUserInfo().then((info) => {
        const userId = info?.id ?? info?.userId
        if (userId) analytics.login(userId)
      }).catch(() => undefined)
      disposers.push(auth.onAuthStateChanged((info) => {
        const authenticated = info !== null
        const userId = info?.id ?? info?.userId
        if (userId && !wasAuthenticated && authenticated) trackLogin(analytics, userId)
        else if (userId) analytics.login(userId)
        wasAuthenticated = authenticated
      }))
    }

    void drainNodeEvents(analytics)
    const timer = window.setInterval(() => { void drainNodeEvents(analytics) }, POLL_INTERVAL_MS)
    disposers.push(() => { window.clearInterval(timer) })
  })

  return () => {
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

export { createAnalytics, resolveReqSource, trackLogin, type HuaqiuAnalytics } from './analytics.js'
