/**
 * Unit tests for the chip text builder (task
 * `dsh-composer-integration-for-selection-and-sch-gen.md` §4.6).
 *
 * The grounding rule is the point: the chip may state the COUNT (never inferred
 * from the truncated label list), the EDITOR, and a BOUNDED label list. It must
 * render NOTHING for an unknown state or a known-empty selection, and it must
 * never fabricate a type for an item the host did not identify.
 */
import { describe, it, expect } from 'vitest'
import {
  editorLabel,
  itemCountLabel,
  labelSuffix,
  formatSelectionChip,
  selectionChipAriaLabel,
  MAX_CHIP_LABELS,
} from '../src/client/chip-text.js'
import { en, zh } from '../src/client/locales.js'
import type { SelectionSnapshot } from '../src/client/hq-edge.js'

/** Minimal translator over one dictionary, with `{param}` substitution. */
function translator(dict: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>): string => {
    const template = dict[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      params[name] === undefined ? match : String(params[name]),
    )
  }
}

const tEn = translator(en as unknown as Record<string, string>)
const tZh = translator(zh as unknown as Record<string, string>)

const populated: SelectionSnapshot = {
  hasSelection: true,
  itemCount: 3,
  editor: 'PCB',
  labels: ['U1', 'R3', 'C7'],
  revision: '41',
}

describe('editorLabel', () => {
  it('names the editors we model', () => {
    expect(editorLabel('PCB', tEn)).toBe('PCB')
    expect(editorLabel('SCHEMATIC', tEn)).toBe('Schematic')
  });

  it('falls back to a generic word for UNSPECIFIED', () => {
    expect(editorLabel('UNSPECIFIED', tEn)).toBe('editor')
  });
});

describe('itemCountLabel', () => {
  it('uses the singular form for exactly one item', () => {
    expect(itemCountLabel(1, tEn)).toBe('1 item')
    expect(itemCountLabel(1, tZh)).toBe('1 项')
  });

  it('uses the plural form otherwise', () => {
    expect(itemCountLabel(3, tEn)).toBe('3 items')
    expect(itemCountLabel(0, tEn)).toBe('0 items')
  });
});

describe('labelSuffix', () => {
  it('is bounded to MAX_CHIP_LABELS even when the host sent more', () => {
    expect(labelSuffix(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c')
    expect(MAX_CHIP_LABELS).toBe(3)
  });

  it('is empty for no labels', () => {
    expect(labelSuffix([])).toBe('')
  });
});

describe('formatSelectionChip', () => {
  it('renders "Current selection · 3 items (PCB): U1, R3, C7"', () => {
    expect(formatSelectionChip(populated, tEn)).toBe(
      'Current selection · 3 items (PCB): U1, R3, C7',
    )
  });

  it('localizes the whole line', () => {
    expect(formatSelectionChip(populated, tZh)).toBe('当前选中 · 3 项 (PCB)：U1, R3, C7')
  });

  it('uses the singular form for one item', () => {
    expect(formatSelectionChip({ ...populated, itemCount: 1, labels: ['U1'] }, tEn)).toBe(
      'Current selection · 1 item (PCB): U1',
    )
  });

  it('omits the editor parenthetical when the host did not identify one', () => {
    expect(formatSelectionChip({ ...populated, editor: 'UNSPECIFIED' }, tEn)).toBe(
      'Current selection · 3 items: U1, R3, C7',
    )
  });

  it('omits the label suffix when the host sent none', () => {
    expect(formatSelectionChip({ ...populated, labels: [] }, tEn)).toBe(
      'Current selection · 3 items (PCB)',
    )
  });

  it('shows fewer labels than the host sent, but never more than the count', () => {
    const chip = formatSelectionChip({ ...populated, itemCount: 20, labels: ['a', 'b', 'c', 'd'] }, tEn)
    expect(chip).toBe('Current selection · 20 items (PCB): a, b, c')
  });

  it('renders NOTHING for an unknown state', () => {
    expect(formatSelectionChip(null, tEn)).toBe('')
  });

  it('renders NOTHING for a known-empty selection', () => {
    expect(
      formatSelectionChip({ ...populated, hasSelection: false, itemCount: 0, labels: [] }, tEn),
    ).toBe('')
  });

  it('renders NOTHING for an inconsistent summary (selected but zero items)', () => {
    expect(formatSelectionChip({ ...populated, itemCount: 0, labels: [] }, tEn)).toBe('')
  });
});

describe('selectionChipAriaLabel', () => {
  it('reports the grounded count', () => {
    expect(selectionChipAriaLabel(populated, tEn)).toBe('Current editor selection: 3 items')
  });

  it('is empty when nothing is rendered', () => {
    expect(selectionChipAriaLabel(null, tEn)).toBe('')
    expect(
      selectionChipAriaLabel({ ...populated, hasSelection: false, itemCount: 0, labels: [] }, tEn),
    ).toBe('')
  });
});

describe('locale dictionaries — bilingual balance', () => {
  it('en declares exactly the zh key set', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  });

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries({ ...zh, ...en })) {
      expect(value.length, `${key} must not be empty`).toBeGreaterThan(0)
    }
  });
});
