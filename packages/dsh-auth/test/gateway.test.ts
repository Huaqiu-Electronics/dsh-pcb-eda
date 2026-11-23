/**
 * Tests for the standalone endpoint table (`gateway.ts`).
 *
 * The two environments are the contract with HQ Edge's
 * `apps/server/src/config/aiEndpoints.ts`: prod is `www.eda.cn`, test is
 * `fdatasheets.com`, both serve the gateway at `/user-rest/ai/v1`. A change
 * here that is not mirrored there makes a Desktop build talk to a different
 * environment than the host product would — hence the explicit assertions.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AI_ENV_KEYS,
  hostOf,
  joinEndpointUrl,
  managedGatewayBaseUrls,
  parseAiEnvironment,
  resolveAiEndpoints,
} from '../src/gateway.js'

describe('joinEndpointUrl', () => {
  it('joins with exactly one slash and tolerates doubles', () => {
    expect(joinEndpointUrl('https://a', '/x/y')).toBe('https://a/x/y')
    expect(joinEndpointUrl('https://a/', 'x/y')).toBe('https://a/x/y')
    expect(joinEndpointUrl('https://a//', '//x')).toBe('https://a/x')
    expect(joinEndpointUrl('https://a', '')).toBe('https://a')
  })
})

describe('parseAiEnvironment', () => {
  it('defaults to prod for absent / blank / prod', () => {
    expect(parseAiEnvironment(undefined)).toBe('prod')
    expect(parseAiEnvironment('')).toBe('prod')
    expect(parseAiEnvironment('  ')).toBe('prod')
    expect(parseAiEnvironment('prod')).toBe('prod')
    expect(parseAiEnvironment(' PROD ')).toBe('prod')
  })

  it('accepts test case-insensitively', () => {
    expect(parseAiEnvironment('test')).toBe('test')
    expect(parseAiEnvironment('TEST')).toBe('test')
  })

  it('reports an unknown selector and falls back to prod', () => {
    const onInvalid = vi.fn()
    expect(parseAiEnvironment('staging', onInvalid)).toBe('prod')
    expect(onInvalid).toHaveBeenCalledWith('staging')
  })
})

describe('resolveAiEndpoints', () => {
  it('resolves prod by default', () => {
    const endpoints = resolveAiEndpoints(undefined, {})
    expect(endpoints.environment).toBe('prod')
    expect(endpoints.gatewayBaseUrl).toBe('https://www.eda.cn/user-rest/ai/v1')
    expect(endpoints.subscriptionOrigin).toBe('https://gen.eda.cn')
    expect(endpoints.subscriptionBalancesUrl).toBe(
      'https://www.eda.cn/sub-api/subscriptions/balances/current',
    )
    expect(endpoints.profileUrl).toBe('https://www.eda.cn/account/profile')
  })

  it('resolves test from the same table', () => {
    const endpoints = resolveAiEndpoints('test', {})
    expect(endpoints.environment).toBe('test')
    expect(endpoints.gatewayBaseUrl).toBe('http://www.fdatasheets.com/user-rest/ai/v1')
    expect(endpoints.subscriptionOrigin).toBe('http://gen.fdatasheets.com')
    // TEST serves the account page one level higher.
    expect(endpoints.profileUrl).toBe('http://www.fdatasheets.com/account')
  })

  it('honours per-endpoint env overrides', () => {
    const endpoints = resolveAiEndpoints('test', {
      [AI_ENV_KEYS.gateway]: 'http://127.0.0.1:8443/ai/v1/',
      [AI_ENV_KEYS.subscriptionOrigin]: 'http://gen.local:9000/',
      [AI_ENV_KEYS.profile]: 'http://local:9000/account/',
      [AI_ENV_KEYS.subscriptionBalances]: 'http://local:9000/balances',
    })
    expect(endpoints.gatewayBaseUrl).toBe('http://127.0.0.1:8443/ai/v1')
    expect(endpoints.subscriptionOrigin).toBe('http://gen.local:9000')
    expect(endpoints.profileUrl).toBe('http://local:9000/account')
    expect(endpoints.subscriptionBalancesUrl).toBe('http://local:9000/balances')
  })

  it('surfaces the invalid-selector warning through the callback', () => {
    const onInvalid = vi.fn()
    const endpoints = resolveAiEndpoints('qa', {}, onInvalid)
    expect(endpoints.environment).toBe('prod')
    expect(onInvalid).toHaveBeenCalledWith('qa')
  })
})

describe('managedGatewayBaseUrls', () => {
  it('lists one URL per environment so a boot can tell its own value apart', () => {
    expect(managedGatewayBaseUrls()).toEqual([
      'https://www.eda.cn/user-rest/ai/v1',
      'http://www.fdatasheets.com/user-rest/ai/v1',
    ])
  })
})

describe('hostOf', () => {
  it('never returns a full URL', () => {
    expect(hostOf('https://www.eda.cn/user-rest/ai/v1?token=secret')).toBe('www.eda.cn')
    expect(hostOf('not a url')).toBe('<invalid-url>')
  })
})
