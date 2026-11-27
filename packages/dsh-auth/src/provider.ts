/**
 * Standalone provisioning of the Huaqiu AI gateway provider.
 *
 * Under HQ Edge the provider exists because the supervisor writes it into the
 * profile patch (`supervisor.ts` `seedHqProfilePatchDefaults` →
 * `mergeHuaqiuProvider`). A standalone product build has no supervisor, and
 * `llm-pi-ai` mounts DORMANT — zero routes until a `llm-pi-ai` settings
 * section supplies provider profiles ("Supplying those profiles is exactly
 * what the web Models page does", `packages/bundle/base/cordis.patch.yml`).
 *
 * So this module does the same thing the Models page would, through the same
 * public seam (`ctx.settings.update`), and nothing else:
 *
 *   - `providers.huaqiu` absent → add the whole provider entry (display name,
 *     credential reference, `openai-completions`, the resolved gateway
 *     `baseURL`, and the one `auto-model` entry with its declared capacity);
 *   - present → leave it alone, EXCEPT when its `baseURL` is still one of the
 *     URLs this module manages (a previous boot wrote it) and the resolved
 *     environment has moved: then only that value is re-pointed, so a
 *     `HQ_AI_ENV` switch between prod and test reaches the next request. A
 *     baseURL the user typed is never touched;
 *   - `agent-default-model` → set `huaqiu / auto-model` ONLY when the user has
 *     made no explicit selection of their own (no `provider` in the user
 *     layer), so a deliberate choice is never displaced on the next boot.
 *
 * Everything is additive and idempotent: the second boot writes nothing, and a
 * settings section the user already curated keeps every custom provider.
 *
 * @module @huaqiu/dsh-auth/provider
 */

import {
  HUAQIU_AI_API_KEY_REF,
  HUAQIU_AI_CONTEXT_WINDOW,
  HUAQIU_AI_DISPLAY_NAME,
  HUAQIU_AI_INPUT_MODALITIES,
  HUAQIU_AI_MAX_TOKENS,
  HUAQIU_WORKBENCH_AUTO_MODEL_ID,
  HUAQIU_AI_PROVIDER_ID,
  managedGatewayBaseUrls,
  hostOf as hostOfUrl,
  type AiEndpoints,
} from './gateway.js'

/** `llm-pi-ai` holds the provider registry (see `HQ_AI_COMPOSITION_ROWS`). */
export const PROVIDER_SETTINGS_NS = 'llm-pi-ai'
/** `agent-default-model` holds the default selection for new agents. */
export const DEFAULT_MODEL_SETTINGS_NS = 'agent-default-model'

/** The slice of the DSH settings service this module needs. */
export interface SettingsDescriptorView {
  readonly ns: string
  /** Effective value (base + user layers). */
  readonly value?: unknown
  /** The user's own layer only — what a person configured in the UI. */
  readonly user?: unknown
}

export interface SettingsPort {
  describe(): readonly SettingsDescriptorView[]
  update(ns: string, patch: object): Promise<void>
}

/** Small logger surface (kept structural so tests can pass a spy). */
export interface ProviderLogger {
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
}

/** What provisioning did, for one log line at boot. */
export type ProviderAction =
  | 'seeded-provider-and-default'
  | 'seeded-provider'
  | 'repointed-gateway'
  | 'present'
  | 'user-default-kept'
  | 'skipped-no-pi-ai-row'
  | 'skipped-no-settings'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The provider entry this product ships, rendered from the resolved endpoints.
 *
 * Field names follow `llm-pi-ai`'s `profile` schema exactly (`pi-ai`'s
 * `openai-completions` protocol is spelled with the hyphen). `baseURL` stops at
 * the API root: the OpenAI client appends `/chat/completions` itself.
 */
export function huaqiuProviderEntry(endpoints: AiEndpoints): Record<string, unknown> {
  return {
    displayName: HUAQIU_AI_DISPLAY_NAME,
    apiKeyEnv: HUAQIU_AI_API_KEY_REF,
    api: 'openai-completions',
    baseURL: endpoints.gatewayBaseUrl,
    models: [
      {
        id: HUAQIU_WORKBENCH_AUTO_MODEL_ID,
        name: HUAQIU_WORKBENCH_AUTO_MODEL_ID,
        contextWindow: HUAQIU_AI_CONTEXT_WINDOW,
        maxTokens: HUAQIU_AI_MAX_TOKENS,
        input: [...HUAQIU_AI_INPUT_MODALITIES],
      },
    ],
  }
}

/**
 * Is this `baseURL` one this module manages (vs. one a user typed)?
 * An empty/absent value counts as managed: nothing has been chosen yet.
 */
export function isManagedGatewayBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return true
  return managedGatewayBaseUrls().includes(value.trim().replace(/\/+$/, ''))
}

/**
 * Seed / maintain the gateway provider and (when nobody chose) the default
 * model. Returns what it did; throws nothing on a missing composition row —
 * a DSH build without `llm-pi-ai` simply has no gateway to offer.
 */
export async function ensureHuaqiuGatewayProvider(
  settings: SettingsPort | null,
  endpoints: AiEndpoints,
  log: ProviderLogger,
): Promise<ProviderAction> {
  if (settings === null) return 'skipped-no-settings'

  const descriptors = settings.describe()
  const providerRow = descriptors.find(descriptor => descriptor.ns === PROVIDER_SETTINGS_NS)
  if (providerRow === undefined) return 'skipped-no-pi-ai-row'

  const effectiveProviders = asRecord(asRecord(providerRow.value)?.providers) ?? {}
  const existing = asRecord(effectiveProviders[HUAQIU_AI_PROVIDER_ID])

  let action: ProviderAction = 'present'
  if (existing === undefined) {
    await settings.update(PROVIDER_SETTINGS_NS, {
      providers: { [HUAQIU_AI_PROVIDER_ID]: huaqiuProviderEntry(endpoints) },
    })
    action = 'seeded-provider'
    log.info('seeded Huaqiu AI gateway provider into DSH settings', {
      ns: PROVIDER_SETTINGS_NS,
      environment: endpoints.environment,
      gatewayHost: hostOfUrl(endpoints.gatewayBaseUrl),
      model: HUAQIU_WORKBENCH_AUTO_MODEL_ID,
    })
  } else {
    // Re-point ONLY a value this module wrote earlier. A user-authored baseURL
    // (a proxy, a self-hosted route) must survive every boot.
    const current = existing.baseURL
    const managed = isManagedGatewayBaseUrl(current)
    const differs = typeof current === 'string'
      && current.trim().replace(/\/+$/, '') !== endpoints.gatewayBaseUrl
    if (managed && differs) {
      await settings.update(PROVIDER_SETTINGS_NS, {
        providers: { [HUAQIU_AI_PROVIDER_ID]: { baseURL: endpoints.gatewayBaseUrl } },
      })
      action = 'repointed-gateway'
      log.info('re-pointed Huaqiu AI gateway baseURL for the selected environment', {
        environment: endpoints.environment,
        gatewayHost: hostOfUrl(endpoints.gatewayBaseUrl),
      })
    }
  }

  // The default selection: only when the user has not chosen one. `user` is
  // their own layer, so an explicit choice (even the upstream default one) is
  // respected; `value` alone would also carry the composition default and
  // could never be told apart from a user edit.
  const defaultRow = descriptors.find(descriptor => descriptor.ns === DEFAULT_MODEL_SETTINGS_NS)
  if (defaultRow === undefined) return action
  const userDefault = asRecord(defaultRow.user)
  if (typeof userDefault?.provider === 'string' && userDefault.provider.length > 0) {
    return action === 'present' ? 'user-default-kept' : action
  }
  await settings.update(DEFAULT_MODEL_SETTINGS_NS, {
    provider: HUAQIU_AI_PROVIDER_ID,
    model: HUAQIU_WORKBENCH_AUTO_MODEL_ID,
  })
  log.info('seeded Huaqiu AI as the default model selection', {
    ns: DEFAULT_MODEL_SETTINGS_NS,
    provider: HUAQIU_AI_PROVIDER_ID,
    model: HUAQIU_WORKBENCH_AUTO_MODEL_ID,
  })
  return action === 'seeded-provider' ? 'seeded-provider-and-default' : action
}
