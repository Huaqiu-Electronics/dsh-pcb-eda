import { describe, expect, it } from 'vitest'

import {
  apply,
  HQSCH_SKILL_NAME,
  inject,
  name,
  readBundledSkill,
  skillDescription,
} from '../src/index.js'

interface RegisteredSkill {
  name: string
  description: string
  content: string
  source: 'runtime'
  resourceBase: { kind: string; path: string }
}

function fakeCtx() {
  const skills: RegisteredSkill[] = []
  const unregistered: string[] = []

  const ctx = {
    skills: {
      register(skill: RegisteredSkill) {
        skills.push(skill)
        return () => unregistered.push(`skill:${skill.name}`)
      },
    },
  }
  return { ctx, skills, unregistered }
}

describe('dsh-hqsch plugin contract', () => {
  it('declares the plugin id matching its package name', () => {
    expect(name).toBe('@huaqiu/dsh-hqsch')
  })

  it('injects only the skills service', () => {
    expect([...inject]).toEqual(['skills'])
  })
})

describe('apply() - plugin loading', () => {
  it('loads and registers exactly one skill', () => {
    const { ctx, skills } = fakeCtx()
    const dispose = apply(ctx as never)

    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe(HQSCH_SKILL_NAME)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('returns a disposer that unregisters the skill', () => {
    const { ctx, unregistered } = fakeCtx()
    const dispose = apply(ctx as never)
    dispose()

    expect(unregistered).toEqual([`skill:${HQSCH_SKILL_NAME}`])
  })

  it('throws loudly when the skills service is absent', () => {
    expect(() => apply({} as never)).toThrow(/skills/)
  })

  describe('degraded when the bundled skill is missing', () => {
    const MISSING = '/nonexistent/dsh-hqsch/skills/hqsch-scenario-b'

    it('loads anyway and registers no skill', () => {
      const { ctx, skills } = fakeCtx()
      expect(() => apply(ctx as never, { skillsDir: MISSING })).not.toThrow()
      expect(skills).toHaveLength(0)
    })

    it('returns a working disposer when nothing was registered', () => {
      const { ctx, unregistered } = fakeCtx()
      const dispose = apply(ctx as never, { skillsDir: MISSING })
      dispose()
      expect(unregistered).toEqual([])
    })

    it('keeps readBundledSkill() fatal for packaging checks', () => {
      expect(() => readBundledSkill(import.meta.url, MISSING)).toThrow(/bundled skill missing/)
    })
  })
})

describe('apply() - bundled skill discovery', () => {
  it('registers the hqsch-scenario-b skill with runtime source', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    const skill = skills[0]!
    expect(skill.name).toBe(HQSCH_SKILL_NAME)
    expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(skill.source).toBe('runtime')
  })

  it('registers a non-empty description and full SKILL.md body', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    const skill = skills[0]!
    expect(skill.description.length).toBeGreaterThan(20)
    expect(skill.content).toContain('# HQ EDA')
    expect(skill.content).toContain('SYSTEM-PROMPT.md')
  })

  it('points resourceBase at the bundled skill directory', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    const skill = skills[0]!
    expect(skill.resourceBase.kind).toBe('directory')
    expect(skill.resourceBase.path).toMatch(/skills[/\\]hqsch-scenario-b$/)
    expect(skill.resourceBase.path).toMatch(/[/\\]packages[/\\]dsh-hqsch[/\\]skills[/\\]hqsch-scenario-b$/)
  })
})

describe('skillDescription()', () => {
  it('reads a folded YAML description block', () => {
    const md = [
      '---',
      'name: x',
      'description: >-',
      '  first line',
      '  second line',
      'version: 1',
      '---',
    ].join('\n')
    expect(skillDescription(md)).toBe('first line second line')
  })

  it('reads single-line descriptions', () => {
    expect(skillDescription('---\nname: x\ndescription: plain text\n---\n')).toBe('plain text')
  })

  it('returns undefined when there is no frontmatter or description', () => {
    expect(skillDescription('# no frontmatter')).toBeUndefined()
    expect(skillDescription('---\nname: x\n---\n')).toBeUndefined()
  })
})
