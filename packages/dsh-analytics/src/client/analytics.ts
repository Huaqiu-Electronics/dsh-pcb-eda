export const SENSORS_SERVER_URL = 'https://sensorsapi.hqchip.com/sa?project=eda'

export type ReqSource = 'website' | 'kicad' | 'huaqiu_eda_desktop'
export type AnalyticsProperties = Record<string, unknown>

export interface SensorsClient {
  init(options: {
    server_url: string
    heatmap: { scroll_notice_map: 'not_collect' }
    use_client_time: true
    send_type: 'beacon'
    show_log?: boolean
  }): void
  register(properties: AnalyticsProperties): void
  quick(name: string, properties?: AnalyticsProperties): void
  track(name: string, properties?: AnalyticsProperties): void
  login(id: string): void
}

export interface HuaqiuAnalytics {
  track(event: string, properties?: AnalyticsProperties): void
  login(userId: string): void
}

export function trackLogin(analytics: HuaqiuAnalytics, uid: string): void {
  analytics.login(uid)
  analytics.track('login', { uid })
}

export function resolveReqSource(hostMode: boolean, targetHost: string): ReqSource {
  if (!hostMode) return 'website'
  return targetHost === 'hq-eda' ? 'huaqiu_eda_desktop' : 'kicad'
}

export function createAnalytics(
  sensors: SensorsClient,
  host: { hostMode: boolean; targetHost: string },
): HuaqiuAnalytics {
  sensors.init({
    server_url: SENSORS_SERVER_URL,
    heatmap: { scroll_notice_map: 'not_collect' },
    use_client_time: true,
    send_type: 'beacon',
    show_log: true,
  })
  sensors.register({
    env: 'prod',
    project: 'dsh_copilot',
    req_source: resolveReqSource(host.hostMode, host.targetHost),
  })
  sensors.quick('autoTrack')

  return {
    track: (event, properties) => { sensors.track(event, properties) },
    login: userId => { sensors.login(userId) },
  }
}
