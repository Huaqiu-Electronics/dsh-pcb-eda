/**
 * The `eda:selection` system-prompt section.
 *
 * Split out from `src/index.ts` so the text builder is unit-testable without a
 * cordis context, a bridge, or a prompt registry — the same call
 * `@huaqiu/dsh-tool-schematic-gen` makes for its `prompt.ts`.
 *
 * @module
 */
import type { SelectionSnapshot } from './client/hq-edge.js'

/** Unique prompt-section name. */
export const EDA_SELECTION_SECTION = 'eda:selection'

/**
 * Centrally allocated placement: 590, between DSH's `PLAN_POLICY` (500) and
 * `TEAM_POLICY` (600).
 *
 * That is where the sibling Huaqiu tool-policy section
 * (`huaqiu:schematic-gen`) already sits, so both Huaqiu policy blocks are
 * adjacent and both precede the tool-list sections (`TOOL_*` at 1000+) they
 * refer to. `ctx.systemPrompt.getSectionOrder()` only resolves DSH's own named
 * positions, so the number is pinned here and asserted by a test.
 */
export const EDA_SELECTION_SECTION_ORDER = 590

/**
 * Structural view of `ctx.systemPrompt` — only the face we use.
 *
 * `text` accepts a provider, which the registry re-evaluates at every
 * assembly with that assembly's `AssembleContext`. Returning `''` contributes
 * nothing: `renderPrompt` filters empty sections out before joining.
 */
export interface SystemPromptLike {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
  }): () => void
}

/** Editor display name for the prompt (English: the prompt is model-facing). */
function editorName(editor: SelectionSnapshot['editor']): string {
  switch (editor) {
    case 'PCB':
      return 'PCB (pcbnew)'
    case 'SCHEMATIC':
      return 'schematic (eeschema)'
    default:
      return 'an unidentified editor'
  }
}

/** How many labels the section may quote. The host already bounds the list. */
export const MAX_SECTION_LABELS = 5

/**
 * Build the section text for one snapshot.
 *
 * Returns `''` for every "contribute nothing" case — an unknown state
 * (`null`) or a known-empty selection. One gate for both, so the section and
 * the browser chip can never disagree about when the selection exists.
 *
 * @param snapshot - the current summary, or `null` when unknown.
 * @returns the section text, or `''` when it must contribute nothing.
 */
export function edaSelectionSectionText(snapshot: SelectionSnapshot | null): string {
  if (snapshot === null || !snapshot.hasSelection || snapshot.itemCount <= 0) return ''

  const lines: string[] = [
    'Current EDA selection (Huaqiu EDA host):',
    `- The focused editor is ${editorName(snapshot.editor)}.`,
    `- It currently has ${snapshot.itemCount} selected item(s).`,
  ]

  const labels = snapshot.labels.slice(0, MAX_SECTION_LABELS)
  if (labels.length > 0) {
    lines.push(`- Selected labels (partial, host-truncated): ${labels.join(', ')}.`)
  }

  lines.push(
    '- This is a SUMMARY only. The selected items themselves are NOT in this ' +
      'conversation — call the existing selection tools (`get_pcb_selection`, ' +
      '`get_selection_netlist`) when you need the actual entities, nets or ' +
      'netlist. Never claim to know the selected content without calling them.',
  )

  return lines.join('\n')
}

/**
 * Register the dynamic selection section.
 *
 * Never throws: a DSH deployment without the prompt service, or one where a
 * duplicate registration races, must still load. A duplicate is the expected
 * hot-reload case, so it is swallowed rather than surfaced.
 *
 * @param systemPrompt - `ctx.systemPrompt`, or undefined.
 * @param readSelection - reads the current summary. Must not perform I/O.
 * @returns the section's disposer, or `undefined` when nothing was registered.
 */
export function registerEdaSelectionSection(
  systemPrompt: unknown,
  readSelection: () => SelectionSnapshot | null,
): (() => void) | undefined {
  if (
    systemPrompt === undefined || systemPrompt === null ||
    typeof (systemPrompt as SystemPromptLike).section !== 'function'
  ) {
    return undefined
  }

  try {
    const dispose = (systemPrompt as SystemPromptLike).section({
      name: EDA_SELECTION_SECTION,
      order: EDA_SELECTION_SECTION_ORDER,
      // A provider, not a constant: the selection changes between turns and the
      // registry re-evaluates this at every assembly. It performs NO I/O — it
      // reads the bridge's in-memory cache.
      text: () => edaSelectionSectionText(readSelection()),
    })
    return typeof dispose === 'function' ? dispose : undefined
  } catch {
    // Duplicate registration (hot reload) — the first one is still live.
    return undefined
  }
}
