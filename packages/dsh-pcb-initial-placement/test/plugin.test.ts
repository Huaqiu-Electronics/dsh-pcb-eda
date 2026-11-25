/**
 * Contract tests for the plugin half: one skill, registered at load time,
 * unregistered on dispose, and never fatal when the skill tree is missing.
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

import {
  apply,
  PCB_INITIAL_PLACEMENT_SKILL_NAME,
  readBundledSkill,
  skillDescription,
  tryReadBundledSkill,
  type SkillRegistration,
} from '../src/index.js'

const MODULE_URL = new URL('../src/index.ts', import.meta.url).href

function fakeContext() {
  const registered: SkillRegistration[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    skills: {
      register: vi.fn((skill: SkillRegistration) => {
        registered.push(skill)
        const dispose = vi.fn()
        disposers.push(dispose)
        return dispose
      }),
    },
  }
  return { ctx: ctx as never, registered, disposers }
}

describe('module contract', () => {
  it('declares the package name and injects skills only', async () => {
    const mod = await import('../src/index.js')
    expect(mod.name).toBe('@huaqiu/dsh-pcb-initial-placement')
    expect([...mod.inject]).toEqual(['skills'])
  })

  it('ships the skill id that matches its directory', () => {
    expect(PCB_INITIAL_PLACEMENT_SKILL_NAME).toBe('pcb-initial-placement')
  })
})

describe('apply()', () => {
  it('registers exactly one skill with the bundled directory as resourceBase', () => {
    const { ctx, registered } = fakeContext()
    const dispose = apply(ctx)

    expect(registered).toHaveLength(1)
    const skill = registered[0]!
    expect(skill.name).toBe('pcb-initial-placement')
    expect(skill.source).toBe('runtime')
    expect(skill.resourceBase.kind).toBe('directory')
    expect(skill.resourceBase.path.endsWith(join('skills', 'pcb-initial-placement'))).toBe(true)
    expect(skill.content).toContain('# PCB 初始布局（Phase 1）')
    expect(skill.description.length).toBeGreaterThan(20)

    dispose()
  })

  it('unregisters on dispose', () => {
    const { ctx, disposers } = fakeContext()
    const dispose = apply(ctx)
    expect(disposers).toHaveLength(1)

    dispose()
    expect(disposers[0]).toHaveBeenCalledTimes(1)
  })

  it('refuses to load without the skills service', () => {
    expect(() => apply({} as never)).toThrow(/requires the DSH `skills` service/)
  })

  it('honors a skillsDir override', () => {
    const { ctx, registered } = fakeContext()
    const dir = readBundledSkill(MODULE_URL).dir
    const dispose = apply(ctx, { skillsDir: dir })

    expect(registered[0]!.resourceBase.path).toBe(dir)
    dispose()
  })
})

describe('skill reading', () => {
  it('parses the quoted frontmatter description', () => {
    const description = skillDescription(readBundledSkill(MODULE_URL).content)
    expect(description).toContain('Phase-1 初始布局')
  })

  it('falls back to the catalogue summary when frontmatter has none', () => {
    const skill = readBundledSkill(MODULE_URL)
    expect(skill.description).toBe(skillDescription(skill.content) ?? skill.description)
    expect(skillDescription('# no frontmatter here')).toBeUndefined()
  })

  it('degrades to null (instead of throwing) when the skill tree is missing', () => {
    const missing = join(import.meta.dirname, '..', 'does-not-exist')
    expect(tryReadBundledSkill(MODULE_URL, missing)).toBeNull()
  })
})
