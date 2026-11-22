/**
 * `@huaqiu/dsh-eda-selection` — node half.
 *
 * Registers ONE dynamic system-prompt section, `eda:selection`, that reports
 * the focused editor's selection to the agent. Nothing else: no tools, no
 * routes, no I/O.
 *
 * ── Why a section and not a context ─────────────────────────────────────────
 * A *section* is part of the system prompt (stable policy text); a *context* is
 * materialized as a durable user-role snapshot. The selection summary is
 * neither — it is ambient state that changes between turns and must not be
 * persisted into the conversation history as if the user had said it. A
 * section whose provider re-evaluates at each assembly is exactly that.
 *
 * ── Why the provider performs no I/O ────────────────────────────────────────
 * The provider reads an in-memory snapshot — `selection.getCurrent()` on the
 * optional `hqEdge` service when an HQ Edge bridge is present; nothing at all
 * otherwise. That value is kept fresh by whoever owns the bridge's own
 * `/runtime/dsh` poll. Prompt assembly happens on the agent's hot path, so an
 * HTTP call here would add latency to every turn and could fail; a
 * stale-but-free read is strictly better than a fresh blocking one. When the
 * value is unknown the section contributes NOTHING.
 *
 * ── What the section must not do ────────────────────────────────────────────
 * It must not imply that selection CONTENT was inserted into the conversation.
 * The summary is a count, an editor identity and a bounded label list — enough
 * to decide whether the existing selection tools are worth calling, never a
 * substitute for calling them.
 *
 * @module @huaqiu/dsh-eda-selection
 */
import {
  EDA_SELECTION_SECTION,
  EDA_SELECTION_SECTION_ORDER,
  edaSelectionSectionText,
  registerEdaSelectionSection,
  type SystemPromptLike,
} from './prompt.js'
import { normalizeSelectionSnapshot, type HqEdgeLike } from './client/hq-edge.js'
import { getLogger } from '@huaqiu/dsh-plugin-log'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-eda-selection'

/**
 * Cordis services this half depends on.
 *
 * `systemPrompt` carries the section — REQUIRED, because without it this plugin
 * has nothing to do.
 *
 * `hqEdge` is deliberately NOT injected. It is a *data source*, not a
 * precondition: the section is one of eleven rows in the Hardware Engineering
 * bundle, and declaring `hqEdge` here used to park the entry in `pending`
 * forever on any runtime without an edge bridge. Every read is already guarded,
 * so the section simply contributes nothing when no selection source exists —
 * which is the correct behaviour rather than a missing plugin.
 */
export const inject = ['systemPrompt'] as const

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-eda-selection'
const log = getLogger(COMPONENT)

/** Host plugin body — register the dynamic selection section. */
export function apply(ctx: {
  systemPrompt?: SystemPromptLike
  /** Present on a real DSH context; absent in the structural test harness. */
  get?: (service: string) => unknown
  /** Back-compat for callers that hand the service over directly. */
  hqEdge?: HqEdgeLike
}): () => void {
  // Lazy, never captured once: the selection source is a live object, and the
  // service may be provided after this fiber activates.
  const readSelection = (): ReturnType<typeof normalizeSelectionSnapshot> => {
    try {
      const edge = (typeof ctx.get === 'function' ? ctx.get('hqEdge') : ctx.hqEdge) as
        | HqEdgeLike
        | undefined
      if (!edge || !edge.selection || typeof edge.selection.getCurrent !== 'function') return null
      return normalizeSelectionSnapshot(edge.selection.getCurrent())
    } catch {
      return null
    }
  }

  const dispose = registerEdaSelectionSection(ctx.systemPrompt, readSelection)

  if (dispose === undefined) {
    log.warn('systemPrompt service unavailable — the selection prompt section was not registered')
  } else if (readSelection() === null) {
    log.info('no EDA selection source — the section stays empty until one is provided')
  }

  return () => {
    dispose?.()
  }
}

export {
  EDA_SELECTION_SECTION,
  EDA_SELECTION_SECTION_ORDER,
  edaSelectionSectionText,
  registerEdaSelectionSection,
  type SystemPromptLike,
}
