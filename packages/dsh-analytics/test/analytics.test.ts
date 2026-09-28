import { describe, expect, it } from 'vitest'
import {
  createAnalytics,
  resolveReqSource,
  trackLogin,
  type SensorsClient,
} from '../src/client/analytics.js'

function fakeSensors() {
  const calls: Array<[string, ...unknown[]]> = []
  const client: SensorsClient = {
    init: options => { calls.push(['init', options]) },
    register: properties => { calls.push(['register', properties]) },
    quick: (name, properties) => { calls.push(['quick', name, properties]) },
    track: (name, properties) => { calls.push(['track', name, properties]) },
    login: id => { calls.push(['login', id]) },
  }
  return { client, calls }
}

describe('resolveReqSource', () => {
  it('uses kicad only for a non-hq-eda host session', () => {
    expect(resolveReqSource(true, 'kicad')).toBe('kicad')
    expect(resolveReqSource(true, 'generic')).toBe('kicad')
  })

  it('uses website outside host mode', () => {
    expect(resolveReqSource(false, '')).toBe('website')
    expect(resolveReqSource(false, 'hq-eda')).toBe('website')
  })

  it('uses huaqiu_eda_desktop for the hq-eda host', () => {
    expect(resolveReqSource(true, 'hq-eda')).toBe('huaqiu_eda_desktop')
  })
})

describe('createAnalytics', () => {
  it('registers public properties before Sensors autoTrack', () => {
    const { client, calls } = fakeSensors()
    createAnalytics(client, { hostMode: true, targetHost: 'kicad' })

    expect(calls).toEqual([
      ['init', expect.objectContaining({
        server_url: 'https://sensorsapi.hqchip.com/sa?project=eda',
        heatmap: { scroll_notice_map: 'not_collect' },
        use_client_time: true,
        send_type: 'beacon',
      })],
      ['register', {
        env: 'prod',
        project: 'dsh_copilot',
        req_source: 'kicad',
      }],
      ['quick', 'autoTrack', undefined],
    ])
  })

  it('offers one custom track function without rewriting public properties', () => {
    const { client, calls } = fakeSensors()
    const analytics = createAnalytics(client, { hostMode: false, targetHost: '' })
    analytics.track('custom_event', { method: 'eda_account' })

    expect(calls.at(-1)).toEqual(['track', 'custom_event', { method: 'eda_account' }])
  })

  it('identifies a signed-in user through the Sensors login API', () => {
    const { client, calls } = fakeSensors()
    const analytics = createAnalytics(client, { hostMode: false, targetHost: '' })
    analytics.login('user-42')

    expect(calls.at(-1)).toEqual(['login', 'user-42'])
  })

  it('tracks a successful login with the user id', () => {
    const { client, calls } = fakeSensors()
    const analytics = createAnalytics(client, { hostMode: false, targetHost: '' })
    trackLogin(analytics, 'user-42')

    expect(calls.slice(-2)).toEqual([
      ['login', 'user-42'],
      ['track', 'login', { uid: 'user-42' }],
    ])
  })
})
