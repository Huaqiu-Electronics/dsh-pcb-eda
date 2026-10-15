/**
 * Unit tests for the `eda:selection` system-prompt section (task
 * `dsh-composer-integration-for-selection-and-sch-gen.md` §4.6).
 *
 * The contract under test:
 *
 *   - the provider contributes NOTHING (`''`) for an unknown state or a
 *     known-empty selection — DSH's `renderPrompt` drops empty sections, so
 *     this is what makes the section disappear rather than say "nothing
 *     selected";
 *   - when it does contribute, it names the focused editor and the count, and
 *     quotes a BOUNDED label list;
 *   - it never implies the selection CONTENT is in the conversation, and it
 *     points at the existing selection tools;
 *   - registration is guarded: a missing `systemPrompt` service or a duplicate
 *     registration must not throw.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  EDA_SELECTION_SECTION,
  EDA_SELECTION_SECTION_ORDER,
  edaSelectionSectionText,
  registerEdaSelectionSection,
  type SystemPromptLike,
} from '../src/prompt.js'
import type { SelectionSnapshot } from '../src/client/hq-edge.js'

const populated: SelectionSnapshot = {
  hasSelection: true,
  itemCount: 3,
  editor: 'PCB',
  labels: ['U1', 'R3', 'C7'],
  revision: '41',
}

/**
 * Unwrap a registered section's text provider.
 *
 * `section.text` is `string | ((context) => string)`; these tests only ever
 * exercise the provider form, so anything else is a bug worth failing on.
 */
function providerOf(registered: { text: unknown } | undefined): (context: unknown) => string {
  const text = registered?.text
  if (typeof text !== 'function') throw new Error('expected a provider function')
  return text as (context: unknown) => string
}

describe('EDA_SELECTION_SECTION — identity and placement', () => {
  it('uses the section name the task spec asks for', () => {
    expect(EDA_SELECTION_SECTION).toBe('eda:selection')
  });

  it('sits between PLAN_POLICY (500) and TEAM_POLICY (600)', () => {
    expect(EDA_SELECTION_SECTION_ORDER).toBeGreaterThan(500)
    expect(EDA_SELECTION_SECTION_ORDER).toBeLessThan(600)
    // And well before the tool-list sections (TOOL_* at 1000+) it refers to.
    expect(EDA_SELECTION_SECTION_ORDER).toBeLessThan(1000)
  });
});

describe('edaSelectionSectionText — contributes nothing when it must', () => {
  it('returns an empty string for an unknown state', () => {
    expect(edaSelectionSectionText(null)).toBe('')
  });

  it('returns an empty string for a known-empty selection', () => {
    expect(
      edaSelectionSectionText({ ...populated, hasSelection: false, itemCount: 0, labels: [] }),
    ).toBe('')
  });

  it('returns an empty string for an inconsistent summary', () => {
    expect(edaSelectionSectionText({ ...populated, itemCount: 0 })).toBe('')
  });
});

describe('edaSelectionSectionText — grounded content when it contributes', () => {
  const text = edaSelectionSectionText(populated)

  it('names the focused editor', () => {
    expect(text).toContain('PCB (pcbnew)')
  });

  it('names the schematic editor too', () => {
    expect(edaSelectionSectionText({ ...populated, editor: 'SCHEMATIC' })).toContain(
      'schematic (eeschema)',
    )
  });

  it('reports the grounded item count', () => {
    expect(text).toContain('3 selected item(s)')
  });

  it('quotes the bounded label list', () => {
    expect(text).toContain('U1, R3, C7')
  });

  it('bounds the label list even when the host sent more', () => {
    const many = edaSelectionSectionText({
      ...populated,
      labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    })
    expect(many).toContain('a, b, c, d, e')
    expect(many).not.toContain('f, g')
  });

  it('states that the selection content is NOT in the conversation', () => {
    expect(text).toContain('NOT in this conversation')
  });

  it('points the agent at the existing selection tools', () => {
    expect(text).toContain('get_pcb_selection')
    expect(text).toContain('get_selection_netlist')
  });

  it('does not claim a type for an item the host did not identify', () => {
    // The summary carries labels, not domain types. The section must not
    // upgrade "U1" into "the footprint U1".
    expect(text.toLowerCase()).not.toContain('footprint')
    expect(text.toLowerCase()).not.toContain('symbol')
  });
});

describe('registerEdaSelectionSection — guarded registration', () => {
  /** The section argument `systemPrompt.section()` is called with. */
  type SectionArg = Parameters<SystemPromptLike['section']>[0]

  /** A `section` mock whose recorded calls keep their argument type. */
  function sectionMock() {
    return vi.fn<(section: SectionArg) => () => void>(() => () => {})
  }

  it('registers a section whose provider performs no I/O', () => {
    const section = sectionMock()
    const systemPrompt: SystemPromptLike = { section }
    const readSelection = vi.fn(() => populated)

    const dispose = registerEdaSelectionSection(systemPrompt, readSelection)

    expect(section).toHaveBeenCalledTimes(1)
    expect(section).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'eda:selection',
        order: EDA_SELECTION_SECTION_ORDER,
      }),
    )
    // The registered text is a PROVIDER, evaluated per assembly.
    const registered = section.mock.calls[0]?.[0]
    expect(registered).toBeDefined()
    expect(typeof registered?.text).toBe('function')

    // Evaluating it reads the cache and nothing else.
    const before = readSelection.mock.calls.length
    expect(providerOf(registered)({})).toContain('3 selected item(s)')
    expect(readSelection.mock.calls.length).toBe(before + 1)

    expect(typeof dispose).toBe('function')
    dispose?.()
  });

  it('re-evaluates on every assembly (the selection changes between turns)', () => {
    let current: SelectionSnapshot | null = populated
    const section = sectionMock()
    registerEdaSelectionSection({ section }, () => current)
    const registered = section.mock.calls[0]?.[0]
    const provider = providerOf(registered)

    expect(provider({})).toContain('3 selected item(s)')

    current = { ...populated, itemCount: 1, labels: ['U9'], revision: '42' }
    expect(provider({})).toContain('1 selected item(s)')

    current = null
    expect(provider({})).toBe('')
  });

  it('returns undefined when the systemPrompt service is absent', () => {
    expect(registerEdaSelectionSection(undefined, () => populated)).toBeUndefined()
    expect(registerEdaSelectionSection(null, () => populated)).toBeUndefined()
    expect(registerEdaSelectionSection({}, () => populated)).toBeUndefined()
  });

  it('swallows a duplicate registration instead of throwing', () => {
    const systemPrompt: SystemPromptLike = {
      section: () => {
        throw new Error('duplicate section name')
      },
    }
    expect(() => registerEdaSelectionSection(systemPrompt, () => populated)).not.toThrow()
    expect(registerEdaSelectionSection(systemPrompt, () => populated)).toBeUndefined()
  });

  it('tolerates a section() that returns no disposer', () => {
    const systemPrompt = { section: () => undefined } as unknown as SystemPromptLike
    expect(registerEdaSelectionSection(systemPrompt, () => populated)).toBeUndefined()
  });
});
