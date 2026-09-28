/**
 * Configuration for `@huaqiu/dsh-hqsch`.
 *
 * This plugin only bundles and registers the HQSCH scenario-b skill. The skill
 * itself guides the agent to generate and run local TypeScript scripts against
 * HQ EDA, so there is no host connection configured here.
 *
 * @module
 */

/** Canonical skill directory name shipped by this package. */
export const HQSCH_SKILL_NAME = 'hqsch-scenario-b'

/** Configuration accepted by the plugin's `apply()`. */
export interface HqschConfig {
  /** Bundled skill directory override (defaults to this package's skills/). */
  skillsDir?: string
}

export type HqschConfigInput = Partial<HqschConfig>

/** Whether any host configuration was supplied (used for startup logging). */
export function hasHostConfig(input: HqschConfigInput = {}): boolean {
  return Boolean(input.skillsDir ?? process.env['DSH_HQSCH_SKILLS_DIR'])
}
