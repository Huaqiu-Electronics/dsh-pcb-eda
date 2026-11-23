/**
 * Huaqiu AI gateway endpoints for STANDALONE DSH (no HQ Edge).
 *
 * Under HQ Edge the central config (`hq-edge/apps/server/src/config/aiEndpoints.ts`)
 * resolves every AI endpoint from one selector — `HQ_AI_ENV` — and passes the
 * results down as CONCRETE strings (host overlay → `dsh-auth` config, profile
 * patch → `llm-pi-ai` provider `baseURL`). A standalone product build (the
 * Desktop distribution) has no HQ Edge to do that, so this module carries the
 * SAME environment knowledge for that one mode:
 *
 *   - the presets (`prod` / `test`) and the path composition are a copy of the
 *     HQ Edge table, kept identical on purpose — `prod` is `www.eda.cn`,
 *     `test` is `fdatasheets.com`, and the gateway root is `/user-rest/ai/v1`;
 *   - the per-endpoint env overrides (`HQ_AI_GATEWAY_URL`, …) match HQ Edge's
 *     keys, so an operator can move one host without a rebuild;
 *   - an invalid selector is NOT fatal here. HQ Edge refuses to boot rather
 *     than run a tester against an unexpected environment; a plugin that did
 *     that would take the whole DSH composition down over one env typo, so it
 *     logs and falls back to `prod`, which is also today's behaviour when
 *     `HQ_AI_ENV` is unset.
 *
 * When HQ Edge IS the host its configured `aiGatewayBaseUrl` /
 * `subscriptionBalancesUrl` / … win (see `resolveHostConfig`), so this table is
 * never consulted in host mode and the two cannot disagree.
 *
 * @module @huaqiu/dsh-auth/gateway
 */

export type AiEnvironment = 'prod' | 'test'

/** One environment's endpoint preset: ONE host plus relative API paths. */
interface AiEndpointPreset {
  readonly baseUrl: string
  readonly subscriptionOrigin: string
  readonly gatewayPath: string
  readonly subscriptionBalancesPath: string
  readonly profilePath: string
}

const AI_PRESETS: Record<AiEnvironment, AiEndpointPreset> = {
  prod: {
    baseUrl: 'https://www.eda.cn',
    subscriptionOrigin: 'https://gen.eda.cn',
    gatewayPath: '/user-rest/ai/v1',
    subscriptionBalancesPath: '/sub-api/subscriptions/balances/current',
    profilePath: '/account/profile',
  },
  test: {
    baseUrl: 'http://www.fdatasheets.com',
    subscriptionOrigin: 'http://gen.fdatasheets.com',
    gatewayPath: '/user-rest/ai/v1',
    subscriptionBalancesPath: '/sub-api/subscriptions/balances/current',
    // TEST serves the account page one level higher than PROD.
    profilePath: '/account',
  },
}

/** The gateway provider / model / credential reference the product ships. */
export const HUAQIU_AI_PROVIDER_ID = 'huaqiu'
export const HUAQIU_AI_MODEL_ID = 'auto-model'
export const HUAQIU_AI_API_KEY_REF = 'HUAQIU_API_KEY'
export const HUAQIU_AI_DISPLAY_NAME = '华秋 AI'

/**
 * Declared capacity and capability of {@link HUAQIU_AI_MODEL_ID}.
 *
 * The gateway is a private OpenAI-compatible route pi-ai's catalog has never
 * heard of, so nothing supplies these: the adapter would fall back to
 * 262,144 / 32,768 tokens and `[text]`, which under-claims a large multimodal
 * route (and refuses every image before it is attached). Same values HQ Edge
 * declares for its injected provider row.
 */
export const HUAQIU_AI_CONTEXT_WINDOW = 1_000_000
export const HUAQIU_AI_MAX_TOKENS = 256_000
export const HUAQIU_AI_INPUT_MODALITIES = ['text', 'image'] as const

/** Env keys — identical to the HQ Edge central-config keys. */
export const AI_ENV_KEYS = {
  selector: 'HQ_AI_ENV',
  gateway: 'HQ_AI_GATEWAY_URL',
  subscriptionBalances: 'HQ_AI_SUBSCRIPTION_BALANCES_URL',
  subscriptionOrigin: 'HQ_AI_SUBSCRIPTION_ORIGIN',
  profile: 'HQ_AI_PROFILE_URL',
} as const

export interface AiEndpoints {
  readonly environment: AiEnvironment
  /** OpenAI-compatible gateway root — never includes `/chat/completions`. */
  readonly gatewayBaseUrl: string
  readonly subscriptionBalancesUrl: string
  readonly subscriptionOrigin: string
  readonly profileUrl: string
}

/** Join a base URL and a relative path with exactly one `/`. */
export function joinEndpointUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  return suffix === '' ? base : `${base}/${suffix}`
}

/**
 * Parse `HQ_AI_ENV`. Absent/blank → `prod`; `test` → `test`; anything else is
 * reported through `onInvalid` and treated as `prod` (see the module note).
 */
export function parseAiEnvironment(
  raw: string | undefined,
  onInvalid?: (value: string) => void,
): AiEnvironment {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'prod') return 'prod'
  if (value === 'test') return 'test'
  onInvalid?.(String(raw))
  return 'prod'
}

function pick(override: string | undefined, fallback: string): string {
  const value = (override ?? '').trim()
  return (value === '' ? fallback : value).replace(/\/+$/, '')
}

/**
 * Resolve the effective AI endpoints for standalone DSH.
 *
 * @param environmentRaw - `HQ_AI_ENV` value (absent → `prod`).
 * @param env - remaining process environment (overrides + diagnostics).
 * @param onInvalid - called when the selector is neither `prod` nor `test`.
 * @returns concrete URLs, ready for the `llm-pi-ai` provider `baseURL`.
 */
export function resolveAiEndpoints(
  environmentRaw: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (value: string) => void,
): AiEndpoints {
  const environment = parseAiEnvironment(environmentRaw, onInvalid)
  const preset = AI_PRESETS[environment]
  return {
    environment,
    gatewayBaseUrl: pick(env[AI_ENV_KEYS.gateway], joinEndpointUrl(preset.baseUrl, preset.gatewayPath)),
    subscriptionBalancesUrl: pick(
      env[AI_ENV_KEYS.subscriptionBalances],
      joinEndpointUrl(preset.baseUrl, preset.subscriptionBalancesPath),
    ),
    subscriptionOrigin: pick(env[AI_ENV_KEYS.subscriptionOrigin], preset.subscriptionOrigin),
    profileUrl: pick(env[AI_ENV_KEYS.profile], joinEndpointUrl(preset.baseUrl, preset.profilePath)),
  }
}

/**
 * The gateway base URLs this module considers ITS OWN — one per environment
 * plus the env-override shape. Used to tell "a baseURL we manage (an earlier
 * boot wrote it)" from "a URL the user typed": only the former is re-pointed
 * when `HQ_AI_ENV` changes between boots.
 */
export function managedGatewayBaseUrls(): string[] {
  return (Object.keys(AI_PRESETS) as AiEnvironment[])
    .map(environment => joinEndpointUrl(AI_PRESETS[environment].baseUrl, AI_PRESETS[environment].gatewayPath))
}

/** host:port only — safe for logs, never a complete URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '<invalid-url>'
  }
}
