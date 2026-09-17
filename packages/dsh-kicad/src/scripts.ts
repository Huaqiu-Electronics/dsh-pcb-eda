/**
 * Registry of the KiCad IPC script templates bundled with this package.
 *
 * The scripts are the migrated `kicad-agent` executable surface. They live
 * under `skills/kicad-ipc/scripts/` and are shipped verbatim — this module only
 * describes them so the DSH tools and the skill stay in sync. Nothing here
 * reimplements KiCad IPC: the scripts own it (see `./ipc.ts`).
 *
 * @module
 */

/** How one bundled script changes (or does not change) the KiCad board. */
export type ScriptEffect =
  /** Reads only. Safe to run at any time. */
  | 'read'
  /** Mutates the board inside a dropped commit — nothing is persisted. */
  | 'probe'
  /** Mutates the board and pushes the commit. Persists only with `save`. */
  | 'mutate'

export interface KicadScript {
  /** Stable id — the script's file stem. */
  readonly id: string
  /** File name inside `skills/kicad-ipc/scripts/`. */
  readonly file: string
  /** One-line, agent-facing summary of what the script does. */
  readonly summary: string
  /** What the script does to the board. */
  readonly effect: ScriptEffect
  /** Whether the script accepts the shared `--save` flag. */
  readonly supportsSave: boolean
}

/**
 * Every bundled script, keyed by id.
 *
 * Mirrors `skills/kicad-ipc/scripts/` 1:1. Adding a script to the skill means
 * adding it here (and exposing it in `./tools.ts`) — the bundling test asserts
 * that all three stay consistent.
 */
export const KICAD_SCRIPTS: Readonly<Record<string, KicadScript>> = {
  diagnose_ipc_connection: {
    id: 'diagnose_ipc_connection',
    file: 'diagnose_ipc_connection.py',
    summary: 'Check the KiCad IPC connection, API version and open board.',
    effect: 'read',
    supportsSave: false,
  },
  verify_live_ipc: {
    id: 'verify_live_ipc',
    file: 'verify_live_ipc.py',
    summary:
      'Live create/update/clone/zone/delete smoke test inside one dropped commit.',
    effect: 'probe',
    supportsSave: false,
  },
  create_track: {
    id: 'create_track',
    file: 'create_track.py',
    summary: 'Create one straight track on an existing net.',
    effect: 'mutate',
    supportsSave: true,
  },
  create_via: {
    id: 'create_via',
    file: 'create_via.py',
    summary: 'Create one through via on an existing net.',
    effect: 'mutate',
    supportsSave: true,
  },
  update_selected_track_width: {
    id: 'update_selected_track_width',
    file: 'update_selected_track_width.py',
    summary: 'Resize the currently selected tracks and arc tracks.',
    effect: 'mutate',
    supportsSave: true,
  },
  remove_selected_items: {
    id: 'remove_selected_items',
    file: 'remove_selected_items.py',
    summary: 'Delete the current KiCad selection.',
    effect: 'mutate',
    supportsSave: true,
  },
  move_rotate_footprint: {
    id: 'move_rotate_footprint',
    file: 'move_rotate_footprint.py',
    summary: 'Move and/or rotate one footprint selected by reference.',
    effect: 'mutate',
    supportsSave: true,
  },
  add_footprint_from_board_template: {
    id: 'add_footprint_from_board_template',
    file: 'add_footprint_from_board_template.py',
    summary: 'Clone an on-board footprint as a template for a new reference.',
    effect: 'mutate',
    supportsSave: true,
  },
  create_copper_zone: {
    id: 'create_copper_zone',
    file: 'create_copper_zone.py',
    summary: 'Create an unfilled copper zone from a closed polygon.',
    effect: 'mutate',
    supportsSave: true,
  },
  refill_zones: {
    id: 'refill_zones',
    file: 'refill_zones.py',
    summary: 'Wait for existing copper zone fills to complete.',
    effect: 'mutate',
    supportsSave: true,
  },
}

/** The bundled script ids, in registration order. */
export const KICAD_SCRIPT_IDS: readonly string[] = Object.keys(KICAD_SCRIPTS)

/**
 * Look up one script by id.
 * @throws when the id is not part of the bundled set.
 */
export function kicadScript(id: string): KicadScript {
  const script = KICAD_SCRIPTS[id]
  if (!script) {
    throw new Error(`@huaqiu/dsh-kicad: unknown bundled KiCad script "${id}"`)
  }
  return script
}

/** The canonical skill directory name shipped by this package. */
export const KICAD_SKILL_NAME = 'kicad-ipc'
