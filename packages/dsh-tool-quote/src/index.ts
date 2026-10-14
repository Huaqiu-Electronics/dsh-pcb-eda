/**
 * Huaqiu EDA Quote DSH tool plugin (node half) — `@huaqiu/dsh-tool-quote`.
 *
 * Exposes real-time PCB / SMT price querying as two agent-visible tools:
 *
 *   quote_pcb   → hq-edge POST /api/v1/quote/pcb
 *   quote_smt   → hq-edge POST /api/v1/quote/smt
 *
 * ── Architectural boundary ─────────────────────────────────────────────────
 * Quote logic is owned ONCE by hq-edge (hq.fab.v1.QuoteService bridged over
 * HTTP — apps/server/src/quote/*). This plugin is a thin adapter: it
 * translates tool calls into canonical quote requests and returns the
 * normalized QuotePrice. It contains NO provider logic (no eda.cn / nextpcb
 * endpoints, no form serialization, no parsing) and no `@hqedge/*`
 * dependency — it only talks to hq-edge through the edge-bridge.
 *
 * `hqEdge` is a REQUIRED inject: the plugin cannot reach hq-edge without the
 * bridge's `ctx.hqEdge.baseUrl`. This matches the `@huaqiu/dsh-eda-host`
 * contract (docs/tasks/expose-capability.md §3/§7) — quote tools are hq-edge
 * capabilities, not standalone DSH features.
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

/** Cordis services this half depends on: the node tool registry + hq-edge
 *  bridge (REQUIRED — quote cannot work standalone). */
export const inject = ['hqEdge', 'tools'] as const

export type { QuoteToolConfig } from './config.js'
export { QuoteToolError } from './client.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Provided by the hq-edge `edge-bridge` plugin (the HOST). `baseUrl` is
     * the loopback HQ Edge endpoint, e.g. "http://localhost:18080". Read
     * lazily on every request; REQUIRED for this plugin to load.
     */
    hqEdge: { baseUrl?: string }
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
 * Host plugin body — register the two quote tools.
 *
 * The HQ Edge endpoint is resolved lazily at request time from the
 * `ctx.hqEdge` service (edge-bridge), falling back to the overlay config /
 * `HQ_EDGE_BASE_URL` env (same convention as `@huaqiu/dsh-eda-host`).
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters the tools on plugin dispose.
 */
export function apply(ctx: Context, config: Partial<QuoteToolConfig> = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-tool-quote requires the DSH `tools` service (ctx.tools.register).')
  }

  const resolved = resolveQuoteToolConfig(config)

  const hq = ctx.hqEdge
  if (!hq || typeof hq.baseUrl !== 'string' || hq.baseUrl.trim().length === 0) {
    throw new Error(
      '@huaqiu/dsh-tool-quote requires a usable hq-edge context: the edge-bridge ' +
        'plugin did not provide ctx.hqEdge.baseUrl. Quote tools cannot work without ' +
        'hq-edge — check that the bridge started and that the HQ Edge port is valid.',
    )
  }

  const getHqEdgeBaseUrl = (): string | undefined => {
    const current = ctx.hqEdge
    return current?.baseUrl && current.baseUrl.trim().length > 0 ? current.baseUrl : undefined
  }

  log().info('applying dsh-tool-quote node half', {
    hasConfigHost: hasHost(resolved),
    hqEdgeBaseUrlFromConfig: resolved.hqEdgeBaseUrl ?? null,
    quotePathPrefix: resolved.quotePathPrefix,
    requestTimeoutMs: resolved.requestTimeoutMs,
  })

  const client = createQuoteToolClient(resolved, { baseUrlResolver: getHqEdgeBaseUrl })
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
