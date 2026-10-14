/**
 * Unit tests for the shared selection contract of `@huaqiu/dsh-eda-selection`
 * (task dsh-composer-integration-for-selection-and-sch-gen.md §4.5/§4.6).
 *
 * These cover the pieces both halves depend on and that are pure enough to
 * test without React or a cordis context:
 *
 *   - `normalizeSelectionSnapshot` — the defensive re-normalization the plugin
 *     applies on top of the bridge's own, so an older bridge or a hand-rolled
 *     double cannot put a malformed shape on screen.
 *   - `hasVisibleSelection` — the single gate the chip and the prompt section
 *     share, so the two can never disagree about when the selection exists.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeSelectionSnapshot,
  hasVisibleSelection,
  type SelectionSnapshot,
} from '../src/client/hq-edge.js'

describe('normalizeSelectionSnapshot — defensive re-normalization', () => {
  it('returns null for unknown state', () => {
    expect(normalizeSelectionSnapshot(null)).toBeNull()
    expect(normalizeSelectionSnapshot(undefined)).toBeNull()
  })

  it('keeps a well-formed populated selection', () => {
    const view = normalizeSelectionSnapshot({
      hasSelection: true,
      itemCount: 3,
      editor: 'SCHEMATIC',
      labels: ['R1', 'R2', 'R3'],
      revision: '41',
    })
    expect(view).toEqual({
      hasSelection: true,
      itemCount: 3,
      editor: 'SCHEMATIC',
      labels: ['R1', 'R2', 'R3'],
      revision: '41',
    })
  });

  it('keeps a well-formed known-empty selection (distinct from unknown)', () => {
    const view = normalizeSelectionSnapshot({
      hasSelection: false,
      itemCount: 0,
      editor: 'PCB',
      labels: [],
      revision: '12',
    })
    expect(view).not.toBeNull()
    expect(view!.hasSelection).toBe(false)
    expect(view!.revision).toBe('12')
  });

  it('rejects a payload whose hasSelection is not a boolean', () => {
    expect(normalizeSelectionSnapshot({ itemCount: 2, revision: '1' })).toBeNull()
    expect(normalizeSelectionSnapshot({ hasSelection: 'true', revision: '1' })).toBeNull()
    expect(normalizeSelectionSnapshot({ hasSelection: 1, revision: '1' })).toBeNull()
  });

  it('rejects non-objects and arrays', () => {
    expect(normalizeSelectionSnapshot('selection')).toBeNull()
    expect(normalizeSelectionSnapshot([])).toBeNull()
    expect(normalizeSelectionSnapshot(42)).toBeNull()
  });

  it('degrades an unknown editor name to UNSPECIFIED', () => {
    const view = normalizeSelectionSnapshot({
      hasSelection: true,
      itemCount: 1,
      editor: 'gerber',
      labels: [],
      revision: '7',
    })
    expect(view!.editor).toBe('UNSPECIFIED')
  });

  it('coerces a non-finite or negative itemCount to 0', () => {
    for (const itemCount of [Number.NaN, Number.POSITIVE_INFINITY, -3, '4', null]) {
      const view = normalizeSelectionSnapshot({
        hasSelection: true,
        itemCount,
        editor: 'PCB',
        labels: ['U1'],
        revision: '7',
      })
      expect(view!.itemCount).toBe(0)
    }
  });

  it('drops non-string labels and copies the array', () => {
    const view = normalizeSelectionSnapshot({
      hasSelection: true,
      itemCount: 2,
      editor: 'PCB',
      labels: ['U1', 7, null, { a: 1 }, 'C3'],
      revision: '8',
    })
    expect(view!.labels).toEqual(['U1', 'C3'])
    view!.labels.push('mutated')
    expect(
      normalizeSelectionSnapshot({
        hasSelection: true,
        itemCount: 2,
        editor: 'PCB',
        labels: ['U1', 7, null, { a: 1 }, 'C3'],
        revision: '8',
      })!.labels,
    ).toEqual(['U1', 'C3'])
  });

  it('accepts a numeric revision and coerces it to a string', () => {
    const view = normalizeSelectionSnapshot({
      hasSelection: true,
      itemCount: 1,
      editor: 'PCB',
      labels: [],
      revision: 9,
    })
    expect(view!.revision).toBe('9')
  });

  it('treats a missing revision as an empty string', () => {
    const view = normalizeSelectionSnapshot({
      hasSelection: true,
      itemCount: 1,
      editor: 'PCB',
      labels: [],
    })
    expect(view!.revision).toBe('')
  });
});

describe('hasVisibleSelection — the single shared gate', () => {
  const populated: SelectionSnapshot = {
    hasSelection: true,
    itemCount: 2,
    editor: 'PCB',
    labels: ['U1', 'R3'],
    revision: '5',
  }

  it('is true for a populated selection', () => {
    expect(hasVisibleSelection(populated)).toBe(true)
  });

  it('is false for an unknown state (null)', () => {
    expect(hasVisibleSelection(null)).toBe(false)
  });

  it('is false for a known-empty selection', () => {
    expect(
      hasVisibleSelection({ ...populated, hasSelection: false, itemCount: 0, labels: [] }),
    ).toBe(false)
  });

  it('is false for an internally inconsistent summary (selected but zero items)', () => {
    // A host bug must not put a chip on screen: the count is what the chip
    // displays, and "0 items selected" is not a selection.
    expect(hasVisibleSelection({ ...populated, itemCount: 0 })).toBe(false)
    expect(hasVisibleSelection({ ...populated, hasSelection: true, itemCount: -1 })).toBe(false)
  });
});
