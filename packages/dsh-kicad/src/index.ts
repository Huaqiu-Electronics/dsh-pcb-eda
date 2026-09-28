/**
 * `@huaqiu/dsh-kicad` — node plugin entry.
 *
 * ── Delivery boundary (task: dsh-kicad-skill-plugin §14, §28) ───────────────
 * This plugin ships TWO things that used to need two installations:
 *
 *   1. ten KiCad tools, registered with `ctx.tools.register(defineTool(...))`
 *   2. every bundled skill under `skills/`, registered with
 *      `ctx.skills.register(...)` — currently `kicad-ipc` (the reasoning around
 *      the tools) and `hardware-design-brief` (requirements → design inputs)
 *
 * Installing the Huaqiu DSH PCB/EDA bundle therefore makes KiCad agent
 * capabilities AND the skills that teach the agent to use them available out of
 * the box. There is no separate skill installation step, and this plugin adds no
 * second skill-registration mechanism — `ctx.skills.register()` is the DSH
 * runtime's own plugin-bundled skill channel.
 *
 * The skill set is data, not code: `./skills.ts` owns the registry, so adding a
 * skill from `kicad-agent` is a copy plus a registry entry.
 *
 * ── Boundaries ──────────────────────────────────────────────────────────────
 * KiCad IPC is reached through the bundled Python scripts under
 * `skills/<KICAD_SCRIPT_SKILL_ID>/scripts/` (see `./ipc.ts`). This package holds
 * no HQ Edge dependency of any kind — no runtime, executable, service, port,
 * config or artifact dependency (§3, §21) — and no `@hqedge/*` import.
 *
 * @module @huaqiu/dsh-kicad
 */
import type { Context } from '@deepseek-ai/cordis'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  hasHostConfig,
  resolveKicadConfig,
  type KicadConfig,
  type KicadConfigInput,
} from './config.js'
import { requireSkillDir, resolveSkillDir, scriptsDir, skillsRoot } from './paths.js'
import { KICAD_SCRIPT_SKILL_ID, KICAD_SKILL_IDS, kicadSkill } from './skills.js'
import { createKicadTools, kicadToolNames } from './tools.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-kicad'

/**
 * Cordis services this half depends on.
 *
 * `skills` is REQUIRED: it is the DSH runtime's skill registry, and registering
 * the bundled skills is this plugin's core job. Without the inject,
 * `apply()`'s `ctx.skills` access would throw
 * `cannot get property "skills" without inject`.
 *
 * `tools` is the DSH node runtime tool registry used for the KiCad tools.
 *
 * Note what is NOT here: `hqEdge`. Unlike `@huaqiu/dsh-eda-host`, this plugin
 * talks to KiCad directly, so it must never depend on the edge bridge.
 */
export const inject = ['skills', 'tools'] as const

export type { KicadConfig, KicadConfigInput } from './config.js'
export type { KicadError, KicadErrorKind, ScriptRun } from './ipc.js'
export type { KicadScript, ScriptEffect } from './scripts.js'
export type { KicadBundledSkill } from './skills.js'
export { KICAD_SCRIPTS, KICAD_SCRIPT_IDS, kicadScript } from './scripts.js'
export {
  KICAD_SCRIPT_SKILL_ID,
  KICAD_SKILL_IDS,
  KICAD_SKILLS,
  kicadSkill,
} from './skills.js'
export { kicadToolNames } from './tools.js'
export { resolveSkillDir, requireSkillDir, scriptsDir, skillsRoot } from './paths.js'
export { runKicadScript, classifyRun, invokeKicadScript } from './ipc.js'
export { createKicadTools } from './tools.js'

/**
 * The `skills` service as this plugin uses it.
 *
 * `@deepseek-ai/dsh-tools` already augments `Context` with `tools`, but nothing
 * in this workspace augments `skills` — `@deepseek-ai/dsh-skill` is a runtime
 * dependency of the harness, not of this package (we never import it; the
 * service arrives through Cordis injection). Declaring the shape we consume is
 * the same technique `@huaqiu/dsh-eda-host` uses for `hqEdge`.
 */
export interface SkillRegistration {
  /** Skill id — must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` to be discoverable. */
  name: string
  /** Catalog description shown to the model. */
  description: string
  /** Full SKILL.md body. */
  content: string
  /**
   * Discovery source. The DSH registry requires it on every loaded skill and
   * rejects a missing value with "source must be a string" at load time.
   * `'runtime'` is the registry-owned source for plugin-bundled skills.
   */
  source: 'runtime'
  /** Where `references/` and `scripts/` live for progressive disclosure. */
  resourceBase: { kind: 'directory'; path: string }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH skill registry, provided by the `@deepseek-ai/dsh-skill` service. */
    skills: {
      /** Register a plugin-bundled skill; returns its unregister disposer. */
      register(skill: SkillRegistration): () => void
    }
  }
}

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-kicad'
const log = getLogger(COMPONENT)

// Emitted on import, before any Cordis dependency is resolved. Pairs with the
// "node half ready" marker in apply(): if this line is logged but that one is
// not, the `skills`/`tools` services were never provided and this plugin is
// still pending — which is otherwise completely silent. Same idiom as
// `@huaqiu/dsh-eda-host`.
log.info('dsh-kicad: module loaded (waiting for the skills + tools services)')

/**
 * Extract the `description` field from SKILL.md YAML frontmatter.
 *
 * Only the single-line form is supported (quoted or bare), which is what the
 * migrated skills use. Returns `undefined` when absent so the caller can fall
 * back rather than registering a skill with an empty description — DSH ignores
 * frontmatter-less skills entirely, so an empty description would silently
 * break discovery.
 */
export function skillDescription(markdown: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!frontmatter?.[1]) return undefined
  const line = frontmatter[1]
    .split(/\r?\n/)
    .find((candidate) => /^\s*description\s*:/.test(candidate))
  if (!line) return undefined
  const raw = line.slice(line.indexOf(':') + 1).trim()
  const unquoted = raw.replace(/^["']/, '').replace(/["']$/, '')
  return unquoted.length > 0 ? unquoted : undefined
}

/** One bundled skill, as read from disk and ready for `ctx.skills.register()`. */
export interface BundledSkill {
  /** Skill id — equals the directory name and the DSH-catalogued id. */
  name: string
  /** Directory holding SKILL.md, `references/` and `scripts/`. */
  dir: string
  /** Catalogue description (from SKILL.md frontmatter, else the registry). */
  description: string
  /** Full SKILL.md body. */
  content: string
}

/**
 * Read one bundled SKILL.md.
 *
 * Exposed for tests and for callers that want a skill body without loading the
 * plugin (e.g. a packaging check).
 *
 * @param moduleUrl - `import.meta.url` of the calling module.
 * @param skillId - bundled skill id (see `./skills.ts`).
 * @param override - explicit skills root (plugin config or env var).
 */
export function readBundledSkill(
  moduleUrl: string,
  skillId: string,
  override?: string,
): BundledSkill {
  const dir = requireSkillDir(moduleUrl, skillId, override)
  const content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  return {
    dir,
    name: skillId,
    // The shipped frontmatter is authoritative; the registry summary is only a
    // safety net so the catalog can never drift away from the skill body.
    description: skillDescription(content) ?? kicadSkill(skillId).summary,
    content,
  }
}

/**
 * Read one bundled skill, or `null` when the installed package does not carry
 * it.
 *
 * ── Why this degrades instead of throwing ──────────────────────────────────
 * A missing `skills/` tree is a PACKAGING failure, and the honest signal for a
 * packaging failure is a loud error — but not a dead server. `apply()` runs
 * inside the DSH plugin tree: throwing here aborts the whole loader
 * (`plugin tree failed to load`), kills the DSH process, and takes every other
 * plugin and the entire EDA session down with it, for one missing asset.
 *
 * That actually happened: HQ Edge's builtin-plugin staging copied only
 * `package.json` + `lib/`, so `skills/` never reached the bundle and the
 * server could not start at all. The correct blast radius for "this plugin's
 * skill is missing" is "this skill is unavailable", so we log at error level
 * with the exact path and remedy and skip that skill — per skill, so a broken
 * `kicad-ipc` never hides a perfectly good `hardware-design-brief`. The tools
 * are always kept (they fail per-call with a typed `FAILED_PRECONDITION`
 * rather than at load).
 *
 * @param moduleUrl - `import.meta.url` of the calling module.
 * @param skillId - bundled skill id (see `./skills.ts`).
 * @param override - explicit skills root (plugin config or env var).
 */
export function tryReadBundledSkill(
  moduleUrl: string,
  skillId: string,
  override?: string,
): BundledSkill | null {
  try {
    return readBundledSkill(moduleUrl, skillId, override)
  } catch (err) {
    log.error(
      `dsh-kicad: bundled skill "${skillId}" unavailable — continuing degraded, ` +
        'the KiCad tools are registered but will fail until the package is reinstalled',
      {
        expectedDir: resolveSkillDir(moduleUrl, skillId, override),
        error: String((err as Error)?.message ?? err),
      },
    )
    return null
  }
}

/**
 * Host plugin body — register every bundled skill and the KiCad tools.
 *
 * Both halves are registered here so that one installation delivers both. Each
 * skill's `resourceBase` points at its own bundled directory, which is how the
 * agent reaches `references/` and `scripts/` as progressive-disclosure
 * resources.
 *
 * @param ctx - real cordis context (node side).
 * @param config - plugin overlay config (python interpreter, timeouts).
 * @returns disposer — unregisters every skill and tool on plugin dispose.
 */
export function apply(ctx: Context, config: KicadConfigInput = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-kicad requires the DSH `tools` service (ctx.tools.register).')
  }
  if (!ctx.skills || typeof ctx.skills.register !== 'function') {
    throw new Error('@huaqiu/dsh-kicad requires the DSH `skills` service (ctx.skills.register).')
  }

  const resolved = resolveKicadConfig(config)

  // Degraded rather than fatal, per skill: see tryReadBundledSkill.
  const skills = new Map<string, BundledSkill>()
  for (const skillId of KICAD_SKILL_IDS) {
    const skill = tryReadBundledSkill(import.meta.url, skillId, config.skillsDir)
    if (skill) skills.set(skillId, skill)
  }

  // The tools resolve their Python scripts under the script-owning skill's
  // directory, so they use the same path even when that skill itself failed to
  // load — a call then fails with a typed FAILED_PRECONDITION naming the exact
  // script it needed.
  const scriptSkillDir =
    skills.get(KICAD_SCRIPT_SKILL_ID)?.dir ??
    resolveSkillDir(import.meta.url, KICAD_SCRIPT_SKILL_ID, config.skillsDir)

  log.info('applying dsh-kicad node half', {
    hasConfigHost: hasHostConfig(config),
    pythonPath: resolved.pythonPath,
    skillsRoot: skillsRoot(import.meta.url, config.skillsDir),
    skillsRegistered: [...skills.keys()],
    skillsMissing: KICAD_SKILL_IDS.filter((id) => !skills.has(id)),
    scriptSkillDir,
    timeoutMs: resolved.timeoutMs,
  })

  const disposers: Array<() => void> = []

  // ── Skills (bundled, no separate installation) ───────────────────────────
  for (const skill of skills.values()) {
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

  // ── Tools ────────────────────────────────────────────────────────────────
  const tools = createKicadTools({
    scriptsDir: scriptsDir(scriptSkillDir),
    pythonPath: resolved.pythonPath,
    config: resolved,
  })
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool))
  }

  log.info('dsh-kicad node half ready', {
    skills: [...skills.keys()],
    degraded: skills.size < KICAD_SKILL_IDS.length,
    tools: tools.length,
    expectedTools: kicadToolNames().length,
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (err) {
        log.warn('dsh-kicad disposer failed', { error: String((err as Error)?.message ?? err) })
      }
    }
  }
}
