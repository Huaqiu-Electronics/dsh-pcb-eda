/**
 * Tests for standalone gateway provisioning (`provider.ts`).
 *
 * Contract under test:
 *  - absent `providers.huaqiu` → one `settings.update` carrying the full entry
 *    (display name, `apiKeyEnv: HUAQIU_API_KEY`, `openai-completions`, the
 *    resolved `baseURL`, and the single `auto-model` with declared capacity);
 *  - a second boot with the same environment writes NOTHING (idempotence);
 *  - an `HQ_AI_ENV` switch re-points only the baseURL this product wrote;
 *  - a user-authored baseURL (a proxy) is never overwritten;
 *  - `agent-default-model` is seeded only when the user made no selection;
 *  - a composition without `llm-pi-ai` (or without settings) is skipped, not
 *    failed.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MODEL_SETTINGS_NS,
  PROVIDER_SETTINGS_NS,
  ensureHuaqiuGatewayProvider,
  huaqiuProviderEntry,
  isManagedGatewayBaseUrl,
  type SettingsDescriptorView,
  type SettingsPort,
} from '../src/provider.js'
import { resolveAiEndpoints } from '../src/gateway.js'

type UpdateMock = ((ns: string, patch: object) => Promise<void>) & {
  mock: { calls: [string, object][] }
  mockResolvedValue: (value: void) => unknown
}

interface FakeSettings extends SettingsPort {
  update: UpdateMock
  descriptors: SettingsDescriptorView[]
}

function fakeSettings(descriptors: SettingsDescriptorView[]): FakeSettings {
  const update = vi.fn().mockResolvedValue(undefined) as unknown as UpdateMock
  return {
    descriptors,
    update,
    describe: () => descriptors,
  }
}

function providerRow(value: unknown, user: unknown = {}): SettingsDescriptorView {
  return { ns: PROVIDER_SETTINGS_NS, value: { providers: value }, user: { providers: user } }
}

const DEFAULT_ROW = (user: unknown = {}): SettingsDescriptorView => ({
  ns: DEFAULT_MODEL_SETTINGS_NS,
  value: { provider: 'deepseek-official', model: 'deepseek-flash' },
  user,
})

const logger = { info: vi.fn(), warn: vi.fn() }

describe('huaqiuProviderEntry', () => {
  it('renders the documented provider profile', () => {
    const entry = huaqiuProviderEntry(resolveAiEndpoints('test', {}))
    expect(entry.displayName).toBe('华秋 AI')
    expect(entry.apiKeyEnv).toBe('HUAQIU_API_KEY')
    expect(entry.api).toBe('openai-completions')
    expect(entry.baseURL).toBe('http://www.fdatasheets.com/user-rest/ai/v1')
    expect(entry.models).toEqual([{
      id: 'auto-model',
      name: 'auto-model',
      contextWindow: 1_000_000,
      maxTokens: 256_000,
      input: ['text', 'image'],
    }])
  })
})

describe('isManagedGatewayBaseUrl', () => {
  it('treats empty as managed and a custom URL as foreign', () => {
    expect(isManagedGatewayBaseUrl(undefined)).toBe(true)
    expect(isManagedGatewayBaseUrl('')).toBe(true)
    expect(isManagedGatewayBaseUrl('https://www.eda.cn/user-rest/ai/v1/')).toBe(true)
    expect(isManagedGatewayBaseUrl('http://proxy.local:8080/v1')).toBe(false)
  })
})

describe('ensureHuaqiuGatewayProvider', () => {
  it('seeds provider + default model when neither exists', async () => {
    const settings = fakeSettings([providerRow({}), DEFAULT_ROW()])
    const action = await ensureHuaqiuGatewayProvider(settings, resolveAiEndpoints('prod', {}), logger)
    expect(action).toBe('seeded-provider-and-default')
    expect(settings.update).toHaveBeenCalledTimes(2)
    const [ns, patch] = settings.update.mock.calls[0]!
    expect(ns).toBe(PROVIDER_SETTINGS_NS)
    expect((patch as { providers: Record<string, { baseURL: string }> }).providers.huaqiu!.baseURL)
      .toBe('https://www.eda.cn/user-rest/ai/v1')
    expect(settings.update.mock.calls[1]).toEqual([
      DEFAULT_MODEL_SETTINGS_NS,
      { provider: 'huaqiu', model: 'auto-model' },
    ])
  })

  it('writes nothing on a second boot with the same environment', async () => {
    const settings = fakeSettings([
      providerRow({ huaqiu: huaqiuProviderEntry(resolveAiEndpoints('prod', {})) }),
      DEFAULT_ROW({ provider: 'huaqiu', model: 'auto-model' }),
    ])
    const action = await ensureHuaqiuGatewayProvider(settings, resolveAiEndpoints('prod', {}), logger)
    expect(action).toBe('user-default-kept')
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('re-points a managed baseURL when the environment switches', async () => {
    const settings = fakeSettings([
      providerRow({ huaqiu: huaqiuProviderEntry(resolveAiEndpoints('prod', {})) }),
      DEFAULT_ROW({ provider: 'huaqiu' }),
    ])
    const action = await ensureHuaqiuGatewayProvider(settings, resolveAiEndpoints('test', {}), logger)
    expect(action).toBe('repointed-gateway')
    expect(settings.update).toHaveBeenCalledTimes(1)
    expect(settings.update.mock.calls[0]![1]).toEqual({
      providers: { huaqiu: { baseURL: 'http://www.fdatasheets.com/user-rest/ai/v1' } },
    })
  })

  it('never overwrites a user-authored baseURL', async () => {
    const settings = fakeSettings([
      providerRow({ huaqiu: { ...huaqiuProviderEntry(resolveAiEndpoints('prod', {})), baseURL: 'http://proxy.local/v1' } }),
      DEFAULT_ROW({ provider: 'huaqiu' }),
    ])
    const action = await ensureHuaqiuGatewayProvider(settings, resolveAiEndpoints('test', {}), logger)
    expect(action).toBe('user-default-kept')
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('keeps a default the user chose themselves', async () => {
    const settings = fakeSettings([
      providerRow({}), // no provider yet → provider is seeded …
      DEFAULT_ROW({ provider: 'anthropic', model: 'opus' }), // … but this choice is theirs
    ])
    const action = await ensureHuaqiuGatewayProvider(settings, resolveAiEndpoints('prod', {}), logger)
    expect(action).toBe('seeded-provider')
    expect(settings.update).toHaveBeenCalledTimes(1)
    expect(settings.update.mock.calls[0]![0]).toBe(PROVIDER_SETTINGS_NS)
  })

  it('keeps every other provider the user configured', async () => {
    const settings = fakeSettings([
      providerRow({
        'my-proxy': { displayName: 'Proxy', api: 'openai-completions', baseURL: 'http://p/v1' },
      }),
      DEFAULT_ROW(),
    ])
    await ensureHuaqiuGatewayProvider(settings, resolveAiEndpoints('prod', {}), logger)
    // The patch names only the key being added, so merge semantics preserve
    // the rest of the dict.
    const patch = settings.update.mock.calls[0]![1] as { providers: Record<string, unknown> }
    expect(Object.keys(patch.providers)).toEqual(['huaqiu'])
  })

  it('skips without pi-ai row, without settings, and without default row', async () => {
    expect(await ensureHuaqiuGatewayProvider(null, resolveAiEndpoints('prod', {}), logger))
      .toBe('skipped-no-settings')
    const noRow = fakeSettings([DEFAULT_ROW()])
    expect(await ensureHuaqiuGatewayProvider(noRow, resolveAiEndpoints('prod', {}), logger))
      .toBe('skipped-no-pi-ai-row')
    const noDefault = fakeSettings([providerRow({})])
    expect(await ensureHuaqiuGatewayProvider(noDefault, resolveAiEndpoints('prod', {}), logger))
      .toBe('seeded-provider')
  })
})
