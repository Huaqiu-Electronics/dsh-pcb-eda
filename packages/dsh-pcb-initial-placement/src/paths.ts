/**
 * Resolution of the bundled `pcb-initial-placement` skill directory.
 *
 * The skill ships inside the installed package
 * (`<pkg>/skills/pcb-initial-placement/`). Resolving relative to the loaded
 * module works for source tests, built artifacts and npm installs alike.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PCB_INITIAL_PLACEMENT_SKILL_NAME, SKILLS_DIR_ENV } from './config.js'

/**
 * Absolute path of the bundled skill directory.
 *
 * Resolution order: explicit override, `DSH_PCB_INITIAL_PLACEMENT_SKILLS_DIR`,
 * then the package-relative location.
 */
export function resolveSkillDir(moduleUrl: string, override?: string): string {
  if (override && override.trim().length > 0) return resolve(override)
  const envOverride = process.env[SKILLS_DIR_ENV]
  if (envOverride && envOverride.trim().length > 0) return resolve(envOverride)

  const here = dirname(fileURLToPath(moduleUrl))
  return resolve(here, '..', 'skills', PCB_INITIAL_PLACEMENT_SKILL_NAME)
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
      `@huaqiu/dsh-pcb-initial-placement: bundled skill missing at ${skillFile}. ` +
        'The installed package is incomplete; reinstall ' +
        '@huaqiu/dsh-pcb-initial-placement so that its skills/ directory is present.',
    )
  }
  return dir
}
