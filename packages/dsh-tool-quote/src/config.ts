/**
 * Runtime config resolution for `@huaqiu/dsh-tool-quote`.
 *
 * The plugin never opens a direct connection to the price providers — it only
 * talks to `hq-edge`, which owns the quote capability (hq.fab.v1.QuoteService
 * bridged over HTTP, see apps/server/src/routes/quote.ts on hq-edge). The base
 * URL is delivered by the hq-edge supervisor as overlay config
 * (`hqEdgeBaseUrl`), with `HQ_EDGE_BASE_URL` as env fallback — the same
 * convention as `@huaqiu/dsh-eda-host` / `@huaqiu/dsh-auth`.
 *
 * @module
 */

export interface QuoteToolConfig {
  /** HQ Edge base URL, e.g. "http://localhost:18080". Absent → no host. */
  hqEdgeBaseUrl?: string
  /** Path prefix on the host; default "/api/v1/quote". */
  quotePathPrefix?: string
  /** End-to-end budget for one quote request, in milliseconds (default 30_000). */
  requestTimeoutMs?: number
}

export const DEFAULT_QUOTE_PATH_PREFIX = '/api/v1/quote'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export function resolveQuoteToolConfig(
  config?: Partial<QuoteToolConfig> | null,
  env: NodeJS.ProcessEnv = process.env,
): QuoteToolConfig {
  const baseUrl = config?.hqEdgeBaseUrl ?? env.HQ_EDGE_BASE_URL ?? ''
  const pathPrefix =
    config?.quotePathPrefix ?? env.HQ_EDGE_QUOTE_PATH ?? DEFAULT_QUOTE_PATH_PREFIX
  const timeoutRaw = config?.requestTimeoutMs ?? env.HQ_EDGE_REQUEST_TIMEOUT_MS
  const timeout = Number.parseInt(String(timeoutRaw ?? ''), 10)
  return {
    hqEdgeBaseUrl: baseUrl,
    quotePathPrefix: pathPrefix,
    requestTimeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_REQUEST_TIMEOUT_MS,
  }
}

/** True when a host base URL is available (host mode). */
export function hasHost(config: QuoteToolConfig): boolean {
  return typeof config.hqEdgeBaseUrl === 'string' && config.hqEdgeBaseUrl.trim().length > 0
}

/** Build the absolute URL for one quote kind route ("pcb" | "smt"). */
export function quoteUrlOf(config: QuoteToolConfig, kind: 'pcb' | 'smt'): string {
  const base = (config.hqEdgeBaseUrl ?? '').replace(/\/+$/, '')
  const prefix = (config.quotePathPrefix ?? DEFAULT_QUOTE_PATH_PREFIX).replace(
    /^\/+|\/+$/g,
    '',
  )
  return `${base}/${prefix}/${kind}`
}

/** Build the absolute URL for a place-order trigger route ("pcb" | "smt"). */
export function placeOrderUrlOf(config: QuoteToolConfig, kind: 'pcb' | 'smt'): string {
  const base = (config.hqEdgeBaseUrl ?? '').replace(/\/+$/, '')
  const prefix = (config.quotePathPrefix ?? DEFAULT_QUOTE_PATH_PREFIX).replace(
    /^\/+|\/+$/g,
    '',
  )
  return `${base}/${prefix}/place/${kind}`
}
