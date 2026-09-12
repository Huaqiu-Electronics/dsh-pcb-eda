import { describe, expect, it } from 'vitest'
import {
  confirmDimensionsWithHuman,
  confirmDirectFootprintWithHuman,
  normalizeDimensions,
  parseDimensionOverrides,
  renderDimensionsForHuman,
  HIL_ACCEPT,
  HIL_CANCEL,
  HIL_CONFIRM,
  HIL_DECLINE,
  HIL_EDIT,
  HIL_LABELS,
} from '../src/dimensions.js'

describe('normalizeDimensions', () => {
  it('keeps only scalar values as editable dimensions', () => {
    const out = normalizeDimensions({
      fileName: 'SOIC-8.kicad_mod',
      pkgType: 'sop',
      dimensions: { W: 6.2, L: 5.0, label: 'wide', nested: { a: 1 } },
    })
    expect(out).toEqual({
      fileName: 'SOIC-8.kicad_mod',
      pkgType: 'sop',
      dimensions: { W: 6.2, L: 5.0, label: 'wide' },
    })
  })

  it('tolerates missing fields', () => {
    expect(normalizeDimensions(null)).toEqual({ fileName: null, pkgType: null, dimensions: {} })
  })
})

describe('parseDimensionOverrides', () => {
  const current = { W: 6.2, L: 5.0, label: 'wide' }

  it('parses key=value / key: value pairs, case-insensitive', () => {
    const r = parseDimensionOverrides('w=6.4, L : 5.2', current)
    expect(r.overrides).toEqual({ W: 6.4, L: 5.2 })
    expect(r.unknownKeys).toEqual([])
    expect(r.badValues).toEqual([])
  })

  it('reports unknown keys and non-numeric values without applying them', () => {
    const r = parseDimensionOverrides('height=3, W=abc', current)
    expect(r.overrides).toEqual({})
    expect(r.unknownKeys).toEqual(['height'])
    expect(r.badValues).toEqual(['W=abc'])
  })

  it('accepts string values for string slots', () => {
    const r = parseDimensionOverrides('label=standard', current)
    expect(r.overrides).toEqual({ label: 'standard' })
  })

  it('preserves boolean slot types when applying overrides', () => {
    expect(parseDimensionOverrides('thermal=true', { thermal: false })).toEqual({
      overrides: { thermal: true },
      unknownKeys: [],
      badValues: [],
    })
    expect(parseDimensionOverrides('thermal=FALSE', { thermal: true })).toEqual({
      overrides: { thermal: false },
      unknownKeys: [],
      badValues: [],
    })
  })

  it('rejects invalid values for boolean slots', () => {
    expect(parseDimensionOverrides('thermal=yes', { thermal: false })).toEqual({
      overrides: {},
      unknownKeys: [],
      badValues: ['thermal=yes'],
    })
  })

  it('ignores prose and empty input', () => {
    expect(parseDimensionOverrides('', current).overrides).toEqual({})
    expect(parseDimensionOverrides('please fix it', current).overrides).toEqual({})
  })
})

describe('renderDimensionsForHuman', () => {
  it('renders key = value lines', () => {
    expect(renderDimensionsForHuman({ W: 6.2, pitch: 1.27 })).toBe('W = 6.2\npitch = 1.27')
  })
  it('localizes the empty-state line (zh by default, en on request)', () => {
    expect(renderDimensionsForHuman({})).toMatch(/尺寸值/)
    expect(renderDimensionsForHuman({}, 'en')).toMatch(/no dimension values/)
  })
})

describe('confirmDimensionsWithHuman', () => {
  function askStub(answer: { selected?: string[]; custom?: string }) {
    return { ask: async () => ({ answers: [answer] }) }
  }

  it('cancels on the Cancel option', async () => {
    const r = await confirmDimensionsWithHuman(askStub({ selected: [HIL_CANCEL] }), {
      fileName: null,
      pkgType: 'qfn',
      dimensions: { W: 5 },
    })
    expect(r.verdict).toBe('cancelled')
  })

  it('confirms with the extracted dimensions when the human picks Confirm', async () => {
    const r = await confirmDimensionsWithHuman(askStub({ selected: [HIL_CONFIRM] }), {
      fileName: null,
      pkgType: 'sop',
      dimensions: { W: 6.2, L: 5 },
    })
    expect(r.verdict).toBe('confirmed')
    expect(r.dimensions).toEqual({ W: 6.2, L: 5 })
    expect(r.edited).toBe(false)
  })

  it('applies free-text corrections when the human edits', async () => {
    const r = await confirmDimensionsWithHuman(askStub({ selected: [HIL_EDIT], custom: 'W=6.4' }), {
      fileName: null,
      pkgType: 'sop',
      dimensions: { W: 6.2 },
    })
    expect(r.verdict).toBe('confirmed')
    expect(r.dimensions).toEqual({ W: 6.4 })
    expect(r.edited).toBe(true)
  })
})

describe('confirmDirectFootprintWithHuman', () => {
  it('accepts by default and declines on the Decline option', async () => {
    const accepted = await confirmDirectFootprintWithHuman(
      { ask: async () => ({ answers: [{ selected: [HIL_ACCEPT] }] }) },
      { fileUrl: 'https://x/y.kicad_mod' },
    )
    expect(accepted.verdict).toBe('accepted')
    const declined = await confirmDirectFootprintWithHuman(
      { ask: async () => ({ answers: [{ selected: [HIL_DECLINE] }] }) },
      { fileUrl: 'https://x/y.kicad_mod' },
    )
    expect(declined.verdict).toBe('declined')
  })
})

// ── localization of the HITL prompts ────────────────────────────────────────

interface AskedQuestion {
  header: string
  question: string
  detail?: string
  options?: Array<{ label: string; description: string }>
}

function firstAsked(options: Record<string, unknown>): AskedQuestion {
  return (options.questions as AskedQuestion[])[0]!
}

/** Records every `ask()` payload so the rendered copy can be asserted on. */
function recordingQuestions(answer: { selected?: string[]; custom?: string }) {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    asked: () => firstAsked(calls[0]!),
    questions: {
      ask: async (options: Record<string, unknown>) => {
        calls.push(options)
        return { answers: [answer] }
      },
    },
  }
}

describe('HITL prompt localization', () => {
  const extracted = { fileName: null, pkgType: 'qfn', dimensions: { W: 5 } }

  it('keeps the English labels equal to the exported HIL_* constants', () => {
    // `HIL_LABELS.en` is now derived from the copy pack; the standalone
    // constants remain the documented, stable English vocabulary.
    expect(HIL_LABELS.en).toEqual({
      confirm: HIL_CONFIRM,
      edit: HIL_EDIT,
      cancel: HIL_CANCEL,
      accept: HIL_ACCEPT,
      decline: HIL_DECLINE,
    })
  })

  it('defaults to zh and switches to en via the exec locale', async () => {
    const zh = recordingQuestions({ selected: [HIL_LABELS.zh.confirm] })
    await confirmDimensionsWithHuman(zh.questions, extracted)
    expect(zh.asked().header).toBe('封装')
    expect(zh.asked().options?.map((o) => o.label)).toEqual(['确认', '修改数值', '取消'])

    const en = recordingQuestions({ selected: [HIL_CONFIRM] })
    await confirmDimensionsWithHuman(en.questions, extracted, { locale: 'en' })
    expect(en.asked().header).toBe('Footprint')
    expect(en.asked().options?.map((o) => o.label)).toEqual([HIL_CONFIRM, HIL_EDIT, HIL_CANCEL])
  })

  it('accepts a BCP-47 tag as well as a bare locale id', async () => {
    const rec = recordingQuestions({ selected: [HIL_CONFIRM] })
    await confirmDimensionsWithHuman(rec.questions, extracted, { locale: 'en-US' })
    expect(rec.asked().header).toBe('Footprint')
  })

  it('falls back to zh for an unrecognized locale', async () => {
    const rec = recordingQuestions({ selected: [HIL_LABELS.zh.confirm] })
    await confirmDimensionsWithHuman(rec.questions, extracted, { locale: 'fr' })
    expect(rec.asked().header).toBe('封装')
  })

  it('localizes the package fallback and the edit hint', () => {
    const en = recordingQuestions({ selected: [HIL_CONFIRM] })
    const zh = recordingQuestions({ selected: [HIL_LABELS.zh.confirm] })
    return Promise.all([
      confirmDimensionsWithHuman(en.questions, { fileName: null, pkgType: null, dimensions: {} }, { locale: 'en' }),
      confirmDimensionsWithHuman(zh.questions, { fileName: null, pkgType: null, dimensions: {} }),
    ]).then(() => {
      expect(en.asked().question).toContain('the package')
      expect(zh.asked().question).toContain('该封装')
    })
  })

  it('resolves the verdict from EITHER the localized label or the English constant', async () => {
    // The localized label is what the human actually clicks…
    const viaZh = recordingQuestions({ selected: ['取消'] })
    expect(
      (await confirmDimensionsWithHuman(viaZh.questions, extracted)).verdict,
    ).toBe('cancelled')
    // …but a host may echo the English constant back, and that still works.
    const viaEn = recordingQuestions({ selected: [HIL_CANCEL] })
    expect(
      (await confirmDimensionsWithHuman(viaEn.questions, extracted)).verdict,
    ).toBe('cancelled')
  })

  it('localizes the direct-footprint question and its unknown-file placeholder', async () => {
    const en = recordingQuestions({ selected: [HIL_ACCEPT] })
    await confirmDirectFootprintWithHuman(en.questions, {}, { locale: 'en' })
    expect(en.asked().options?.map((o) => o.label)).toEqual([HIL_ACCEPT, HIL_DECLINE])
    expect(en.asked().detail).toContain('Generated file: (unknown)')

    const zh = recordingQuestions({ selected: [HIL_LABELS.zh.accept] })
    await confirmDirectFootprintWithHuman(zh.questions, { fileUrl: 'https://x/y.kicad_mod' })
    expect(zh.asked().options?.map((o) => o.label)).toEqual(['使用', '不使用'])
    expect(zh.asked().detail).toContain('生成的文件：https://x/y.kicad_mod')
  })

  it('declines when the localized decline label is selected', async () => {
    const rec = recordingQuestions({ selected: ['不使用'] })
    expect(
      (await confirmDirectFootprintWithHuman(rec.questions, { fileUrl: 'https://x/y.kicad_mod' })).verdict,
    ).toBe('declined')
  })
})
