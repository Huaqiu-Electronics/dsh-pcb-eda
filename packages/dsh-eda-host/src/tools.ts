/**
 * Agent tools for `@huaqiu/dsh-eda-host`.
 *
 * Three semantic operations, one per netlist scope:
 *
 *   get_project_netlist     complete logical netlist of the current project
 *   get_selection_netlist   netlist of the currently selected components
 *   get_active_page_netlist netlist of the active schematic page
 *
 * The tools are pure pass-throughs: they call the hq-edge netlist router and
 * return the semantic `SchematicNetlist` as lossless JSON. Errors are
 * propagated with a semantic `kind` (FAILED_PRECONDITION / UNIMPLEMENTED /
 * INTERNAL / UNAVAILABLE) — never converted into a fake empty netlist. A
 * valid-but-empty netlist is `ok: true` with empty `components`/`nets`.
 *
 * @module
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EdaHostClient } from './client.js'
import { NetlistError, type SchematicNetlist } from './types.js'

/** Structural alias of the DSH `JsonValue`. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** The normalized domain values are lossless-JSON plain objects. */
function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

export type NetlistScopeKind = 'project' | 'selection' | 'active_page'

export interface NetlistToolEnv {
  client: EdaHostClient
}

/** Tool execution context (structural view of DSH's ToolRunContext). */
export interface ToolExecLike {
  signal?: AbortSignal
  callId?: string
}

type ScopeResult =
  | { ok: true; scope: NetlistScopeKind; netlist: SchematicNetlist }
  | { ok: false; scope: NetlistScopeKind; error: { kind: string; message: string } }

async function runScope(
  env: NetlistToolEnv,
  scope: NetlistScopeKind,
): Promise<ScopeResult> {
  try {
    let netlist: SchematicNetlist
    if (scope === 'project') netlist = await env.client.getProjectNetlist()
    else if (scope === 'selection') netlist = await env.client.getSelectionNetlist()
    else netlist = await env.client.getActivePageNetlist()

    return { ok: true, scope, netlist }
  } catch (err) {
    const kind =
      err instanceof NetlistError
        ? err.kind
        : ('INTERNAL' as const)
    const message = String((err as Error)?.message ?? err)
    return { ok: false, scope, error: { kind, message } }
  }
}

function scopeDescription(scope: NetlistScopeKind, extra: string): string {
  return (
    `Read the current schematic netlist from the EDA host through hq-edge ` +
    `(DSH → dsh-eda-host → hq-edge → EDA host). ` +
    extra +
    ` The result is a semantic netlist JSON: { ok, scope, netlist: { components[], nets[] } }. ` +
    `Each component has referenceDesignators[], value, manufacturerPartNumber, footprint, ` +
    `description and pins[] (pinNumber, pinName, electricalType); each net has name and ` +
    `pinReferences[] (referenceDesignator, pinNumber). ` +
    `IMPORTANT SEMANTICS: ok:true with empty components/nets is a VALID empty design — do not ` +
    `treat it as a failure. On ok:false, error.kind distinguishes the cause: ` +
    `"FAILED_PRECONDITION" (no EDA host / no live editor — ask the user to open the design in ` +
    `the EDA editor first, then retry), "UNIMPLEMENTED" (this scope is not supported by the ` +
    `current host — do NOT retry; report it to the user), "UNAVAILABLE" (hq-edge host unreachable), ` +
    `"INTERNAL" (host-side failure). Do NOT fabricate netlist data.`
  )
}

export function createNetListTools(env: NetlistToolEnv) {
  const mkTool = (scope: NetlistScopeKind, name: string, desc: string) =>
    defineTool({
      name,
      description: desc,
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(_args: unknown, _exec: ToolExecLike) {
        return asJson(await runScope(env, scope))
      },
    })

  return [
    mkTool(
      'project',
      'get_project_netlist',
      scopeDescription(
        'project',
        'Returns the complete logical netlist for the current project (all sheets, all nets).',
      ),
    ),
    mkTool(
      'selection',
      'get_selection_netlist',
      scopeDescription(
        'selection',
        'Returns the netlist associated with the currently selected schematic components, ' +
          'including the nets they participate in (each net lists every connected pin, not ' +
          'only the selected ones).',
      ),
    ),
    mkTool(
      'active_page',
      'get_active_page_netlist',
      scopeDescription(
        'active_page',
        'Returns the netlist for the currently active schematic page. NOTE: KiCad host does ' +
          'not implement this scope — expect ok:false with error.kind "UNIMPLEMENTED".',
      ),
    ),
  ]
}
