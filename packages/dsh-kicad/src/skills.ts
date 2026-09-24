/**
 * Registry of the skills bundled with this package.
 *
 * The skills under `skills/` are the migrated `kicad-agent` knowledge, shipped
 * verbatim (see `README.md` and `docs/dsh-kicad-migration.md`) — this module
 * only *describes* them, so `apply()` can register each one with
 * `ctx.skills.register()` without hardcoding paths or names.
 *
 * The registry is the single source of truth for three things that must not
 * drift apart:
 *
 *   - the DSH skill id, which MUST equal the directory name under `skills/`
 *     (the bundling tests assert this, because a mismatch silently produces a
 *     skill whose `resourceBase` points somewhere else);
 *   - the fallback catalogue description, used only when SKILL.md frontmatter
 *     has no parseable `description` (the shipped file always wins);
 *   - which skill owns the Python script templates the KiCad tools run.
 *
 * Adding a skill from `kicad-agent` means: copy the directory, add an entry
 * here, and register it — nothing else in `src/` is skill-specific.
 *
 * @module
 */

/** A skill this package bundles and registers at load time. */
export interface KicadBundledSkill {
  /** DSH skill id — must match the directory name under `skills/`. */
  readonly id: string
  /**
   * Agent-facing catalogue description, used ONLY when the bundled SKILL.md has
   * no parseable `description` frontmatter. The shipped file is authoritative,
   * so this cannot be the normal path — DSH ignores a skill without a
   * description, so an empty value here would silently break discovery.
   */
  readonly summary: string
  /**
   * Whether this skill owns `skills/<id>/scripts/` — the runnable Python
   * templates that back the DSH tools. Exactly one bundled skill does; the
   * tools resolve their interpreter scripts through it (`./paths.ts`).
   */
  readonly ownsScripts: boolean
}

/**
 * The skill that owns the script templates behind the KiCad tools.
 *
 * The tools are the *executable* half of this skill: `kicad_pcb_*` shells out
 * to `skills/kicad-ipc/scripts/*.py`. Kept as a named constant because the
 * tools must keep resolving correctly even when that particular skill fails to
 * load (they then fail per-call with a typed `FAILED_PRECONDITION` instead of
 * silently pointing at another skill's directory).
 */
export const KICAD_SCRIPT_SKILL_ID = 'kicad-ipc'

/**
 * Every skill bundled with `@huaqiu/dsh-kicad`, keyed by id.
 *
 * Mirrors `skills/` 1:1 — the bundling test asserts that every entry exists on
 * disk with a valid SKILL.md, and that no directory is left unregistered.
 */
export const KICAD_SKILLS: Readonly<Record<string, KicadBundledSkill>> = {
  [KICAD_SCRIPT_SKILL_ID]: {
    id: KICAD_SCRIPT_SKILL_ID,
    summary:
      'Operate a KiCad PCB through the official KiCad IPC API: inspect the live ' +
      'board and create, modify or delete objects. Use for PCB automation and ' +
      'autorouter-result import — not for editing .kicad_pcb files directly.',
    ownsScripts: true,
  },
  'hardware-design-brief': {
    id: 'hardware-design-brief',
    summary:
      'Turn a market need into verifiable hardware requirements: clarify them ' +
      'through staged questioning and write the market MRD, the hardware PRD ' +
      'and the schematic/PCB design inputs. Use when defining requirements for ' +
      'a new board project.',
    ownsScripts: false,
  },
}

/** The bundled skill ids, in registration order. */
export const KICAD_SKILL_IDS: readonly string[] = Object.keys(KICAD_SKILLS)

/**
 * Look up one bundled skill by id.
 * @throws when the id is not part of the bundled set.
 */
export function kicadSkill(id: string): KicadBundledSkill {
  const skill = KICAD_SKILLS[id]
  if (!skill) {
    throw new Error(`@huaqiu/dsh-kicad: unknown bundled skill "${id}"`)
  }
  return skill
}
