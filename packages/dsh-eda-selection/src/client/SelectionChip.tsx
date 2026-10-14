/**
 * The ambient `Current selection` chip — the browser half's only visible
 * surface.
 *
 * It is a passive indicator: it renders what the host published and nothing
 * else. There is no click action (the agent reaches the real selection through
 * the existing EDA tools), no expand affordance, and no per-item type claim.
 *
 * ── When it renders ─────────────────────────────────────────────────────────
 * Only for a snapshot with `hasSelection && itemCount > 0`. Both UNKNOWN
 * (`null` — nothing published yet, or the sync failed) and KNOWN-EMPTY
 * (`hasSelection: false` with a real revision) render NOTHING. Rendering
 * either of them would put a chip on screen that the host does not back.
 *
 * @module
 */
import { createElement, type CSSProperties, type ReactElement } from 'react'
import type { SelectionSnapshot } from './hq-edge.js'
import {
  formatSelectionChip,
  selectionChipAriaLabel,
  type Translate,
} from './chip-text.js'

/**
 * The dock seat — the geometry that makes the chip line up with the input
 * card.
 *
 * DSH renders every `conversation.input.dock` entry as a full-bleed child of
 * `.composerStack`, while the input card itself is inset by the shared
 * composer clearance and capped at the card max width (InputBar `.root` pads
 * `--dsh-composer-side-clearance` on both sides; `.card` caps at
 * `--dsh-composer-card-max-width`). A bare `alignSelf: flex-start` child
 * therefore hugs the COLUMN edge — visually `side-clearance` (16px) left of
 * the input card it describes.
 *
 * This seat reproduces the card's own box: same clearance subtraction, same
 * max-width cap, centered — the exact geometry the shipped dock entries
 * (QueueDock `.dock`, TodoPanel `.root`) derive from the same variables. The
 * fallbacks mirror DSH's defaults so a foreign host gets a sane inset instead
 * of an unstyled flush-left pill.
 */
const DOCK_SEAT: CSSProperties = {
  boxSizing: 'border-box',
  flex: 'none',
  display: 'flex',
  justifyContent: 'flex-start',
  minWidth: 0,
  width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) * 2)',
  maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
  margin: '0 auto',
}

const ROOT: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  // The seat owns the horizontal geometry; the chip is only as wide as its
  // text so it reads as an ambient tag rather than a toolbar.
  maxWidth: '100%',
  padding: '3px 10px',
  borderRadius: 999,
  boxSizing: 'border-box',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)',
}

/** The leading dot — the only ornament, and it carries no meaning. */
const DOT: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  flex: '0 0 auto',
  background: 'var(--dsw-alias-state-success, #34c759)',
}

const TEXT: CSSProperties = {
  // One line, ellipsised. The label list is host-bounded and already short.
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export interface SelectionChipProps {
  /** The latest snapshot, or `null` when the state is unknown. */
  snapshot: SelectionSnapshot | null
  /** Bound dictionary (the entry's locale seat). */
  t: Translate
}

/**
 * Render the chip, or `null` when there is nothing grounded to show.
 *
 * Returning `null` (rather than an empty fragment) lets the dock skip the row
 * entirely, so an absent selection costs no vertical space in the composer.
 */
export function SelectionChip({ snapshot, t }: SelectionChipProps): ReactElement | null {
  const text = formatSelectionChip(snapshot, t)

  if (text.length === 0) return null

  const aria = selectionChipAriaLabel(snapshot, t)

  return createElement(
    'div',
    {
      style: DOCK_SEAT,
      'data-dsh-part': 'selection-chip-dock',
    },
    createElement(
      'div',
      {
        style: ROOT,
        // `data-*` markers so the entry can be identified in tests and by the
        // host's own diagnostics without depending on the copy.
        'data-dsh-plugin': 'huaqiu-eda-selection',
        'data-dsh-part': 'selection-chip',
        'data-editor': snapshot?.editor ?? 'UNSPECIFIED',
        'data-revision': snapshot?.revision ?? '',
        role: 'status',
        'aria-label': aria.length > 0 ? aria : undefined,
      },
      createElement('span', { style: DOT, 'aria-hidden': true }),
      createElement('span', { style: TEXT }, text),
    ),
  )
}
