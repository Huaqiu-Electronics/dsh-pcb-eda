/**
 * Resolution of the bundled skill directories at runtime.
 *
 * Every bundled skill ships inside the installed package
 * (`<pkg>/skills/<skill-id>/`), not beside the source tree, so it is located
 * relative to the loaded module. That makes one resolver correct for every
 * install shape:
 *
 *   - built artifact:   `<pkg>/lib/index.mjs`   -> `<pkg>/skills/<skill-id>`
 *   - source (vitest):  `<pkg>/src/index.ts`    -> `<pkg>/skills/<skill-id>`
 *   - npm / git install: identical to the built artifact case
 *
 * `skills` must stay in `package.json` `files[]` or npm strips it and this
 * resolver fails loudly — which is the intended signal, because a `dsh-kicad`
 * without its skills is a broken delivery boundary.
 *
 * The override (`skillsDir` config / `DSH_KICAD_SKILLS_DIR`) is the **skills
 * root**, i.e. the directory that *contains* the skill directories — not one
 * skill's directory. One override therefore relocates the whole set, and the
 * per-skill layout below it is unchanged.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path of the directory holding every bundled skill.
 *
 * Resolution order: an explicit override (config / `DSH_KICAD_SKILLS_DIR`),
 * then the package-relative location.
 *
 * @param moduleUrl - `import.meta.url` of the calling module.
 * @param override - explicit skills root (plugin config or env var).
 * @returns the resolved directory, whether or not it exists yet.
 */
export function skillsRoot(moduleUrl: string, override?: string): string {
  if (override && override.trim().length > 0) return resolve(override)
  const envOverride = process.env['DSH_KICAD_SKILLS_DIR']
  if (envOverride && envOverride.trim().length > 0) return resolve(envOverride)

  // `new URL(moduleUrl).pathname` keeps a leading slash on Windows
  // (`/C:/Users/...`), which `resolve()` then roots at the drive root and turns
  // into `C:\C:\Users\...` — a doubled drive prefix. `fileURLToPath` decodes the
  // file URL into a native path on every platform, so it is the correct input
  // for `dirname`/`resolve`.
  const here = dirname(fileURLToPath(moduleUrl))
  // One level up is right for both `lib/` (built) and `src/` (vitest) because
  // both sit directly under the package root next to `skills/`.
  return resolve(here, '..', 'skills')
}

/**
 * Absolute path of one bundled skill directory.
 *
 * @param moduleUrl - `import.meta.url` of the calling module.
 * @param skillId - bundled skill id; MUST equal the directory name.
 * @param override - explicit skills root (plugin config or env var).
 * @returns the resolved directory, whether or not it exists yet.
 */
export function resolveSkillDir(moduleUrl: string, skillId: string, override?: string): string {
  return join(skillsRoot(moduleUrl, override), skillId)
}

/**
 * Resolve one skill directory and assert the skill is actually present.
 *
 * @throws when `SKILL.md` is missing — this is a packaging failure, not a
 * runtime condition, so it must be loud rather than silently degraded.
 */
export function requireSkillDir(moduleUrl: string, skillId: string, override?: string): string {
  const dir = resolveSkillDir(moduleUrl, skillId, override)
  const skillFile = join(dir, 'SKILL.md')
  if (!existsSync(skillFile)) {
    throw new Error(
      `@huaqiu/dsh-kicad: bundled skill missing at ${skillFile}. ` +
        'The installed package is incomplete — reinstall @huaqiu/dsh-kicad so ' +
        'that its skills/ directory is present.',
    )
  }
  return dir
}

/** Absolute path of the bundled Python script directory inside a skill. */
export function scriptsDir(skillDir: string): string {
  return join(skillDir, 'scripts')
}
