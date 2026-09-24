/**
 * Plugin loading + skill discovery (task §23).
 *
 *   dsh-kicad -> plugin loads successfully
 *   dsh-kicad -> every bundled skill is discoverable
 *
 * These tests drive `apply()` with a Cordis-shaped fake context, because the
 * plugin only ever touches two services: `skills` and `tools`.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { apply, inject, name, readBundledSkill, skillDescription } from '../src/index.js'
import { KICAD_SCRIPT_SKILL_ID, KICAD_SKILL_IDS } from '../src/skills.js'
import { kicadToolNames } from '../src/tools.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface RegisteredSkill {
  name: string
  description: string
  content: string
  source: 'runtime'
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
  it('loads and registers every bundled skill plus every KiCad tool', () => {
    const { ctx, skills, tools } = fakeCtx()
    const dispose = apply(ctx as never)

    expect(skills.map((s) => s.name)).toEqual([...KICAD_SKILL_IDS])
    expect(tools.map((t) => t.name)).toEqual(kicadToolNames())
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('returns a disposer that unregisters everything it registered', () => {
    const { ctx, unregistered } = fakeCtx()
    const dispose = apply(ctx as never)
    dispose()

    for (const id of KICAD_SKILL_IDS) {
      expect(unregistered).toContain(`skill:${id}`)
    }
    for (const toolName of kicadToolNames()) {
      expect(unregistered).toContain(`tool:${toolName}`)
    }
    expect(unregistered).toHaveLength(kicadToolNames().length + KICAD_SKILL_IDS.length)
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

  // ── Degraded load ────────────────────────────────────────────────────────
  // HQ Edge's builtin-plugin staging used to copy only package.json + lib/, so
  // skills/ never reached the bundle. Because apply() threw, that single
  // missing asset aborted the whole DSH plugin tree and the server could not
  // start at all. The blast radius of "this plugin's skills are missing" must
  // be "this plugin is degraded" — never "DSH exits".
  describe('degraded when a bundled skill is missing', () => {
    const MISSING = '/nonexistent/dsh-kicad/skills'

    it('loads anyway and still registers every KiCad tool', () => {
      const { ctx, skills, tools } = fakeCtx()
      expect(() => apply(ctx as never, { skillsDir: MISSING })).not.toThrow()

      expect(skills).toHaveLength(0)
      expect(tools.map((t) => t.name)).toEqual(kicadToolNames())
    })

    it('returns a working disposer that unregisters only what it registered', () => {
      const { ctx, unregistered } = fakeCtx()
      const dispose = apply(ctx as never, { skillsDir: MISSING })
      dispose()

      expect(unregistered.some((u) => u.startsWith('skill:'))).toBe(false)
      expect(unregistered).toHaveLength(kicadToolNames().length)
    })

    it('degrades per skill — one missing skill never hides the others', () => {
      // A skills root holding only one of the two skills: the present one must
      // still register. Built in a temp dir (copying the real SKILL.md) so the
      // fixture cannot drift out of sync with the shipped skill.
      const root = mkdtempSync(join(tmpdir(), 'dsh-kicad-skills-'))
      try {
        mkdirSync(join(root, KICAD_SCRIPT_SKILL_ID), { recursive: true })
        copyFileSync(
          join(packageRoot, 'skills', KICAD_SCRIPT_SKILL_ID, 'SKILL.md'),
          join(root, KICAD_SCRIPT_SKILL_ID, 'SKILL.md'),
        )

        const { ctx, skills, tools } = fakeCtx()
        apply(ctx as never, { skillsDir: root })

        expect(skills.map((s) => s.name)).toEqual([KICAD_SCRIPT_SKILL_ID])
        // The tools survive a partially-missing skill set.
        expect(tools.map((t) => t.name)).toEqual(kicadToolNames())
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('keeps readBundledSkill() fatal — packaging checks must still fail loud', () => {
      // The degradation above is about not killing the HOST. An explicit
      // packaging assertion (tests, `dsh-doctor`) should still throw.
      expect(() => readBundledSkill(import.meta.url, KICAD_SCRIPT_SKILL_ID, MISSING))
        .toThrow(/bundled skill missing/)
    })
  })
})

describe('apply() — bundled skill discovery (§15)', () => {
  it('registers each skill under its bundled id, with a valid DSH skill source', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    for (const skill of skills) {
      // DSH ignores skills whose id does not match /^[a-z0-9]+(?:-[a-z0-9]+)*$/.
      expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      // DSH rejects skills without a string source at load time ("source must be
      // a string"); plugin-bundled skills must carry the runtime source.
      expect(skill.source).toBe('runtime')
    }
    expect(skills.map((s) => s.name)).toContain('kicad-ipc')
    expect(skills.map((s) => s.name)).toContain('hardware-design-brief')
  })

  it('registers a non-empty description and the full SKILL.md body', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(20)
      expect(skill.content).toContain('#')
    }

    const ipc = skills.find((s) => s.name === 'kicad-ipc')!
    // The body must still carry the operating principles, not just a stub.
    expect(ipc.content).toContain('读取 → 校验 → 变更 → 验证 → 保存')

    const brief = skills.find((s) => s.name === 'hardware-design-brief')!
    expect(brief.content).toContain('文档位置与关系')
  })

  it('points each resourceBase at that skill\'s own bundled directory', () => {
    const { ctx, skills } = fakeCtx()
    apply(ctx as never)

    for (const skill of skills) {
      expect(skill.resourceBase.kind).toBe('directory')
      // Progressive-disclosure resources must sit beside SKILL.md. Both
      // separators are matched so the assertion holds on Windows (`\`) and
      // POSIX (`/`).
      expect(skill.resourceBase.path).toMatch(
        new RegExp(`[/\\\\]packages[/\\\\]dsh-kicad[/\\\\]skills[/\\\\]${skill.name}$`),
      )
    }
  })

  it('resolves skills relative to the package, not the source checkout', () => {
    // This is the property that makes the built artifact work: the resolver
    // must not depend on a repository layout or an absolute path (§16, §17).
    for (const id of KICAD_SKILL_IDS) {
      const skill = readBundledSkill(import.meta.url, id)
      expect(skill.dir).toMatch(new RegExp(`[/\\\\]skills[/\\\\]${id}$`))
      expect(skill.dir).not.toContain('/Users/admin/code/kicad-agent')
    }
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
