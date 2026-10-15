/**
 * Node-side standing prompt guidance.
 *
 * The section is *standing policy*, not per-turn intent — the per-turn part
 * lives in the chip's codec. Guards: unique name, placement between DSH's
 * PLAN_POLICY (500) and TEAM_POLICY (600), static text (no I/O during prompt
 * assembly) and graceful degradation when the prompt service is missing.
 */
import { describe, expect, it } from 'vitest'
import {
  SCHEMATIC_GEN_GUIDANCE,
  SCHEMATIC_GEN_SECTION,
  SCHEMATIC_GEN_SECTION_ORDER,
  registerSchematicGenPromptSection,
} from '../src/prompt.js'

describe('schematic-gen prompt section', () => {
  it('uses a unique name and a placement before DSH tool sections', () => {
    expect(SCHEMATIC_GEN_SECTION).toBe('huaqiu:schematic-gen')
    expect(SCHEMATIC_GEN_SECTION_ORDER).toBeGreaterThan(500)
    expect(SCHEMATIC_GEN_SECTION_ORDER).toBeLessThan(600)
  })

  it('names both tools and forbids hand-written schematic content', () => {
    expect(SCHEMATIC_GEN_GUIDANCE).toContain('generate_schematic_from_description')
    expect(SCHEMATIC_GEN_GUIDANCE).toContain('generate_system_module_graph')
    expect(SCHEMATIC_GEN_GUIDANCE).toContain('.kicad_sch')
    // Never imply a description already exists.
    expect(SCHEMATIC_GEN_GUIDANCE).toContain('do not invent specifications')
  })

  it('registers a static-text section and returns its disposer', () => {
    const seen: Array<{ name: string; order: number; text: unknown }> = []
    let disposed = 0
    const dispose = registerSchematicGenPromptSection({
      section: (s: { name: string; order: number; text: unknown }) => {
        seen.push(s)
        return () => { disposed += 1 }
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.name).toBe(SCHEMATIC_GEN_SECTION)
    expect(seen[0]!.order).toBe(SCHEMATIC_GEN_SECTION_ORDER)
    // Static string: the provider must never perform I/O during assembly.
    expect(typeof seen[0]!.text).toBe('string')
    dispose()
    expect(disposed).toBe(1)
  })

  it('degrades to a no-op disposer when the service is absent', () => {
    for (const service of [undefined, null, {}, { section: 'nope' }]) {
      const dispose = registerSchematicGenPromptSection(service)
      expect(typeof dispose).toBe('function')
      expect(() => dispose()).not.toThrow()
    }
  })

  it('swallows a registration failure', () => {
    const dispose = registerSchematicGenPromptSection({
      section: () => { throw new Error('order must be a finite number') },
    })
    expect(() => dispose()).not.toThrow()
  })
})
