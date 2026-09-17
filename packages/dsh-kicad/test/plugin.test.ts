/**
 * Plugin loading + skill discovery (task §23).
 *
 *   dsh-kicad -> plugin loads successfully
 *   dsh-kicad -> kicad-ipc skill is discoverable
 *
 * These tests drive `apply()` with a Cordis-shaped fake context, because the
 * plugin only ever touches two services: `skills` and `tools`.
 */
import { describe, expect, it } from 'vitest'

import { apply, inject, name, readBundledSkill, skillDescription } from '../src/index.js'
import { kicadToolNames } from '../src/tools.js'

interface RegisteredSkill {
  name: string
  description: string
  content: string
  resourceBase: { kind: string; path: string }
}

function fakeCtx() {
  const skills: RegisteredSkill[] = []
  const tools: Array<{ name: string }> = []
  const unregistered: string[] = []

  const ctx = {
    skills: {
      register(skill: RegisteredSkill) {
        skills.push(skill)
        return () => unregistered.push(`skill:${skill.name}`)
      },
    },
    tools: {
      register(tool: { name: string }) {
        tools.push(tool)
        return () => unregistered.push(`tool:${tool.name}`)
      },
    },
  }
  return { ctx, skills, tools, unregistered }
}

describe('dsh-kicad plugin contract', () => {
  it('declares the plugin id matching its package name', () => {
    expect(name).toBe('@huaqiu/dsh-kicad')
  })

  it('injects skills + tools, and nothing hq-edge related', () => {
    expect([...inject]).toEqual(['skills', 'tools'])
    // §21: no HQ Edge runtime dependency, so it must never be injected.
    expect([...inject]).not.toContain('hqEdge')
  })
})

describe('apply() — plugin loading', () => {
  it('loads and registers exactly one skill and every KiCad tool', () => {
    const { ctx, skills, tools } = fakeCtx()
    const dispose = apply(ctx as never)

    expect(skills).toHaveLength(1)
    expect(tools.map((t) => t.name)).toEqual(kicadToolNames())
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('returns a disposer that unregisters everything it registered', () => {
    const { ctx, unregistered } = fakeCtx()
    const dispose = apply(ctx as never)
    dispose()

    expect(unregistered).toContain('skill:kicad-ipc')
    for (const toolName of kicadToolNames()) {
      expect(unregistered).toContain(`tool:${toolName}`)
    }
    expect(unregistered).toHaveLength(kicadToolNames().length + 1)
  })

  it('throws loudly when the skills service is absent', () => {
    const { ctx } = fakeCtx()
    const broken = { tools: ctx.tools } as never
    expect(() => apply(broken)).toThrow(/skills/)
  })

  it('throws loudly when the tools service is absent', () => {
    const { ctx } = fakeCtx()
    const broken = { skills: ctx.skills } as never
    expect(() => apply(broken)).toThrow(/tools/)
  })
})

describe('apply() — bundled skill discovery (§15)', () => {
  it('registers the kicad-ipc skill with a valid DSH skill id', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    const skill = skills[0]!
    // DSH ignores skills whose id does not match /^[a-z0-9]+(?:-[a-z0-9]+)*$/.
    expect(skill.name).toBe('kicad-ipc')
    expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })

  it('registers a non-empty description and the full SKILL.md body', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    const skill = skills[0]!
    expect(skill.description.length).toBeGreaterThan(20)
    expect(skill.content).toContain('# KiCad IPC PCB')
    // The body must still carry the operating principles, not just a stub.
    expect(skill.content).toContain('读取 → 校验 → 变更 → 验证 → 保存')
  })

  it('points resourceBase at the bundled skill directory', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    const skill = skills[0]!
    expect(skill.resourceBase.kind).toBe('directory')
    expect(skill.resourceBase.path).toMatch(/skills\/kicad-ipc$/)
    // Progressive-disclosure resources must sit beside SKILL.md.
    expect(skill.resourceBase.path).toContain('packages/dsh-kicad')
  })

  it('resolves the skill relative to the package, not the source checkout', () => {
    // This is the property that makes the built artifact work: the resolver
    // must not depend on a repository layout or an absolute path (§16, §17).
    const skill = readBundledSkill(import.meta.url)
    expect(skill.dir).toMatch(/[/\\]skills[/\\]kicad-ipc$/)
    expect(skill.dir).not.toContain('/Users/admin/code/kicad-agent')
  })
})

describe('skillDescription()', () => {
  it('reads the description from SKILL.md frontmatter', () => {
    const md = [
      '---',
      'name: kicad-ipc',
      'description: "通过 KiCad IPC API 编辑 PCB。"',
      '---',
      '',
      '# body',
    ].join('\n')
    expect(skillDescription(md)).toBe('通过 KiCad IPC API 编辑 PCB。')
  })

  it('handles unquoted descriptions', () => {
    expect(skillDescription('---\nname: x\ndescription: plain text\n---\n')).toBe('plain text')
  })

  it('returns undefined when there is no frontmatter or description', () => {
    expect(skillDescription('# no frontmatter')).toBeUndefined()
    expect(skillDescription('---\nname: x\n---\n')).toBeUndefined()
  })
})
