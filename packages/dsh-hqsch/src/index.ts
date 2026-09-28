/**
 * `@huaqiu/dsh-hqsch` - node plugin entry.
 *
 * This plugin ships the HQSCH scenario-b skill as a DSH bundled skill. It does
 * not register DSH tools: scenario-b's execution model is for the coding agent
 * to generate TypeScript scripts under the bundled template and run them
 * locally against HQ EDA.
 *
 * @module @huaqiu/dsh-hqsch
 */
import type { Context } from '@deepseek-ai/cordis'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  hasHostConfig,
  HQSCH_SKILL_NAME,
  type HqschConfig,
  type HqschConfigInput,
} from './config.js'
import { requireSkillDir, resolveSkillDir } from './paths.js'

/** Plugin id - matches package.json. */
export const name = '@huaqiu/dsh-hqsch'

/**
 * `skills` is REQUIRED: it is the DSH runtime's plugin-bundled skill registry.
 */
export const inject = ['skills'] as const

export type { HqschConfig, HqschConfigInput } from './config.js'
export { HQSCH_SKILL_NAME } from './config.js'
export { requireSkillDir, resolveSkillDir } from './paths.js'

/** The `skills` service shape consumed by this plugin. */
export interface SkillRegistration {
  /** Skill id - must match DSH's discoverable skill id format. */
  name: string
  /** Catalog description shown to the model. */
  description: string
  /** Full SKILL.md body. */
  content: string
  /** Discovery source for plugin-bundled skills. */
  source: 'runtime'
  /** Where docs/ and template/ live for progressive disclosure. */
  resourceBase: { kind: 'directory'; path: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH skill registry, provided by the runtime skill service. */
    skills: {
      /** Register a plugin-bundled skill; returns its unregister disposer. */
      register(skill: SkillRegistration): () => void
    }
  }
}

const COMPONENT = 'dsh-hqsch'
const log = getLogger(COMPONENT)

log.info('dsh-hqsch: module loaded (waiting for the skills service)')

const FALLBACK_SKILL_DESCRIPTION =
  'HQSCH scenario-b automation skill for HQ EDA schematic drawing, reading and ' +
  'local surgical edits through generated TypeScript scripts.'

/**
 * Extract the `description` field from SKILL.md YAML frontmatter.
 *
 * Supports both single-line values and the folded block form used by
 * hqeda-scenario-b (`description: >-` followed by indented lines).
 */
export function skillDescription(markdown: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!frontmatter?.[1]) return undefined

  const lines = frontmatter[1].split(/\r?\n/)
  const lineIndex = lines.findIndex((candidate) => /^\s*description\s*:/.test(candidate))
  if (lineIndex < 0) return undefined

  const raw = lines[lineIndex]!.slice(lines[lineIndex]!.indexOf(':') + 1).trim()
  if (raw === '>-' || raw === '>' || raw === '|-' || raw === '|') {
    const block: string[] = []
    for (const line of lines.slice(lineIndex + 1)) {
      if (/^\s+\S/.test(line)) {
        block.push(line.trim())
        continue
      }
      if (line.trim().length === 0) continue
      break
    }
    const text = block.join(' ').trim()
    return text.length > 0 ? text : undefined
  }

  const unquoted = raw.replace(/^["']/, '').replace(/["']$/, '')
  return unquoted.length > 0 ? unquoted : undefined
}

/** Read the bundled HQSCH scenario-b SKILL.md. */
export function readBundledSkill(moduleUrl: string, override?: string): {
  dir: string
  name: string
  description: string
  content: string
} {
  const dir = requireSkillDir(moduleUrl, override)
  const content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  return {
    dir,
    name: HQSCH_SKILL_NAME,
    description: skillDescription(content) ?? FALLBACK_SKILL_DESCRIPTION,
    content,
  }
}

/**
 * Read the bundled skill, or `null` when the installed package does not carry
 * one. A missing skill is a packaging failure, but it should degrade this
 * plugin instead of killing the whole DSH process.
 */
export function tryReadBundledSkill(
  moduleUrl: string,
  override?: string,
): { dir: string; name: string; description: string; content: string } | null {
  try {
    return readBundledSkill(moduleUrl, override)
  } catch (err) {
    log.error(
      'dsh-hqsch: bundled skill unavailable - continuing degraded without skill registration',
      {
        expectedDir: resolveSkillDir(moduleUrl, override),
        error: String((err as Error)?.message ?? err),
      },
    )
    return null
  }
}

/**
 * Host plugin body - register the bundled HQSCH scenario-b skill.
 */
export function apply(ctx: Context, config: HqschConfigInput = {}): () => void {
  if (!ctx.skills || typeof ctx.skills.register !== 'function') {
    throw new Error('@huaqiu/dsh-hqsch requires the DSH `skills` service (ctx.skills.register).')
  }

  const skill = tryReadBundledSkill(import.meta.url, config.skillsDir)

  log.info('applying dsh-hqsch node half', {
    hasConfigHost: hasHostConfig(config),
    skillDir: skill?.dir ?? resolveSkillDir(import.meta.url, config.skillsDir),
    skillPresent: skill !== null,
  })

  const disposers: Array<() => void> = []

  if (skill) {
    disposers.push(
      ctx.skills.register({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: skill.dir },
      }),
    )
  }

  log.info('dsh-hqsch node half ready', {
    skill: skill?.name ?? null,
    degraded: skill === null,
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (err) {
        log.warn('dsh-hqsch disposer failed', { error: String((err as Error)?.message ?? err) })
      }
    }
  }
}
