/**
 * Configuration for `@huaqiu/dsh-pcb-initial-placement`.
 *
 * The plugin carries one knowledge skill plus its Python helpers. Nothing here
 * connects to KiCad: the skill tells the agent how to drive the KiCad IPC API
 * itself, so there is no host/port/timeout configuration to resolve.
 *
 * @module
 */

/** Canonical skill directory name shipped by this package. */
export const PCB_INITIAL_PLACEMENT_SKILL_NAME = 'pcb-initial-placement'

/** Configuration accepted by the plugin's `apply()`. */
export interface PcbInitialPlacementConfig {
  /** Bundled skill directory override (defaults to this package's skills/). */
  skillsDir?: string
}

export type PcbInitialPlacementConfigInput = Partial<PcbInitialPlacementConfig>

/** Environment variable mirroring {@link PcbInitialPlacementConfig.skillsDir}. */
export const SKILLS_DIR_ENV = 'DSH_PCB_INITIAL_PLACEMENT_SKILLS_DIR'

/** Whether any skill-directory override was supplied (used for startup logging). */
export function hasSkillsDirOverride(input: PcbInitialPlacementConfigInput = {}): boolean {
  return Boolean(input.skillsDir ?? process.env[SKILLS_DIR_ENV])
}
