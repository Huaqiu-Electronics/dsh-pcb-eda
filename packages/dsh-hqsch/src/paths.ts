/**
 * Resolution of the bundled HQSCH scenario-b skill directory at runtime.
 *
 * The skill ships inside the installed package
 * (`<pkg>/skills/hqsch-scenario-b/`), not beside a separate checkout. Resolving
 * relative to the loaded module works for source tests, built artifacts and npm
 * installs.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HQSCH_SKILL_NAME } from './config.js'

/**
 * Absolute path of the bundled HQSCH scenario-b skill directory.
 *
 * Resolution order: explicit override, `DSH_HQSCH_SKILLS_DIR`, then the
 * package-relative location.
 */
export function resolveSkillDir(moduleUrl: string, override?: string): string {
  if (override && override.trim().length > 0) return resolve(override)
  const envOverride = process.env['DSH_HQSCH_SKILLS_DIR']
  if (envOverride && envOverride.trim().length > 0) return resolve(envOverride)

  const here = dirname(fileURLToPath(moduleUrl))
  return resolve(here, '..', 'skills', HQSCH_SKILL_NAME)
}

/**
 * Resolve the skill directory and assert the skill is actually present.
 *
 * @throws when `SKILL.md` is missing.
 */
export function requireSkillDir(moduleUrl: string, override?: string): string {
  const dir = resolveSkillDir(moduleUrl, override)
  const skillFile = join(dir, 'SKILL.md')
  if (!existsSync(skillFile)) {
    throw new Error(
      `@huaqiu/dsh-hqsch: bundled skill missing at ${skillFile}. ` +
        'The installed package is incomplete; reinstall @huaqiu/dsh-hqsch so ' +
        'that its skills/ directory is present.',
    )
  }
  return dir
}
