/**
 * Agent tools for `@huaqiu/dsh-kicad`.
 *
 * Ten tools, one per migrated `kicad-agent` script — a 1:1 preserve mapping
 * (task §10): no script is split, merged or invented. The tools are the
 * *executable interface*; `skills/kicad-ipc/SKILL.md` is the *reasoning* around
 * them (§11). Tool descriptions therefore describe board-level intent and
 * outcomes, never RPC mechanics.
 *
 * Every tool returns the same envelope:
 *
 *   { ok: true,  script, effect, output }      KiCad's own report, verbatim
 *   { ok: false, script, effect, error: { kind, message } }
 *
 * Nothing here fabricates board state. A successful call means the script
 * exited 0 and *verified* its own result inside KiCad — but per §9.5 the agent
 * must still re-read affected state after an important mutation rather than
 * trusting the return value alone.
 *
 * @module
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { type KicadConfig } from './config.js'
import {
  classifyRun,
  invokeKicadScript,
  runKicadScript,
  type KicadError,
  type KicadErrorKind,
} from './ipc.js'
import { kicadScript, type ScriptEffect } from './scripts.js'

/** Structural alias of the DSH `JsonValue`. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Result envelope shared by every KiCad tool. */
export type KicadToolResult =
  | { ok: true; script: string; effect: ScriptEffect; output: string }
  | {
      ok: false
      script: string
      effect: ScriptEffect
      error: KicadError
      diagnostics?: { exitCode: number | null; stderr: string }
    }

/** Everything a tool needs to reach the bundled scripts. */
export interface KicadToolEnv {
  /** Directory holding the bundled Python scripts. */
  scriptsDir: string
  /** Python interpreter with `kipy`. */
  pythonPath: string
  config: KicadConfig
}

/** Structural view of DSH's `ToolRunContext`. */
export interface ToolExecLike {
  signal?: AbortSignal
  callId?: string
}

/**
 * Shared failure semantics appended to every description.
 *
 * Kept in one place so the prompt contract cannot drift between tools — the
 * same idiom as `@huaqiu/dsh-eda-host`.
 */
const ERROR_SEMANTICS =
  `IMPORTANT SEMANTICS: on ok:false, error.kind distinguishes the cause: ` +
  `"FAILED_PRECONDITION" (KiCad IPC cannot run at all — no kipy, API version ` +
  `mismatch, or no .kicad_pcb open; ask the user to fix the environment, do NOT ` +
  `retry), "UNAVAILABLE" (KiCad is installed but unreachable — retry once after ` +
  `checking PCB Editor is open, the KiCad API service is enabled, and DSH has ` +
  `Full Access), "DEADLINE_EXCEEDED" (KiCad did not answer in time — retry a ` +
  `read once; for a write, re-read board state first), "INVALID_ARGUMENT" (the ` +
  `board was not touched — fix units/ranges and retry), "INTERNAL" (KiCad or ` +
  `the script failed; the commit was dropped so the board is unchanged). ` +
  `Do NOT fabricate board state from a failed call.`

/** Reading-only tools are safe to run alongside each other. */
const READ_ONLY = { isConcurrencySafe: () => true }
/** Mutating tools must never be batched into a parallel group. */
const MUTATING = { isConcurrencySafe: () => false }

/** Build a semantic failure envelope from a raw script run. */
function failureEnvelope(
  scriptId: string,
  effect: ScriptEffect,
  error: KicadError,
  run?: { exitCode: number | null; stderr: string },
): KicadToolResult {
  return {
    ok: false,
    script: scriptId,
    effect,
    error,
    ...(run ? { diagnostics: { exitCode: run.exitCode, stderr: run.stderr } } : {}),
  }
}

/** Reject arguments the script would reject, before spawning a process. */
function invalidArgument(scriptId: string, effect: ScriptEffect, message: string): KicadToolResult {
  return failureEnvelope(scriptId, effect, { kind: 'INVALID_ARGUMENT' as KicadErrorKind, message })
}

/** Format millimetres compactly without trailing float noise. */
function mm(value: number): string {
  return String(Number.isInteger(value) ? value : Number(value.toFixed(6)))
}

/** Build `--flag value` pairs, skipping undefined optionals. */
function flags(pairs: Array<[string, string | undefined]>): string[] {
  const argv: string[] = []
  for (const [flag, value] of pairs) {
    if (value !== undefined) argv.push(flag, value)
  }
  return argv
}

/** Build a bare `--flag` for boolean switches. */
function switchFlag(flag: string, on: boolean | undefined): string[] {
  return on === true ? [flag] : []
}

/**
 * All KiCad tools contributed by this plugin.
 */
export function createKicadTools(env: KicadToolEnv): ReturnType<typeof defineTool>[] {
  const { scriptsDir, pythonPath, config } = env

  /**
   * Shared executor: run one script and translate it into the envelope.
   */
  async function run(
    scriptId: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<KicadToolResult> {
    const script = kicadScript(scriptId)
    const run_ = await runKicadScript({
      scriptsDir,
      pythonPath,
      script,
      args,
      timeoutMs,
      ...(signal ? { signal } : {}),
    })
    const error = classifyRun(run_)
    if (error) return failureEnvelope(scriptId, script.effect, error, run_)
    return {
      ok: true,
      script: scriptId,
      effect: script.effect,
      output: run_.stdout,
    }
  }

  const saveFlag = (save?: boolean) => switchFlag('--save', save)

  return [
    // ── Diagnostics ────────────────────────────────────────────────────────
    defineTool({
      name: 'kicad_ipc_diagnose',
      description:
        `Check whether KiCad IPC is usable right now: reports the KiCad version, ` +
        `whether kicad-python matches it, and the name of the currently open PCB. ` +
        `Returns { ok, script, effect, output } where output is KiCad's own report. ` +
        `Use this FIRST before any KiCad read or write, and whenever a KiCad tool ` +
        `fails — it separates "environment is wrong" from "KiCad is busy". ` +
        `Read-only: it never modifies or saves the board. ` +
        ERROR_SEMANTICS,
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.diagnosticTimeoutMs,
      ...READ_ONLY,
      async execute(_args: unknown, exec: ToolExecLike) {
        return asJson(
          await run('diagnose_ipc_connection', [], config.diagnosticTimeoutMs, exec?.signal),
        )
      },
    }),

    defineTool({
      name: 'kicad_ipc_verify_live',
      description:
        `Run the bundled KiCad IPC smoke test: it creates, updates, clones, zones ` +
        `and deletes objects — then DROPS the commit, so nothing is persisted and ` +
        `the board is left exactly as it was. Use it to prove a KiCad IPC ` +
        `installation can really mutate before attempting a real edit. ` +
        `Requires an existing GND net and at least one footprint on the board, and ` +
        `must not be run while the GUI holds unsaved edits. ` +
        ERROR_SEMANTICS,
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(_args: unknown, exec: ToolExecLike) {
        return asJson(await run('verify_live_ipc', [], config.timeoutMs, exec?.signal))
      },
    }),

    // ── Creation ───────────────────────────────────────────────────────────
    defineTool({
      name: 'kicad_pcb_create_track',
      description:
        `Create one straight copper track on an EXISTING net of the open KiCad ` +
        `PCB. All coordinates and the width are millimetres. The net must already ` +
        `exist on the board — this tool never invents one; sync nets from the ` +
        `schematic first if a name does not resolve. The change is committed as a ` +
        `single KiCad undo step and verified against KiCad's returned object; ` +
        `the board file is only written when save is true. ` +
        `Returns the created track id in output. ` +
        ERROR_SEMANTICS,
      parameters: {
        net: { type: 'string', required: true, description: 'Existing PCB net name, e.g. "GND".' },
        start_x_mm: { type: 'number', required: true, description: 'Start X in millimetres.' },
        start_y_mm: { type: 'number', required: true, description: 'Start Y in millimetres.' },
        end_x_mm: { type: 'number', required: true, description: 'End X in millimetres.' },
        end_y_mm: { type: 'number', required: true, description: 'End Y in millimetres.' },
        width_mm: { type: 'number', required: true, description: 'Track width in millimetres, > 0.' },
        layer: {
          type: 'string',
          description: 'Target copper layer, e.g. "F.Cu" or "B.Cu". Defaults to F.Cu. Must be enabled on the board.',
        },
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad after a verified success. Default false — the edit stays in KiCad only.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as {
          net: string
          start_x_mm: number
          start_y_mm: number
          end_x_mm: number
          end_y_mm: number
          width_mm: number
          layer?: string
          save?: boolean
        }
        if (!(a.width_mm > 0)) {
          return asJson(
            invalidArgument('create_track', 'mutate', 'width_mm must be greater than 0.'),
          )
        }
        const argv = [
          ...flags([
            ['--net', a.net],
            ['--start', `${mm(a.start_x_mm)},${mm(a.start_y_mm)}`],
            ['--end', `${mm(a.end_x_mm)},${mm(a.end_y_mm)}`],
            ['--width-mm', mm(a.width_mm)],
            ['--layer', a.layer],
          ]),
          ...saveFlag(a.save),
        ]
        return asJson(await run('create_track', argv, config.timeoutMs, exec?.signal))
      },
    }),

    defineTool({
      name: 'kicad_pcb_create_via',
      description:
        `Create one through-hole via on an EXISTING net of the open KiCad PCB. ` +
        `All dimensions are millimetres and must satisfy 0 < drill < diameter. ` +
        `The net must already exist on the board. The change is a single KiCad ` +
        `undo step and is verified against KiCad's returned object. ` +
        `Returns the created via id in output. ` +
        ERROR_SEMANTICS,
      parameters: {
        net: { type: 'string', required: true, description: 'Existing PCB net name, e.g. "GND".' },
        x_mm: { type: 'number', required: true, description: 'Via X position in millimetres.' },
        y_mm: { type: 'number', required: true, description: 'Via Y position in millimetres.' },
        diameter_mm: { type: 'number', required: true, description: 'Outer diameter in millimetres.' },
        drill_mm: { type: 'number', required: true, description: 'Drill diameter in millimetres, must be < diameter_mm.' },
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad after a verified success. Default false.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as {
          net: string
          x_mm: number
          y_mm: number
          diameter_mm: number
          drill_mm: number
          save?: boolean
        }
        if (!(0 < a.drill_mm && a.drill_mm < a.diameter_mm)) {
          return asJson(
            invalidArgument(
              'create_via',
              'mutate',
              'Require 0 < drill_mm < diameter_mm.',
            ),
          )
        }
        const argv = [
          ...flags([
            ['--net', a.net],
            ['--x-mm', mm(a.x_mm)],
            ['--y-mm', mm(a.y_mm)],
            ['--diameter-mm', mm(a.diameter_mm)],
            ['--drill-mm', mm(a.drill_mm)],
          ]),
          ...saveFlag(a.save),
        ]
        return asJson(await run('create_via', argv, config.timeoutMs, exec?.signal))
      },
    }),

    defineTool({
      name: 'kicad_pcb_create_copper_zone',
      description:
        `Create one UNFILLED copper zone on an EXISTING net of the open KiCad ` +
        `PCB from a closed polygon. The polygon is given as ordered vertices in ` +
        `millimetres; a closing vertex is added automatically. The zone is created ` +
        `for review only — run kicad_pcb_refill_zones afterwards to fill it. ` +
        `The net must already exist on the board. ` +
        ERROR_SEMANTICS,
      parameters: {
        net: { type: 'string', required: true, description: 'Existing PCB net name, e.g. "GND".' },
        points: {
          type: 'array',
          required: true,
          description: 'Outline vertices in millimetres, in order; at least three distinct points.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x_mm: { type: 'number', required: true, description: 'Vertex X in millimetres.' },
              y_mm: { type: 'number', required: true, description: 'Vertex Y in millimetres.' },
            },
          },
        },
        layer: {
          type: 'string',
          description: 'Target copper layer, e.g. "F.Cu". Defaults to F.Cu. Must be enabled on the board.',
        },
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad after a verified success. Default false.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as {
          net: string
          points: Array<{ x_mm: number; y_mm: number }>
          layer?: string
          save?: boolean
        }
        if (!Array.isArray(a.points) || a.points.length < 3) {
          return asJson(
            invalidArgument(
              'create_copper_zone',
              'mutate',
              'points needs at least three vertices.',
            ),
          )
        }
        const polygon = a.points.map((p) => `${mm(p.x_mm)},${mm(p.y_mm)}`).join(';')
        const argv = [
          ...flags([['--net', a.net], ['--points', polygon], ['--layer', a.layer]]),
          ...saveFlag(a.save),
        ]
        return asJson(await run('create_copper_zone', argv, config.timeoutMs, exec?.signal))
      },
    }),

    defineTool({
      name: 'kicad_pcb_add_footprint_from_template',
      description:
        `Add a new footprint to the open KiCad PCB by cloning an existing ` +
        `on-board footprint as the template, then offsetting the clone. Use this ` +
        `when the user wants another instance of a footprint already placed; ` +
        `there is no public API to place directly from a library — report that ` +
        `gap instead of editing board files. new_reference must be unique on the ` +
        `board and different from source_reference. ` +
        ERROR_SEMANTICS,
      parameters: {
        source_reference: {
          type: 'string',
          required: true,
          description: 'Reference of the existing footprint to clone, e.g. "R1".',
        },
        new_reference: {
          type: 'string',
          required: true,
          description: 'Unique reference for the new footprint, e.g. "R2".',
        },
        dx_mm: { type: 'number', required: true, description: 'X offset from the template, millimetres.' },
        dy_mm: { type: 'number', required: true, description: 'Y offset from the template, millimetres.' },
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad after a verified success. Default false.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as {
          source_reference: string
          new_reference: string
          dx_mm: number
          dy_mm: number
          save?: boolean
        }
        if (a.new_reference === a.source_reference) {
          return asJson(
            invalidArgument(
              'add_footprint_from_board_template',
              'mutate',
              'new_reference must differ from source_reference.',
            ),
          )
        }
        const argv = [
          ...flags([
            ['--source-reference', a.source_reference],
            ['--new-reference', a.new_reference],
            ['--dx-mm', mm(a.dx_mm)],
            ['--dy-mm', mm(a.dy_mm)],
          ]),
          ...saveFlag(a.save),
        ]
        return asJson(
          await run('add_footprint_from_board_template', argv, config.timeoutMs, exec?.signal),
        )
      },
    }),

    // ── Modification ───────────────────────────────────────────────────────
    defineTool({
      name: 'kicad_pcb_move_rotate_footprint',
      description:
        `Move and/or rotate one footprint on the open KiCad PCB, selected by its ` +
        `reference designator. Offsets are relative, rotation is incremental, in ` +
        `degrees. At least one of dx_mm / dy_mm / rotation_deg must be non-zero. ` +
        `The footprint is re-read from the board before the change, so KiCad's ` +
        `UUID and the rest of its properties are preserved. ` +
        ERROR_SEMANTICS,
      parameters: {
        reference: {
          type: 'string',
          required: true,
          description: 'Footprint reference designator, e.g. "R1". Must match exactly one footprint.',
        },
        dx_mm: { type: 'number', description: 'Relative X offset in millimetres. Default 0.' },
        dy_mm: { type: 'number', description: 'Relative Y offset in millimetres. Default 0.' },
        rotation_deg: { type: 'number', description: 'Incremental rotation in degrees. Default 0.' },
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad after a verified success. Default false.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as {
          reference: string
          dx_mm?: number
          dy_mm?: number
          rotation_deg?: number
          save?: boolean
        }
        if ((a.dx_mm ?? 0) === 0 && (a.dy_mm ?? 0) === 0 && (a.rotation_deg ?? 0) === 0) {
          return asJson(
            invalidArgument(
              'move_rotate_footprint',
              'mutate',
              'Specify at least one non-zero dx_mm, dy_mm or rotation_deg.',
            ),
          )
        }
        const argv = [
          ...flags([
            ['--reference', a.reference],
            ['--dx-mm', mm(a.dx_mm ?? 0)],
            ['--dy-mm', mm(a.dy_mm ?? 0)],
            ['--rotation-deg', mm(a.rotation_deg ?? 0)],
          ]),
          ...saveFlag(a.save),
        ]
        return asJson(await run('move_rotate_footprint', argv, config.timeoutMs, exec?.signal))
      },
    }),

    defineTool({
      name: 'kicad_pcb_update_selected_track_width',
      description:
        `Resize the tracks and arc tracks currently SELECTED in KiCad's PCB ` +
        `Editor to a new width in millimetres. This operates on KiCad's live ` +
        `selection, so inspect the selection first and confirm it contains ` +
        `exactly what the user meant — the tool cannot narrow a vague scope for ` +
        `you. Objects are re-read from the board before the update. ` +
        ERROR_SEMANTICS,
      parameters: {
        width_mm: { type: 'number', required: true, description: 'Target track width in millimetres, > 0.' },
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad after a verified success. Default false.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as { width_mm: number; save?: boolean }
        if (!(a.width_mm > 0)) {
          return asJson(
            invalidArgument(
              'update_selected_track_width',
              'mutate',
              'width_mm must be greater than 0.',
            ),
          )
        }
        const argv = [...flags([['--width-mm', mm(a.width_mm)]]), ...saveFlag(a.save)]
        return asJson(
          await run('update_selected_track_width', argv, config.timeoutMs, exec?.signal),
        )
      },
    }),

    defineTool({
      name: 'kicad_pcb_refill_zones',
      description:
        `Wait for the copper zones on the open KiCad PCB to be filled. Call this ` +
        `after reviewing a zone created with kicad_pcb_create_copper_zone, or ` +
        `after any edit that invalidated fills. Filling is a board mutation and ` +
        `can legitimately take up to about two minutes, so the timeout is longer ` +
        `than for the other tools. Re-read the zones afterwards to confirm. ` +
        ERROR_SEMANTICS,
      parameters: {
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad once fills complete. Default false.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.refillTimeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as { save?: boolean }
        return asJson(
          await run('refill_zones', saveFlag(a.save), config.refillTimeoutMs, exec?.signal),
        )
      },
    }),

    // ── Deletion ───────────────────────────────────────────────────────────
    defineTool({
      name: 'kicad_pcb_remove_selected_items',
      description:
        `Delete everything currently SELECTED in KiCad's PCB Editor. ` +
        `confirm must be explicitly true — this is the guard against accidental ` +
        `bulk deletion. Before calling it, report to the user exactly what is ` +
        `selected and how many objects will go; never default the scope to "all ` +
        `tracks" or "all objects". Prefer keeping user hand-routing unless it is ` +
        `explicitly in scope. ` +
        ERROR_SEMANTICS,
      parameters: {
        confirm: {
          type: 'boolean',
          required: true,
          description: 'Must be true to authorise deleting the current selection.',
        },
        save: {
          type: 'boolean',
          description: 'Persist the board to disk via KiCad after the deletion. Default false.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: config.timeoutMs,
      ...MUTATING,
      async execute(args: unknown, exec: ToolExecLike) {
        const a = args as { confirm: boolean; save?: boolean }
        if (a.confirm !== true) {
          return asJson(
            invalidArgument(
              'remove_selected_items',
              'mutate',
              'Deletion requires confirm: true, once the selection has been reported to the user.',
            ),
          )
        }
        const argv = [...switchFlag('--yes', true), ...saveFlag(a.save)]
        return asJson(await run('remove_selected_items', argv, config.timeoutMs, exec?.signal))
      },
    }),
  ]
}

/**
 * Names of every tool this plugin registers — asserted by the tests and used
 * for startup logging.
 */
export function kicadToolNames(): string[] {
  return [
    'kicad_ipc_diagnose',
    'kicad_ipc_verify_live',
    'kicad_pcb_create_track',
    'kicad_pcb_create_via',
    'kicad_pcb_create_copper_zone',
    'kicad_pcb_add_footprint_from_template',
    'kicad_pcb_move_rotate_footprint',
    'kicad_pcb_update_selected_track_width',
    'kicad_pcb_refill_zones',
    'kicad_pcb_remove_selected_items',
  ]
}

export { classifyRun, invokeKicadScript }
