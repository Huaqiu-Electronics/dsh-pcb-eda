/**
 * Resolution of the bundled KiCad skill directory at runtime.
 *
 * The skill ships inside the installed package (`<pkg>/skills/kicad-ipc/`), not
 * beside the source tree, so it is located relative to the loaded module. That
 * makes one resolver correct for every install shape:
 *
 *   - built artifact:   `<pkg>/lib/index.mjs`   -> `<pkg>/skills/kicad-ipc`
 *   - source (vitest):  `<pkg>/src/index.ts`    -> `<pkg>/skills/kicad-ipc`
 *   - npm / git install: identical to the built artifact case
 *
 * `skills` must stay in `package.json` `files[]` or npm strips it and this
 * resolver fails loudly — which is the intended signal, because a `dsh-kicad`
 * without its skill is a broken delivery boundary.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { KICAD_SKILL_NAME } from './scripts.js'

/**
 * Absolute path of the bundled `kicad-ipc` skill directory.
 *
 * Resolution order: an explicit override (config / `DSH_KICAD_SKILLS_DIR`),
 * then the package-relative location.
 *
 * @param moduleUrl - `import.meta.url` of the calling module.
 * @param override - explicit directory (plugin config or env var).
 * @returns the resolved directory, whether or not it exists yet.
 */
export function resolveSkillDir(moduleUrl: string, override?: string): string {
  if (override && override.trim().length > 0) return resolve(override)
  const envOverride = process.env['DSH_KICAD_SKILLS_DIR']
  if (envOverride && envOverride.trim().length > 0) return resolve(envOverride)

  const here = dirname(new URL(moduleUrl).pathname)
  // One level up is right for both `lib/` (built) and `src/` (vitest) because
  // both sit directly under the package root next to `skills/`.
  return resolve(here, '..', 'skills', KICAD_SKILL_NAME)
}

/**
 * Resolve the skill directory and assert the skill is actually present.
 *
 * @throws when `SKILL.md` is missing — this is a packaging failure, not a
 * runtime condition, so it must be loud rather than silently degraded.
 */
export function requireSkillDir(moduleUrl: string, override?: string): string {
  const dir = resolveSkillDir(moduleUrl, override)
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

/** Absolute path of the bundled Python script directory. */
export function scriptsDir(skillDir: string): string {
  return join(skillDir, 'scripts')
}
