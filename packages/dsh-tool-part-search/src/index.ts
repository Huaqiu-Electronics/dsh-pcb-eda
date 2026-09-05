/**
 * Huaqiu EDA Part Search DSH tool plugin (node half) — `@huaqiu/dsh-tool-part-search`.
 *
 * Exposes the Huaqiu public part-search capability as four agent-visible tools:
 *
 *   search_hqsch_parts        → PartSearchService.searchParts
 *   get_hqsch_part            → PartSearchService.getPart
 *   get_hqsch_part_models     → PartSearchService.getEdaModels
 *   get_hqsch_supply_chain    → PartSearchService.getSupplyChain
 *
 * ── Architectural boundary (migration plan §1/§8/§20) ───────────────────────
 * Phase 1 makes this the first published DSH plugin and the smallest vertical
 * slice: package.json → cordis.patch.yml → plugin loading → ctx.tools →
 * defineTool → npm publish → stock DSH install → tool invocation. The Huaqiu
 * integration is owned exactly once by the `@huaqiu/part-search` library; this
 * plugin calls that library directly (no HQ Edge, no HTTP proxy, no
 * `@hqedge/*` dependency).
 *
 * ── Why no client half ───────────────────────────────────────────────────────
 * Part search is a node-only capability: it returns JSON, never renders UI.
 * `inject = ['tools']` resolves the DSH node tool registry.
 *
 * @module @huaqiu/dsh-tool-part-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { createPartSearch } from './service.js'
import { createPartSearchTools } from './tools.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-tool-part-search'

/** Cordis services this half depends on: the DSH node tool registry. */
export const inject = ['tools'] as const

/** Console tag for filtering in logs. */
const LOG_TAG = '[dsh-part-search]'

function disposeTools(disposers: readonly (() => void)[]): void {
  for (const disposeTool of disposers) {
    try {
      disposeTool()
    } catch {
      // One failing unregister must not hide the others.
    }
  }
}

/**
 * Host plugin body — register the four agent-visible part-search tools.
 *
 * A single shared `PartSearchService` instance is created per plugin so every
 * tool reuses the same client (and test/stub injection point).
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters all four tools on plugin dispose. No
 *   duplicate tools can survive a reload.
 */
export function apply(ctx: Context): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-tool-part-search requires the DSH `tools` service (ctx.tools.register).')
  }

  const service = createPartSearch()
  const disposers: Array<() => void> = []
  try {
    for (const tool of createPartSearchTools(service)) {
      disposers.push(ctx.tools.register(tool))
    }
  } catch (error) {
    disposeTools(disposers)
    throw error
  }

  // eslint-disable-next-line no-console
  console.log(LOG_TAG, 'registered agent tools', { tools: disposers.length })

  return function dispose() {
    disposeTools(disposers)
  }
}
