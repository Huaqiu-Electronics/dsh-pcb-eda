/**
 * Agent tools for `@huaqiu/hardware-artifacts`.
 *
 *   hardware_projects    which projects/boards this workspace has, and whether
 *                        a `kicad-cli` can export from them
 *   hardware_bom         the grouped BOM of one root schematic
 *   hardware_fabricate   gerber + drill (+ assembly inputs), validated
 *
 * These are the file-based path to fabrication. They take a path, resolve it
 * against the session workspace, and run `kicad-cli` in the board's own
 * directory — no HQ Edge, no open PCB editor, no live KiCad IPC. The order
 * backend (`placeOrder`) is deliberately not exposed here: creating a purchase
 * needs a human decision, and it keeps its own confirmed route.
 *
 * Every tool answers with one `{ ok, ... }` JSON value. A prepared package that
 * fails validation is still a successful call with `ok: false` and the issues:
 * the export ran, the judgement is the finding, and the agent has to relay it
 * rather than retry.
 *
 * @module
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import type { HardwareArtifactService, HardwareProject } from './service.js'

/** Structural alias of the DSH `JsonValue`. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/** Execution identity a tool receives; only the fields used here are named. */
interface ToolExecLike {
  readonly signal?: AbortSignal
  readonly sessionId?: string
  readonly session?: { readonly id?: string }
  readonly context?: { readonly sessionId?: string }
}

export interface HardwareToolEnv {
  readonly service: HardwareArtifactService
  /**
   * Workspace root of one DSH session.
   *
   * The session's own header, never the path the caller typed: that is the same
   * base the HTTP routes authorize against, so an agent call cannot widen what
   * the host would let a panel read.
   */
  readonly workspaceOf: (sessionId?: string) => Promise<string | undefined> | string | undefined
  /** Used when the execution names no session (tests, a bare host). */
  readonly defaultCwd?: () => string
}

/** The DSH session one execution belongs to, spelled however the host spells it. */
function sessionIdOf(exec: unknown): string | undefined {
  const e = exec as ToolExecLike | undefined
  return e?.sessionId ?? e?.session?.id ?? e?.context?.sessionId
}

/** Resolve the scan root: the session workspace, then the process directory. */
async function workspaceOf(env: HardwareToolEnv, exec: unknown): Promise<string> {
  const sessionId = sessionIdOf(exec)
  const declared = await env.workspaceOf(sessionId)
  if (declared !== undefined && declared.trim() !== '') return resolve(declared)
  return resolve(env.defaultCwd?.() ?? process.cwd())
}

/** The roots one call may read: the workspace it was issued from. */
function rootsOf(cwd: string): readonly string[] {
  return [cwd]
}

/** Resolve a caller-supplied path against the workspace. */
function resolveUnder(cwd: string, input: unknown): string {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '') throw new Error('path is required')
  return isAbsolute(text) ? resolve(text) : resolve(cwd, text)
}

/** Compact one project for the model: identity and paths, no per-artifact noise. */
function projectJson(project: HardwareProject, limit = 20): Json {
  return {
    name: project.name,
    path: project.path,
    ...(project.defaultBoard === undefined ? {} : { defaultBoard: project.defaultBoard }),
    ...(project.rootSheet === undefined ? {} : { rootSheet: project.rootSheet.path }),
    ...(project.schematic === undefined ? {} : { schematic: project.schematic.path }),
    boards: project.boards.slice(0, limit).map(board => board.path),
    ...(project.boards.length > limit ? { boardsTruncated: project.boards.length } : {}),
    selectionRequired: project.selectionRequired,
  }
}

function failure(error: unknown): Json {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : 'internal'
  return { ok: false, error: { code, message } }
}

export function createHardwareTools(env: HardwareToolEnv) {
  const { service } = env

  return [
    defineTool({
      name: 'hardware_projects',
      description:
        'List the hardware projects and boards this workspace contains, and whether a KiCad CLI is ' +
        'available to export from them. Use this first when the user names a project or asks what ' +
        'can be manufactured, and before hardware_fabricate when the board path is not already ' +
        'known. Reads the workspace only — no KiCad process is started. Returns project paths, ' +
        'their boards, the deterministic default board (only when ownership is unambiguous), and ' +
        'the resolved kicad-cli path/version. An `issue.code` of "selection-required" means the ' +
        'workspace holds several projects and the user must choose one; never pick for them.',
      parameters: {
        project: {
          type: 'string' as const,
          description:
            'Project (.kicad_pro) path, absolute or relative to the workspace. Omit to discover ' +
            'every project in the workspace.',
        },
        path: {
          type: 'string' as const,
          description: 'Workspace directory to scan. Defaults to the session working directory.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
        const a = (args ?? {}) as Record<string, unknown>
        try {
          const cwd = await workspaceOf(env, exec)
          const base = a.path === undefined ? cwd : resolveUnder(cwd, a.path)
          const sessionId = sessionIdOf(exec)
          const discovery = service.discover(
            base,
            typeof a.project === 'string' ? a.project : undefined,
            sessionId,
          )
          const installed = service.installations().kicad
          return asJson({
            ok: true,
            cwd: discovery.cwd,
            ...(discovery.issue === undefined ? {} : { issue: discovery.issue }),
            projects: discovery.projects.slice(0, 20).map(project => projectJson(project)),
            ...(discovery.projects.length > 20 ? { projectsTruncated: discovery.projects.length } : {}),
            ...(discovery.selected === undefined
              ? {}
              : { selected: projectJson(discovery.selected) }),
            kicad: {
              configured: installed.configured,
              ...(installed.cli === undefined ? {} : { cli: installed.cli }),
              ...(installed.version === undefined ? {} : { version: installed.version }),
              ...(installed.error === undefined ? {} : { error: installed.error }),
            },
          })
        } catch (error) {
          return failure(error)
        }
      },
    }),
    defineTool({
      name: 'hardware_bom',
      description:
        'Read the bill of materials of one KiCad root schematic, grouped by part. Uses KiCad\'s own ' +
        '`kicad-cli sch export bom`, so the rows are what KiCad itself reports — references, value, ' +
        'footprint, quantity and DNP, plus any custom fields (MPN, Manufacturer). Use when the user ' +
        'asks what parts a board needs, for a cost estimate, or to sanity-check assembly. Requires ' +
        'a configured KiCad CLI; returns its error otherwise.',
      parameters: {
        path: {
          type: 'string' as const,
          required: true as const,
          description:
            'Root schematic (.kicad_sch) path, absolute or relative to the workspace. A child ' +
            'sheet returns that sheet only.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
        try {
          const cwd = await workspaceOf(env, exec)
          const artifactPath = resolveUnder(cwd, (args as Record<string, unknown> | undefined)?.path)
          const sessionId = sessionIdOf(exec)
          const bom = await service.exportBom({
            artifactPath,
            roots: rootsOf(cwd),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          })
          return asJson({
            ok: true,
            path: bom.path,
            revision: bom.revision,
            cached: bom.cached,
            source: bom.source,
            lines: bom.rows.length,
            parts: bom.rows.reduce((total, row) => total + row.quantity, 0),
            rows: bom.rows.map(row => ({
              references: row.references,
              quantity: row.quantity,
              value: row.value,
              footprint: row.footprint,
              dnp: row.dnp,
              fields: row.fields,
            })),
          })
        } catch (error) {
          return failure(error)
        }
      },
    }),
    defineTool({
      name: 'hardware_fabricate',
      description:
        'Export and validate the fabrication package for one .kicad_pcb: gerbers, Excellon drill, ' +
        'and — when a schematic is given — the assembly inputs (positions CSV + grouped BOM). Runs ' +
        '`kicad-cli` in the board directory; no PCB editor needs to be open and no HQ Edge service ' +
        'is involved. Returns the board facts read from the file (layers, outline size, thickness, ' +
        'min track/hole, copper weight), the archive manifest, and a `validation` with `ok` plus ' +
        '`errors`/`warnings`. `ok: false` means the package must not be ordered (for example a ' +
        'copper layer that was not plotted, or no board outline): report the issues instead of ' +
        'retrying. Pass `output_dir` when the user wants the files on disk.',
      parameters: {
        path: {
          type: 'string' as const,
          required: true as const,
          description:
            'Board (.kicad_pcb) path, absolute or relative to the workspace.',
        },
        schematic: {
          type: 'string' as const,
          description:
            'Root schematic (.kicad_sch) to add assembly inputs (positions + BOM). Required for an ' +
            'SMT order; omit for fabrication only.',
        },
        output_dir: {
          type: 'string' as const,
          description:
            'Directory to write the package into (created when missing): `<board>.zip`, plus ' +
            'positions/BOM CSVs when assembly inputs were produced. Omit to export and validate ' +
            'without writing files.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
        const a = (args ?? {}) as Record<string, unknown>
        try {
          const cwd = await workspaceOf(env, exec)
          const boardPath = resolveUnder(cwd, a.path)
          const sessionId = sessionIdOf(exec)
          const directory = a.output_dir === undefined ? undefined : resolveUnder(cwd, a.output_dir)
          const prepared = await service.fabricate({
            boardPath,
            ...(typeof a.schematic === 'string' ? { schematicPath: resolveUnder(cwd, a.schematic) } : {}),
            roots: rootsOf(cwd),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(exec.signal === undefined ? {} : { signal: exec.signal }),
          })
          const written = directory === undefined ? undefined : service.writePackage(prepared, directory)
          return asJson({
            ok: prepared.validation.ok,
            boardPath: prepared.boardPath,
            revision: prepared.revision,
            generatedAt: prepared.generatedAt,
            facts: prepared.facts,
            archive: prepared.archive,
            validation: prepared.validation,
            ...(prepared.assembly === undefined ? {} : { assembly: prepared.assembly }),
            ...(written === undefined ? {} : { written }),
          })
        } catch (error) {
          return failure(error)
        }
      },
    }),
  ]
}

/** The tool names this package registers; the bundle test asserts them. */
export function hardwareToolNames(): string[] {
  return ['hardware_projects', 'hardware_bom', 'hardware_fabricate']
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
