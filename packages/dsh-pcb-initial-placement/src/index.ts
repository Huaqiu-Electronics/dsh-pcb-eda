/**
 * `@huaqiu/dsh-pcb-initial-placement` — node plugin entry.
 *
 * Ships ONE DSH bundled skill: `pcb-initial-placement` (Phase-1 initial PCB
 * placement for a board that has a netlist but no layout). It registers no
 * tools — the skill's executable half is its own Python helpers under
 * `skills/pcb-initial-placement/scripts/`, which the agent invokes itself
 * through the KiCad IPC API.
 *
 * ── Why this is its own package ────────────────────────────────────────────
 * `pcb-initial-placement` used to ride inside `@huaqiu/dsh-kicad`, so anyone
 * installing the KiCad plugin got the whole skill tree whether they wanted it
 * or not. Splitting it out makes the skill installable on its own:
 *
 *   - HQ Edge bundles it from `plugins-release-manifest.json` (discovery is
 *     driven by that catalog, not by this repo's bundles);
 *   - the standalone desktop bundle (`@huaqiu/hardware-engineering`) encodes
 *     the opposite choice by NOT depending on this package, so desktop users
 *     stay opt-in.
 *
 * @module @huaqiu/dsh-pcb-initial-placement
 */
import type { Context } from '@deepseek-ai/cordis'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  hasSkillsDirOverride,
  PCB_INITIAL_PLACEMENT_SKILL_NAME,
  type PcbInitialPlacementConfigInput,
} from './config.js'
import { requireSkillDir, resolveSkillDir } from './paths.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-pcb-initial-placement'

/**
 * `skills` is REQUIRED: it is the DSH runtime's plugin-bundled skill registry,
 * and registering the skill is this plugin's entire job.
 */
export const inject = ['skills'] as const

export type { PcbInitialPlacementConfig, PcbInitialPlacementConfigInput } from './config.js'
export { PCB_INITIAL_PLACEMENT_SKILL_NAME } from './config.js'
export { requireSkillDir, resolveSkillDir } from './paths.js'

/** The `skills` service shape consumed by this plugin. */
export interface SkillRegistration {
  /** Skill id — must match DSH's discoverable skill id format. */
  name: string
  /** Catalog description shown to the model. */
  description: string
  /** Full SKILL.md body. */
  content: string
  /** Discovery source for plugin-bundled skills. */
  source: 'runtime'
  /** Where `references/` and `scripts/` live for progressive disclosure. */
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

const COMPONENT = 'dsh-pcb-initial-placement'
const log = getLogger(COMPONENT)

log.info('dsh-pcb-initial-placement: module loaded (waiting for the skills service)')

/**
 * Fallback catalogue description, used only when SKILL.md frontmatter has no
 * parseable `description` (the shipped file is authoritative).
 */
const FALLBACK_SKILL_DESCRIPTION =
  'Phase-1 initial placement for a KiCad PCB that has a netlist but no layout: ' +
  'functional clustering, anchor placement, zone partitioning, overlap-free ' +
  'packing and a handover report, applied through the KiCad IPC API.'

/**
 * Extract the `description` field from SKILL.md YAML frontmatter.
 *
 * Supports single-line quoted values and the folded block form
 * (`description: >-` followed by indented lines).
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

/** Read the bundled skill as a ready-to-register record. */
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
    name: PCB_INITIAL_PLACEMENT_SKILL_NAME,
    description: skillDescription(content) ?? FALLBACK_SKILL_DESCRIPTION,
    content,
  }
}

/**
 * Read the bundled skill, or `null` when the installed package does not carry
 * it.
 *
 * A missing `skills/` tree is a packaging failure, but the right blast radius
 * is "this skill is unavailable", not "the whole DSH plugin tree aborts": the
 * same rule `@huaqiu/dsh-kicad` follows, so a bad tarball never takes the EDA
 * session down with it.
 */
export function tryReadBundledSkill(moduleUrl: string, override?: string): {
  dir: string
  name: string
  description: string
  content: string
} | null {
  try {
    return readBundledSkill(moduleUrl, override)
  } catch (err) {
    log.error(
      'dsh-pcb-initial-placement: bundled skill unavailable — the plugin stays ' +
        'loaded without registering it; reinstall the package to restore it',
      {
        expectedDir: resolveSkillDir(moduleUrl, override),
        error: String((err as Error)?.message ?? err),
      },
    )
    return null
  }
}

/**
 * Host plugin body — register the bundled skill.
 *
 * @param ctx - real cordis context (node side).
 * @param config - plugin overlay config (skills directory override).
 * @returns disposer — unregisters the skill on plugin dispose.
 */
export function apply(ctx: Context, config: PcbInitialPlacementConfigInput = {}): () => void {
  if (!ctx.skills || typeof ctx.skills.register !== 'function') {
    throw new Error('@huaqiu/dsh-pcb-initial-placement requires the DSH `skills` service (ctx.skills.register).')
  }

  const skill = tryReadBundledSkill(import.meta.url, config.skillsDir)

  log.info('applying dsh-pcb-initial-placement node half', {
    hasSkillsDirOverride: hasSkillsDirOverride(config),
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

  log.info('dsh-pcb-initial-placement node half ready', {
    skill: skill?.name ?? null,
    degraded: skill === null,
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (err) {
        log.warn('dsh-pcb-initial-placement disposer failed', {
          error: String((err as Error)?.message ?? err),
        })
      }
    }
  }
}
