/**
 * Pure label formatting for the ambient `Current selection` chip.
 *
 * Deliberately free of React and of the cordis context so the text the user
 * reads is unit-testable on its own — the same call
 * `@huaqiu/dsh-tool-symbol-footprint` makes for its sidebar copy.
 *
 * ── Grounding rule ──────────────────────────────────────────────────────────
 * The chip may only state what the host actually reported:
 *
 *   - the item COUNT (`item_count`) — never inferred from `labels.length`,
 *     because the host truncates the label list to a small bound;
 *   - the editor identity (`editor`), and only when it is one we model;
 *   - a BOUNDED label list, explicitly introduced as a partial view.
 *
 * Anything else — "the selected footprint", "net N$12", a guessed type — would
 * be a claim the summary does not support, and the agent has the real entity
 * ids one tool call away.
 *
 * @module
 */
import type { SelectionEditorName, SelectionSnapshot } from './hq-edge.js'

/** Translation function shape (the locale service's `bind` result). */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Fallback translator: the key itself, so a missing dictionary is never blank. */
export const identityTranslate: Translate = (key) => key

/** Editor display name for one editor identity. */
export function editorLabel(
  editor: SelectionEditorName,
  t: Translate = identityTranslate,
): string {
  switch (editor) {
    case 'PCB':
      return t('editor.pcb')
    case 'SCHEMATIC':
      return t('editor.schematic')
    default:
      return t('editor.unspecified')
  }
}

/**
 * `"{count} items"` with the singular form honoured for one item.
 *
 * Both languages ship a dedicated singular key, so English reads "1 item"
 * rather than "1 items".
 */
export function itemCountLabel(count: number, t: Translate = identityTranslate): string {
  return count === 1 ? t('chip.item') : t('chip.items', { count })
}

/**
 * How many labels the chip may append after the count.
 *
 * The host already bounds the list (8 entries × 64 chars), but the chip is one
 * line of ambient UI, so it shows fewer than the host is willing to send.
 */
export const MAX_CHIP_LABELS = 3

/**
 * The bounded, comma-joined label suffix, or `''` when there is nothing to show.
 *
 * The separator is a plain comma plus a space rather than a locale-specific
 * list separator: the chip is a compact ambient indicator, and the host's
 * labels are identifiers (R1, U3, …) that read the same in both languages.
 */
export function labelSuffix(labels: readonly string[]): string {
  return labels.slice(0, MAX_CHIP_LABELS).join(', ')
}

/**
 * The full chip text, e.g. `Current selection · 3 items (PCB): R1, R2, R3`.
 *
 * Returns `''` for anything that must NOT be rendered — an unknown state
 * (`null`) or a known-empty selection. One gate for both, so the chip and the
 * prompt section can never disagree about when the selection exists.
 */
export function formatSelectionChip(
  snapshot: SelectionSnapshot | null,
  t: Translate = identityTranslate,
): string {
  if (snapshot === null || !snapshot.hasSelection || snapshot.itemCount <= 0) return ''

  const parts: string[] = [t('chip.label'), t('chip.sep'), itemCountLabel(snapshot.itemCount, t)]

  // The editor is parenthesised only when it is one we model; UNSPECIFIED
  // means the host has not identified a focused editor, and "(editor)" would
  // be noise.
  if (snapshot.editor !== 'UNSPECIFIED') {
    parts.push(`(${editorLabel(snapshot.editor, t)})`)
  }

  const labels = labelSuffix(snapshot.labels)

  // Appended WITHOUT a joining space: the separator lives inside the localized
  // string (`': {labels}'`), and a space before a colon reads wrong in both
  // languages.
  return labels.length > 0 ? `${parts.join(' ')}${t('chip.labels', { labels })}` : parts.join(' ')
}

/** Screen-reader label for the chip. */
export function selectionChipAriaLabel(
  snapshot: SelectionSnapshot | null,
  t: Translate = identityTranslate,
): string {
  if (snapshot === null || !snapshot.hasSelection || snapshot.itemCount <= 0) return ''
  return t('chip.aria', { count: snapshot.itemCount })
}
