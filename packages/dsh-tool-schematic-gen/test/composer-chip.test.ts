/**
 * Programmatic composer chip insertion — the sharpest edge of the whole
 * feature: two coordinate systems, a revision CAS and a busy-phase guard.
 *
 * Covers: detect-coordinate conversion (with and without existing chips),
 * successful insertion at the document end, preservation of existing text,
 * CAS retry after a revision bump, busy refusal, no-session, missing services,
 * duplicate suppression and never-throw behaviour.
 */
import { describe, expect, it } from 'vitest'
import {
  detectLengthOf,
  hasSchematicChip,
  insertSchematicChip,
  type ChipInserterDeps,
  type InputStateLike,
  type SessionInputLike,
} from '../src/client/composer-chip.js'
import { SCHEMATIC_GEN_CLIPBOARD, SCHEMATIC_GEN_REF, SCHEMATIC_GEN_SOURCE, schematicGenInsert, schematicGenLabel } from '../src/client/schematic-ref.js'

/** One recorded `insertReference` call. */
interface Call {
  ref: unknown
  span: { start: number; end: number; draftRev: number }
  applied: boolean
}

/** A fake `SessionInput` with a scriptable state and a scriptable answer. */
function fakeInput(
  stateOf: (attempt: number) => InputStateLike,
  outcome: (attempt: number) => boolean = () => true,
): { input: SessionInputLike; calls: Call[] } {
  const calls: Call[] = []
  const input: SessionInputLike = {
    state: { getSnapshot: () => stateOf(calls.length) },
    insertReference: (ref, span) => {
      const applied = outcome(calls.length)
      calls.push({ ref, span, applied })
      return applied
    },
  }
  return { input, calls }
}

/** Assemble deps around one session id and one input facade. */
function depsWith(sessionId: string | undefined, input: SessionInputLike | undefined): ChipInserterDeps {
  return {
    getConversation: () => (input === undefined ? undefined : { input: { for: () => input } }),
    getSessions: () => ({
      list: { getSnapshot: () => ({ current: sessionId }) },
      scope: (id: string) => ({ sessionId: id }),
      binding: (id: string) => ({ ctx: { sessionId: id } }),
    }),
  }
}

describe('detectLengthOf', () => {
  it('is the plain length when the draft has no chips', () => {
    expect(detectLengthOf({ draft: 'hello world' })).toBe(11)
    expect(detectLengthOf({ draft: '', occurrences: [] })).toBe(0)
  })

  it('shrinks each chip from its clipboard length to one character', () => {
    //  "@a/b/c" (6 clipboard chars) is ONE detect char → 11 - (6 - 1) = 6
    const state: InputStateLike = {
      draft: 'see @a/b/c now',
      occurrences: [{ source: 'reference', ref: 'x', offset: 4, length: 6 }],
    }
    expect(detectLengthOf(state)).toBe(9)
  })

  it('handles several chips and never goes negative', () => {
    const state: InputStateLike = {
      draft: '@one @two',
      occurrences: [
        { source: 'reference', ref: '1', offset: 0, length: 4 },
        { source: 'reference', ref: '2', offset: 5, length: 4 },
      ],
    }
    expect(detectLengthOf(state)).toBe(3)
    // Malformed snapshot guard: a zero-length chip must not inflate the result.
    expect(detectLengthOf({ draft: 'ab', occurrences: [{ length: 0 }] })).toBe(2)
    expect(detectLengthOf({ draft: 'ab', occurrences: [{ length: 99 }] })).toBe(0)
  })
})

describe('hasSchematicChip', () => {
  it('matches only our own source and ref', () => {
    expect(hasSchematicChip({ occurrences: [{ source: SCHEMATIC_GEN_SOURCE, ref: SCHEMATIC_GEN_REF }] })).toBe(true)
    expect(hasSchematicChip({ occurrences: [{ source: SCHEMATIC_GEN_SOURCE, ref: 'other' }] })).toBe(false)
    expect(hasSchematicChip({ occurrences: [{ source: 'reference', ref: SCHEMATIC_GEN_REF }] })).toBe(false)
    expect(hasSchematicChip({})).toBe(false)
  })
})

describe('insertSchematicChip', () => {
  it('inserts a collapsed span at the detect end using the fresh draftRev', () => {
    const { input, calls } = fakeInput(() => ({ draft: 'design a buck converter', draftRev: 7, phase: 'plain', occurrences: [] }))
    const result = insertSchematicChip(depsWith('s1', input))

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.span).toEqual({ start: 23, end: 23, draftRev: 7 })
    // The default insert resolves its label against the host UI language at
    // call time (the sidebar button passes no insert); with no host tag this
    // environment falls back to zh — the same path that used to be frozen to
    // the English literal under a Chinese UI.
    expect(calls[0]!.ref).toEqual({
      source: SCHEMATIC_GEN_SOURCE,
      ref: SCHEMATIC_GEN_REF,
      label: schematicGenLabel(),
      clipboardText: SCHEMATIC_GEN_CLIPBOARD,
    })
    // The chip deliberately carries no `appearance`: ReferenceChip then renders
    // the standard `@` marker, matching the shipped reference chips.
    expect('appearance' in (calls[0]!.ref as Record<string, unknown>)).toBe(false)
  })

  it('inserts an English chip when the caller resolves the host as en', () => {
    const { input, calls } = fakeInput(() => ({ draft: 'x', draftRev: 1, phase: 'plain', occurrences: [] }))
    expect(insertSchematicChip(depsWith('s1', input), schematicGenInsert('en'))).toEqual({ ok: true })
    expect(calls[0]!.ref.label).toBe('Generate schematic')
  })

  it('accounts for chips already in the draft', () => {
    const state: InputStateLike = {
      draft: `see ${SCHEMATIC_GEN_CLIPBOARD} x`,
      draftRev: 3,
      phase: 'plain',
      occurrences: [{ source: 'reference', ref: 'other', offset: 4, length: SCHEMATIC_GEN_CLIPBOARD.length }],
    }
    const { input, calls } = fakeInput(() => state)
    expect(insertSchematicChip(depsWith('s1', input))).toEqual({ ok: true })
    // "see " (4) + clipboard (14) + " x" (2) = 20 clipboard chars, minus the
    // chip's 13-char shrink → 7 detect chars.
    expect(calls[0]!.span).toEqual({ start: 7, end: 7, draftRev: 3 })
  })

  it('retries once with a fresh snapshot after a CAS miss', () => {
    // Attempt 0 reports rev 1 and refuses (the draft moved under us);
    // attempt 1 reports the new rev 2 and applies.
    const { input, calls } = fakeInput(
      (attempt) => ({ draft: 'x', draftRev: attempt === 0 ? 1 : 2, phase: 'plain', occurrences: [] }),
      (attempt) => attempt === 1,
    )
    expect(insertSchematicChip(depsWith('s1', input))).toEqual({ ok: true })
    expect(calls.map(c => c.span.draftRev)).toEqual([1, 2])
  })

  it('reports conflict when both attempts lose the CAS', () => {
    const { input, calls } = fakeInput(() => ({ draft: 'x', draftRev: 1, phase: 'plain', occurrences: [] }), () => false)
    expect(insertSchematicChip(depsWith('s1', input))).toEqual({ ok: false, reason: 'conflict' })
    expect(calls).toHaveLength(2)
  })

  it('refuses busy phases without touching the draft', () => {
    for (const phase of ['adjudicating', 'submitting']) {
      const { input, calls } = fakeInput(() => ({ draft: 'x', draftRev: 1, phase, occurrences: [] }))
      expect(insertSchematicChip(depsWith('s1', input))).toEqual({ ok: false, reason: 'busy' })
      expect(calls).toHaveLength(0)
    }
  })

  it('reports no-session and never resolves an input facade', () => {
    let resolved = 0
    const input: SessionInputLike = {
      state: { getSnapshot: () => ({ draft: '', draftRev: 0, phase: 'plain' }) },
      insertReference: () => true,
    }
    const deps: ChipInserterDeps = {
      getConversation: () => ({ input: { for: () => { resolved += 1; return input } } }),
      getSessions: () => ({ list: { getSnapshot: () => ({ current: undefined }) }, scope: () => ({}) }),
    }
    expect(insertSchematicChip(deps)).toEqual({ ok: false, reason: 'no-session' })
    expect(resolved).toBe(0)

    // Empty-string ids count as "no session" too.
    const empty: ChipInserterDeps = {
      getConversation: () => ({ input: { for: () => input } }),
      getSessions: () => ({ list: { getSnapshot: () => ({ current: '' }) }, scope: () => ({}) }),
    }
    expect(insertSchematicChip(empty)).toEqual({ ok: false, reason: 'no-session' })
  })

  it('falls back to the binding ctx when scope() cannot resolve', () => {
    const { input, calls } = fakeInput(() => ({ draft: 'x', draftRev: 1, phase: 'plain', occurrences: [] }))
    const deps: ChipInserterDeps = {
      getConversation: () => ({ input: { for: () => input } }),
      getSessions: () => ({
        list: { getSnapshot: () => ({ current: 's1' }) },
        scope: () => undefined,
        binding: (id: string) => ({ ctx: { id } }),
      }),
    }
    expect(insertSchematicChip(deps)).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })

  it('reports unavailable when a service or the facade is missing', () => {
    expect(insertSchematicChip({ getConversation: () => undefined, getSessions: () => ({}) })).toEqual({ ok: false, reason: 'unavailable' })
    expect(insertSchematicChip({ getConversation: () => ({}), getSessions: () => ({}) })).toEqual({ ok: false, reason: 'unavailable' })
    // A facade without insertReference (older host) is unavailable, not fatal.
    expect(insertSchematicChip(depsWith('s1', { state: { getSnapshot: () => ({}) } }))).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('does not duplicate a chip the draft already carries', () => {
    const { input, calls } = fakeInput(() => ({
      draft: SCHEMATIC_GEN_CLIPBOARD,
      draftRev: 4,
      phase: 'plain',
      occurrences: [{ source: SCHEMATIC_GEN_SOURCE, ref: SCHEMATIC_GEN_REF, offset: 0, length: SCHEMATIC_GEN_CLIPBOARD.length }],
    }))
    expect(insertSchematicChip(depsWith('s1', input))).toEqual({ ok: false, reason: 'already-present' })
    expect(calls).toHaveLength(0)
  })

  it('never throws when the services misbehave', () => {
    const throwing: ChipInserterDeps = {
      getConversation: () => ({ input: { for: () => { throw new Error('boom') } } }),
      getSessions: () => ({
        list: { getSnapshot: () => { throw new Error('boom') } },
        scope: () => { throw new Error('boom') },
      }),
    }
    expect(() => insertSchematicChip(throwing)).not.toThrow()
    expect(insertSchematicChip(throwing).ok).toBe(false)

    const badInsert: ChipInserterDeps = {
      getConversation: () => ({ input: { for: () => ({ state: { getSnapshot: () => ({}) }, insertReference: () => { throw new Error('boom') } }) } }),
      getSessions: () => ({ list: { getSnapshot: () => ({ current: 's1' }) }, scope: () => ({}) }),
    }
    expect(() => insertSchematicChip(badInsert)).not.toThrow()
    expect(insertSchematicChip(badInsert)).toEqual({ ok: false, reason: 'conflict' })
  })
})
