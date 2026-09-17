/**
 * Agent tools for `@huaqiu/dsh-eda-host`.
 *
 * Three semantic netlist operations, one per scope:
 *
 *   get_project_netlist     complete logical netlist of the current project
 *   get_selection_netlist   netlist of the currently selected components
 *   get_active_page_netlist netlist of the active schematic page
 *
 * Two EDA host discovery operations:
 *
 *   get_eda_host_info          which host, which version, where it is installed
 *   get_eda_host_capabilities  what the current host can actually do
 *
 * The netlist tools are pure pass-throughs: they call the hq-edge netlist
 * router and return the semantic `SchematicNetlist` as lossless JSON. Errors
 * are propagated with a semantic `kind` (FAILED_PRECONDITION / UNIMPLEMENTED /
 * INTERNAL / UNAVAILABLE / DEADLINE_EXCEEDED) — never converted into a fake
 * empty netlist. A valid-but-empty netlist is `ok: true` with empty
 * `components`/`nets`.
 *
 * @module
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EdaHostClient, EdaHostRequestOptions } from './client.js'
import { NetlistError, type EdaHostCapability, type EdaHostInfo, type SchematicNetlist } from './types.js'

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

type HostInfoResult =
  | { ok: true; info: EdaHostInfo }
  | { ok: false; error: { kind: string; message: string } }

type HostCapabilitiesResult =
  | { ok: true; capabilities: EdaHostCapability[] }
  | { ok: false; error: { kind: string; message: string } }

/**
 * Every failure kind, and what the agent should do about it.
 *
 * Shared by all tools so the prompt contract cannot drift between them.
 */
const ERROR_SEMANTICS =
  `IMPORTANT SEMANTICS: on ok:false, error.kind distinguishes the cause: ` +
  `"FAILED_PRECONDITION" (no EDA host / no live editor — ask the user to open the design in ` +
  `the EDA editor first, then retry), "UNIMPLEMENTED" (this capability is not supported by ` +
  `the current host — do NOT retry; report it to the user), "UNAVAILABLE" (hq-edge / EDA host ` +
  `unreachable), "DEADLINE_EXCEEDED" (the host did not answer in time — retry once, then ` +
  `report), "INTERNAL" (host-side failure). Do NOT fabricate data.`

function failureOf(err: unknown): { kind: string; message: string } {
  const kind = err instanceof NetlistError ? err.kind : ('INTERNAL' as const)
  return { kind, message: String((err as Error)?.message ?? err) }
}

async function runScope(
  env: NetlistToolEnv,
  scope: NetlistScopeKind,
  exec?: ToolExecLike,
): Promise<ScopeResult> {
  const options: EdaHostRequestOptions = exec?.signal ? { signal: exec.signal } : {}
  try {
    let netlist: SchematicNetlist
    if (scope === 'project') netlist = await env.client.getProjectNetlist(options)
    else if (scope === 'selection') netlist = await env.client.getSelectionNetlist(options)
    else netlist = await env.client.getActivePageNetlist(options)

    return { ok: true, scope, netlist }
  } catch (err) {
    return { ok: false, scope, error: failureOf(err) }
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
    `IMPORTANT: ok:true with empty components/nets is a VALID empty design — do not ` +
    `treat it as a failure. ` +
    ERROR_SEMANTICS
  )
}

export function createNetListTools(env: NetlistToolEnv) {
  const mkTool = (scope: NetlistScopeKind, name: string, desc: string) =>
    defineTool({
      name,
      description: desc,
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(_args: unknown, exec: ToolExecLike) {
        return asJson(await runScope(env, scope, exec))
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
        'Returns the netlist for the currently active schematic page. NOTE: the KiCad host ' +
          'does not implement this scope — expect ok:false with error.kind "UNIMPLEMENTED". ' +
          'Check get_eda_host_capabilities before relying on it.',
      ),
    ),
  ]
}

 /**
  * EDA host discovery tools.
  *
  * These expose what the EDA host ALREADY knows and can ALREADY do — they
  * implement no EDA functionality themselves. A capability being advertised is
  * a claim that the host can provide it, nothing more.
  */
 export function createEdaHostTools(env: NetlistToolEnv) {
   return [
     defineTool({
       name: 'get_eda_host_info',
       description:
         `Describe the EDA host currently connected through hq-edge (DSH → dsh-eda-host → ` +
         `hq-edge → EDA host). Returns { ok, info: { identity: { hostType, hostName, version }, ` +
         `installation: { applicationPath, executables[]: { name, path } } } }. ` +
         `Use it when you need factual information about the current EDA environment, such as ` +
         `"what EDA host am I connected to", "what version is it", "where is it installed", ` +
         `or "where is kicad-cli". ` +
         `The returned information is authoritative host-provided ground truth. ` +
         ERROR_SEMANTICS,
       parameters: {},
       output: { schema: { type: 'json' }, render: renderJson },
       async execute(_args: unknown, exec: ToolExecLike): Promise<Json> {
         try {
           const options: EdaHostRequestOptions = exec?.signal
             ? { signal: exec.signal }
             : {}
           const info = await env.client.getEdaHostInfo(options)
           return asJson<HostInfoResult>({ ok: true, info })
         } catch (err) {
           return asJson<HostInfoResult>({ ok: false, error: failureOf(err) })
         }
       },
     }),

     defineTool({
       name: 'get_eda_host_capabilities',
       description:
         `List the capabilities the CURRENT EDA host provides, using EDA-independent capability ` +
         `identifiers such as EDA_HOST_CAPABILITY_NETLIST, EDA_HOST_CAPABILITY_PCB or ` +
         `EDA_HOST_CAPABILITY_BOM. Returns { ok, capabilities: string[] }. ` +
         `This is DISCOVERY, not execution: it reports capabilities already provided by the ` +
         `connected EDA host. Treat the returned capability list as the authoritative runtime ` +
         `contract for the current host. Do not assume a capability is available merely because ` +
         `the EDA application is generally known to support it. Unknown capability identifiers ` +
         `MUST be treated as unsupported. ` +
         ERROR_SEMANTICS,
       parameters: {},
       output: { schema: { type: 'json' }, render: renderJson },
       async execute(_args: unknown, exec: ToolExecLike): Promise<Json> {
         try {
           const options: EdaHostRequestOptions = exec?.signal
             ? { signal: exec.signal }
             : {}
           const capabilities = await env.client.getEdaHostCapabilities(options)
           return asJson<HostCapabilitiesResult>({ ok: true, capabilities })
         } catch (err) {
           return asJson<HostCapabilitiesResult>({ ok: false, error: failureOf(err) })
         }
       },
     }),
   ]
 }