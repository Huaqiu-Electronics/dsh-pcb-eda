/**
 * Transport for `@huaqiu/dsh-tool-quote`.
 *
 * DSH → dsh-tool-quote → hq-edge → price provider is the ONLY production
 * path. This module POSTs the canonical quote request to the hq-edge quote
 * router, maps the stable error envelope back to semantic kinds, and enforces
 * the single end-to-end request budget. It contains no provider logic — that
 * lives in hq-edge (apps/server/src/quote/*).
 *
 * hq-edge error envelope (stable contract):
 *
 *   { error, detail, code?, status?, operation? }
 *
 *     error   → VALIDATION | UNIMPLEMENTED | UPSTREAM_HTTP | UPSTREAM_REJECTED
 *               | PARSE | UNAVAILABLE | INTERNAL
 *     status  → 400 | 501 | 502 | 503 | 504 | 500
 *
 * @module
 */

import type { QuoteToolConfig } from './config.js'
import { quoteUrlOf } from './config.js'

export type QuoteKind = 'pcb' | 'smt'

export interface QuoteToolClientDeps {
  fetchImpl?: typeof fetch
  /** Late-bound resolver for the HQ Edge base URL (edge-bridge service). */
  baseUrlResolver?: () => string | undefined
}

export interface QuoteToolRequestOptions {
  signal?: AbortSignal
}

/** Semantic failure of a quote request, mirroring hq-edge's envelope kinds. */
export class QuoteToolError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly status: number,
    readonly detail?: string,
    readonly code?: string | number,
  ) {
    super(message)
    this.name = 'QuoteToolError'
  }
}

/** HTTP status → semantic kind (hq-edge envelope, mirrors eda-host mapping). */
function statusToKind(status: number): string {
  if (status === 400) return 'VALIDATION'
  if (status === 501) return 'UNIMPLEMENTED'
  if (status === 503) return 'UNAVAILABLE'
  if (status === 504) return 'DEADLINE_EXCEEDED'
  return 'INTERNAL'
}

function isAbortError(err: unknown): boolean {
  const name = (err as Error | undefined)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function resolveSignal(deadlineMs: number, caller?: AbortSignal): AbortSignal | undefined {
  const budget = deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined
  const signals = [caller, budget].filter((s): s is AbortSignal => Boolean(s))
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  return typeof anyFn === 'function' ? anyFn.call(AbortSignal, signals) : signals[0]
}

export interface QuoteToolClient {
  quotePcb(payload: unknown, options?: QuoteToolRequestOptions): Promise<unknown>
  quoteSmt(payload: unknown, options?: QuoteToolRequestOptions): Promise<unknown>
}

export function createQuoteToolClient(
  config: QuoteToolConfig,
  deps: QuoteToolClientDeps = {},
): QuoteToolClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch

  const resolveBaseUrl = (): string => {
    const fromService = deps.baseUrlResolver?.()
    const base = fromService?.trim().length ? fromService : config.hqEdgeBaseUrl
    if (!base || base.trim().length === 0) {
      throw new QuoteToolError(
        'FAILED_PRECONDITION',
        'quote: no hq-edge base URL available (edge-bridge service or HQ_EDGE_BASE_URL)',
        412,
      )
    }
    return base.trim()
  }

  const request = async (
    kind: QuoteKind,
    payload: unknown,
    options: QuoteToolRequestOptions = {},
  ): Promise<unknown> => {
    const base = resolveBaseUrl()
    const url = quoteUrlOf({ ...config, hqEdgeBaseUrl: base }, kind)
    const signal = resolveSignal(config.requestTimeoutMs ?? 0, options.signal)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
      const text = await response.text()
      let body: unknown
      try {
        body = text.length > 0 ? JSON.parse(text) : null
      } catch {
        body = null
      }
      if (!response.ok) {
        const envelope =
          body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {}
        const kindFromEnvelope =
          typeof envelope.error === 'string' ? envelope.error : statusToKind(response.status)
        throw new QuoteToolError(
          kindFromEnvelope,
          typeof envelope.detail === 'string' ? envelope.detail : 'quote request failed',
          response.status,
          typeof envelope.detail === 'string' ? envelope.detail : undefined,
          typeof envelope.code === 'string' || typeof envelope.code === 'number'
            ? envelope.code
            : undefined,
        )
      }
      return body
    } catch (err) {
      if (err instanceof QuoteToolError) throw err
      if (isAbortError(err)) {
        throw new QuoteToolError(
          'DEADLINE_EXCEEDED',
          'quote request timed out',
          504,
        )
      }
      throw new QuoteToolError('INTERNAL', `quote request failed: ${String(err)}`, 500)
    }
  }

  return {
    quotePcb: (payload, options) => request('pcb', payload, options),
    quoteSmt: (payload, options) => request('smt', payload, options),
  }
}
