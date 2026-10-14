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
 * The provider reads `hqEdge.selection.getCurrent()` — an in-memory value the
 * bridge keeps fresh from its own `/runtime/dsh` poll. Prompt assembly happens
 * on the agent's hot path, so an HTTP call here would add latency to every
 * turn and could fail; a stale-but-free read is strictly better than a fresh
 * blocking one. When the value is unknown the section contributes NOTHING.
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
 * `hqEdge` is the bridge's node-side twin. It is declared here so DSH holds
 * this plugin until the bridge has provided it, and every read is still
 * guarded: a standalone DSH deployment without the bridge must not fail.
 *
 * `systemPrompt` carries the section. Declared for the same reason.
 */
export const inject = ['hqEdge', 'systemPrompt'] as const

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-eda-selection'
const log = getLogger(COMPONENT)

/** Host plugin body — register the dynamic selection section. */
export function apply(ctx: {
  hqEdge?: HqEdgeLike
  systemPrompt?: SystemPromptLike
}): () => void {
  // Lazy, never captured once: the bridge's `selection` face is a live object,
  // but reading it lazily keeps this plugin working if the service is swapped.
  const readSelection = (): ReturnType<typeof normalizeSelectionSnapshot> => {
    try {
      const edge = ctx.hqEdge
      if (!edge || !edge.selection || typeof edge.selection.getCurrent !== 'function') return null
      return normalizeSelectionSnapshot(edge.selection.getCurrent())
    } catch {
      return null
    }
  }

  const dispose = registerEdaSelectionSection(ctx.systemPrompt, readSelection)

  if (dispose === undefined) {
    log.warn('systemPrompt service unavailable — the selection prompt section was not registered')
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
