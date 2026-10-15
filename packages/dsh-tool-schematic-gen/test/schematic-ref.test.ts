/**
 * The `@schematic-gen` reference source: identity, menu row, codec and the
 * mandatory registration.
 *
 * The codec is not cosmetic — DSH's `serializeReference` rejects a chip whose
 * owner (or codec) is missing and blocks the whole send, so these assertions
 * guard a hard submission failure rather than a cosmetic label.
 */
import { describe, expect, it } from 'vitest'
import {
  SCHEMATIC_GEN_CLIPBOARD,
  SCHEMATIC_GEN_DESCRIPTION,
  SCHEMATIC_GEN_LABEL,
  SCHEMATIC_GEN_ORDER,
  SCHEMATIC_GEN_REF,
  SCHEMATIC_GEN_SERIALIZED,
  SCHEMATIC_GEN_SOURCE,
  SCHEMATIC_GEN_TRIGGER,
  createSchematicGenSource,
  registerSchematicGenSource,
  schematicGenDescription,
  schematicGenInsert,
  schematicGenLabel,
} from '../src/client/schematic-ref.js'

describe('schematic-gen reference identity', () => {
  it('binds to @ under a unique source name', () => {
    const source = createSchematicGenSource()
    expect(source.trigger).toBe('@')
    expect(source.name).toBe('schematic-gen')
    expect(SCHEMATIC_GEN_TRIGGER).toBe('@')
    expect(SCHEMATIC_GEN_SOURCE).toBe('schematic-gen')
    expect(SCHEMATIC_GEN_ORDER).toBe(10)
  })

  it('offers one candidate named "Generate schematic" with a description', async () => {
    // No host locale (node env, no <html lang>) → zh fallback.
    const source = createSchematicGenSource([], () => undefined)
    const candidates = await source.candidates()
    expect(candidates).toEqual([
      { name: schematicGenLabel(undefined), description: schematicGenDescription(undefined) },
    ])
    expect(SCHEMATIC_GEN_LABEL).toBe('Generate schematic')
  })

  it('localizes the candidate row against the host language', async () => {
    const zh = createSchematicGenSource([], () => 'zh')
    expect(await zh.candidates()).toEqual([
      { name: '生成原理图', description: '根据描述生成 KiCad 原理图' },
    ])

    const en = createSchematicGenSource([], () => 'en')
    expect(await en.candidates()).toEqual([
      { name: 'Generate schematic', description: SCHEMATIC_GEN_DESCRIPTION },
    ])
  })

  it('re-reads the language on every candidates() call, so a preference change lands', async () => {
    let lang: 'zh' | 'en' = 'en'
    const source = createSchematicGenSource([], () => lang)
    expect((await source.candidates())[0].name).toBe('Generate schematic')
    lang = 'zh'
    expect((await source.candidates())[0].name).toBe('生成原理图')
  })

  it('merges extra candidates ahead of the built-in row', async () => {
    const source = createSchematicGenSource([{ name: 'extra' }], () => 'en')
    expect((await source.candidates()).map(c => c.name)).toEqual(['extra', SCHEMATIC_GEN_LABEL])
  })

  it('pick and button-click produce the same insert payload', () => {
    expect(createSchematicGenSource([], () => 'en').onPick()).toEqual({ insert: schematicGenInsert('en') })
    expect(schematicGenInsert('en')).toEqual({
      source: SCHEMATIC_GEN_SOURCE,
      ref: SCHEMATIC_GEN_REF,
      label: SCHEMATIC_GEN_LABEL,
      clipboardText: SCHEMATIC_GEN_CLIPBOARD,
    })
  })

  it('inserts a Chinese chip label under a Chinese UI (the reported bug)', () => {
    // The sidebar button calls insertSchematicChip() with the default insert,
    // which resolves the label at click time — this is the string that used to
    // be frozen to English.
    expect(schematicGenInsert('zh').label).toBe('生成原理图')
    expect(createSchematicGenSource([], () => 'zh').onPick().insert.label).toBe('生成原理图')
  })

  it('falls back to Chinese when the host tag is absent or unsupported', () => {
    expect(schematicGenLabel(undefined)).toBe('生成原理图')
    expect(schematicGenLabel('zh')).toBe('生成原理图')
    expect(schematicGenLabel('en')).toBe('Generate schematic')
  })

  it('leaves appearance undefined so the chip renders the standard @ marker', () => {
    expect(schematicGenInsert('en').appearance).toBeUndefined()
  })
})

describe('schematic-gen codec', () => {
  it('round-trips the clipboard projection', () => {
    const codec = createSchematicGenSource().codec
    expect(codec.clipboardText(SCHEMATIC_GEN_REF)).toBe(SCHEMATIC_GEN_CLIPBOARD)
    expect(SCHEMATIC_GEN_CLIPBOARD).toBe('@schematic-gen')
  })

  it('serializes explicit tool intent, never a fabricated description', async () => {
    const codec = createSchematicGenSource().codec
    const text = await codec.serialize(SCHEMATIC_GEN_REF, new AbortController().signal)

    expect(text).toBe(SCHEMATIC_GEN_SERIALIZED)
    // Must name both generation tools and forbid hand-writing KiCad content.
    expect(text).toContain('generate_schematic_from_description')
    expect(text).toContain('generate_system_module_graph')
    expect(text).toContain('.kicad_sch')
    // Must not invent requirements, and must not fire merely on load.
    expect(text).toContain("Use the user's own words")
    expect(text.toLowerCase()).not.toContain('generate now')
  })
})

describe('registerSchematicGenSource', () => {
  it('registers and returns the registry disposer', () => {
    let registered: unknown
    let disposed = 0
    const dispose = registerSchematicGenSource({
      registerSource: (src: unknown) => { registered = src; return () => { disposed += 1 } },
    })
    expect((registered as { name: string }).name).toBe(SCHEMATIC_GEN_SOURCE)
    dispose()
    expect(disposed).toBe(1)
  })

  it('degrades to a no-op disposer when the service is absent', () => {
    for (const registry of [undefined, null, {}, { registerSource: 'nope' }]) {
      const dispose = registerSchematicGenSource(registry)
      expect(typeof dispose).toBe('function')
      expect(() => dispose()).not.toThrow()
    }
  })

  it('swallows a duplicate registration instead of breaking the client half', () => {
    const dispose = registerSchematicGenSource({
      registerSource: () => { throw new Error('slash source "@schematic-gen" is already registered') },
    })
    expect(() => dispose()).not.toThrow()
  })

  it('tolerates a registry whose disposer is not a function', () => {
    const dispose = registerSchematicGenSource({ registerSource: () => undefined as never })
    expect(() => dispose()).not.toThrow()
  })
})
