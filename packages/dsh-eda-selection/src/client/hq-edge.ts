/**
 * Structural view of the `hqEdge` host service's `selection` face.
 *
 * Declared structurally and NEVER imported from `@hqedge/dsh-edge-bridge`:
 * that package is a DSH host plugin (its root export is a cordis entry), so
 * importing it here would pull a plugin into a plugin. The contract is instead
 * pinned by the edge-bridge's own unit tests, which assert the exact same
 * field names and semantics this interface describes.
 *
 * Both halves of the bridge publish this shape, and both normalise it through
 * the same `normalizeSelectionSnapshot` rules — so a browser-side chip and a
 * node-side prompt provider reading the same snapshot always agree.
 *
 * @module
 */

/** Editor identity, as an enum NAME (never the wire number). */
export type SelectionEditorName = 'UNSPECIFIED' | 'SCHEMATIC' | 'PCB'

/**
 * One selection summary.
 *
 * `revision` is a STRING: protobuf uint64 crosses the HTTP boundary as bigint,
 * and `JSON.stringify` throws on bigint, so hq-edge serialises it as a string.
 */
export interface SelectionSnapshot {
  /** Whether the FOCUSED editor currently has a selection. */
  hasSelection: boolean
  /** Number of selected items. Zero when `hasSelection` is false. */
  itemCount: number
  /** Which editor the selection belongs to. */
  editor: SelectionEditorName
  /**
   * Bounded, display-only labels (reference designators, symbol names, …).
   *
   * Host-truncated to a small fixed count and per-label length. Treat as a
   * PARTIAL view: never infer `itemCount` from `labels.length`, and never
   * claim these are all the selected items.
   */
  labels: string[]
  /** Monotonic per-host revision. Empty before the first published summary. */
  revision: string
}

/** The `selection` face of the `hqEdge` host service. */
export interface HqEdgeSelection {
  /**
   * The latest known selection summary, or `null` when UNKNOWN.
   *
   * `null` means "nothing has been published yet, or the sync failed" — which
   * is deliberately NOT the same thing as a known-empty selection. A consumer
   * must render nothing for either, but must never treat `null` as
   * "definitely nothing selected".
   */
  getCurrent(): SelectionSnapshot | null
  /**
   * Subscribe to selection changes. Fires immediately with the current state
   * when one is already known.
   * @returns a disposer removing exactly this listener.
   */
  onChanged(listener: (selection: SelectionSnapshot | null) => void): () => void
}

/** The slice of the `hqEdge` service this plugin consumes. */
export interface HqEdgeLike {
  selection?: HqEdgeSelection
}

/**
 * Normalize one raw summary into {@link SelectionSnapshot}, or `null` when it
 * carries no usable state.
 *
 * The bridge already normalizes, but this plugin can be pointed at a host
 * service that predates the selection face (or at a hand-rolled test double),
 * so the same defensive rules are applied again here:
 *
 *   - null / undefined / non-object → `null` (unknown)
 *   - `hasSelection` not a boolean → `null` (cannot tell selected from not)
 *   - unknown editor name → `UNSPECIFIED`
 *   - non-string labels are dropped; the array is copied
 *
 * A well-formed `hasSelection: false` is KEPT: that is a known-empty state,
 * and dropping it would erase the distinction the whole design rests on.
 *
 * @param raw - value read from `hqEdge.selection.getCurrent()`.
 * @returns the normalized snapshot, or `null` for unknown/malformed.
 */
export function normalizeSelectionSnapshot(raw: unknown): SelectionSnapshot | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null

  const record = raw as Record<string, unknown>

  if (typeof record.hasSelection !== 'boolean') return null

  const itemCount =
    typeof record.itemCount === 'number' && Number.isFinite(record.itemCount) && record.itemCount > 0
      ? Math.floor(record.itemCount)
      : 0

  const editor = record.editor
  const knownEditor: SelectionEditorName =
    editor === 'SCHEMATIC' || editor === 'PCB' ? editor : 'UNSPECIFIED'

  const labels = Array.isArray(record.labels)
    ? record.labels.filter((label): label is string => typeof label === 'string')
    : []

  const revision =
    typeof record.revision === 'string'
      ? record.revision
      : typeof record.revision === 'number' && Number.isFinite(record.revision)
        ? String(record.revision)
        : ''

  return { hasSelection: record.hasSelection, itemCount, editor: knownEditor, labels, revision }
}

/**
 * Whether a snapshot is worth surfacing at all.
 *
 * Both the chip and the prompt section use this single gate, so the two can
 * never disagree about when the selection "exists". Unknown (`null`) and
 * known-empty both answer "no" — but for different reasons, and the chip keeps
 * them apart internally so a later transition is not swallowed.
 */
export function hasVisibleSelection(snapshot: SelectionSnapshot | null): boolean {
  return snapshot !== null && snapshot.hasSelection && snapshot.itemCount > 0
}
