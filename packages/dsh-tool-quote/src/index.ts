/**
 * Huaqiu EDA Quote DSH tool plugin (node half) — `@huaqiu/dsh-tool-quote`.
 *
 * Exposes real-time PCB / SMT price querying as two agent-visible tools:
 *
 *   quote_pcb   → hq-edge POST /api/v1/quote/pcb
 *   quote_smt   → hq-edge POST /api/v1/quote/smt
 *
 * ── Architectural boundary ─────────────────────────────────────────────────
 * Quote logic is owned ONCE by the quote service (hq.fab.v1.QuoteService joined
 * to an HTTP router — apps/server/src/quote/*). This plugin is a thin adapter:
 * it translates tool calls into canonical quote requests and returns the
 * normalized QuotePrice. It contains NO provider logic (no eda.cn / nextpcb
 * endpoints, no form serialization, no parsing).
 *
 * ── Why `hqEdge` is NOT in `inject` ────────────────────────────────────────
 * A quote backend is a *capability*, not a precondition for the plugin to
 * exist. Declaring `hqEdge` here parked the whole fiber in `pending` on any
 * runtime that has no edge bridge, so the four tools did not exist at all and
 * the bundle containing them silently degraded. Instead:
 *
 *   - the plugin activates with `tools` alone and always registers its tools;
 *   - the base URL is resolved lazily per call — service first (`ctx.get`,
 *     so an HQ Edge host can still supply it), then config, then env;
 *   - a call with no backend fails with a `FAILED_PRECONDITION` `QuoteToolError`
 *     (status 412) naming the missing piece, i.e. an actionable per-tool error
 *     rather than a missing tool.
 *
 * That keeps part search, schematic review, PCB preview and BOM generation
 * usable in a deployment with no quote service, while quote itself reports
 * precisely why it cannot answer.
 *
 * @module @huaqiu/dsh-tool-quote
 */

import type { Context } from '@deepseek-ai/cordis'
import { getLogger, type PluginLogger } from '@huaqiu/dsh-plugin-log'
import { createQuoteToolClient } from './client.js'
import {
  hasHost,
  resolveQuoteToolConfig,
  type QuoteToolConfig,
} from './config.js'
import { createQuoteTools } from './tools.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-tool-quote'

/** Cordis services this half depends on: only the node tool registry.
 *
 *  A quote *backend* is not a Cordis dependency — it is an optional capability
 *  resolved per call (see the module docstring). */
export const inject = ['tools'] as const

export type { QuoteToolConfig } from './config.js'
export { QuoteToolError } from './client.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * OPTIONAL. Provided by an HQ Edge `edge-bridge` plugin when that host is
     * present; `baseUrl` is then the loopback HQ Edge endpoint, e.g.
     * "http://localhost:18080". Always read through `ctx.get('hqEdge')` — the
     * service is not injected, so a direct `ctx.hqEdge` access would throw.
     */
    hqEdge?: { baseUrl?: string }
  }
}

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-tool-quote'

let _log: PluginLogger | null = null
function log(): PluginLogger {
  if (_log === null) _log = getLogger(COMPONENT)
  return _log
}

/**
 * Host plugin body — register the four quote tools.
 *
 * Activation never depends on a quote backend. The endpoint is resolved lazily
 * at request time: the optional `hqEdge` service first (when an HQ Edge host is
 * present), then overlay config, then `HQ_EDGE_BASE_URL`. When none is
 * available the tools stay registered and each call fails with a
 * `FAILED_PRECONDITION` tool error naming the missing configuration.
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters the tools on plugin dispose.
 */
export function apply(ctx: Context, config: Partial<QuoteToolConfig> = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-tool-quote requires the DSH `tools` service (ctx.tools.register).')
  }

  const resolved = resolveQuoteToolConfig(config)

  const getQuoteServiceBaseUrl = (): string | undefined => {
    // `hqEdge` is not injected, so read it through `ctx.get` — a direct
    // `ctx.hqEdge` access throws on a runtime that never provided the service.
    const service = ctx.get('hqEdge') as { baseUrl?: string } | undefined
    const fromService = service?.baseUrl
    if (typeof fromService === 'string' && fromService.trim().length > 0) return fromService
    return undefined
  }

  log().info('applying dsh-tool-quote node half', {
    hasConfiguredHost: hasHost(resolved),
    configuredBaseUrl: resolved.hqEdgeBaseUrl ?? null,
    quotePathPrefix: resolved.quotePathPrefix,
    requestTimeoutMs: resolved.requestTimeoutMs,
  })

  if (!hasHost(resolved) && getQuoteServiceBaseUrl() === undefined) {
    log().warn(
      'no quote service configured — quote_pcb/quote_smt/place_*_order will report ' +
        'FAILED_PRECONDITION until hqEdge is provided or HQ_EDGE_BASE_URL / ' +
        'HUAQIU_QUOTE_BASE_URL is set',
    )
  }

  const client = createQuoteToolClient(resolved, { baseUrlResolver: getQuoteServiceBaseUrl })
  const disposers = createQuoteTools({ client }).map((tool) => ctx.tools.register(tool))

  log().info('dsh-tool-quote node half ready', { tools: disposers.length })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // best-effort teardown
      }
    }
  }
}
