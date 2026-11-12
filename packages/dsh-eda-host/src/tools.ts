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
 * One EDA host command (reuses the existing hq.runtime.v1 sync_sch_to_pcb):
 *
 *   sync_schematic_to_pcb      ask the host to synchronize schematic → PCB
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
import { NetlistError, type EdaHostCapability, type EdaHostInfo, type ListSchematicSheetsResult, type PcbSnapshot, type RenderCapabilities, type RenderSchematicResult, type SchematicNetlist, type SchematicSource } from './types.js'

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

type PcbSelectionResult =
  | { ok: true; selection: PcbSnapshot }
  | { ok: false; error: { kind: string; message: string } }

type PcbBoardResult =
  | { ok: true; snapshot: PcbSnapshot }
  | { ok: false; error: { kind: string; message: string } }

type SyncSchematicToPcbResult =
  | { ok: true }
  | { ok: false; error: { kind: string; message: string } }

type RenderCapabilitiesResult =
  | { ok: true; capabilities: RenderCapabilities }
  | { ok: false; error: { kind: string; message: string } }

type ListSchematicSheetsResultEnvelope =
  | { ok: true; sheets: ListSchematicSheetsResult }
  | { ok: false; error: { kind: string; message: string } }

type SchematicRenderResultEnvelope =
  | { ok: true; render: RenderSchematicResult }
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
         `When the host is KiCad, the executable list also carries "kicad-python" — the ` +
         `interpreter bundled with KiCad that owns the official kicad-python package ` +
         `(kipy); the dsh-kicad skills already run with it automatically. ` +
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
       name: 'get_pcb_selection',
       description:
         `Read the semantic PCB selection from the current PCB editor through hq-edge ` +
         `(DSH → dsh-eda-host → hq-edge → EDA host). Returns { ok, selection: { footprints[], ` +
         `pads[], tracks[], arcs[], vias[], zones[], shapes[], texts[], dimensions[], groups[], ` +
         `nets[] } }. ` +
         `Each footprint has reference, value, footprint, position {x,y} in mm, rotationDeg and ` +
         `pads[] (pin, type, shape, position, widthMm, heightMm, rotationDeg, layer, net{name, ` +
         `code}); tracks have layer, start/end in mm, widthMm, lengthMm and net; vias have ` +
         `layers[], drillMm, viaType and start/end; zones have layer, net and outline segments. ` +
         `Every object carries id — the EDA-host native object identity. ` +
         `IMPORTANT: ok:true with all-empty arrays is a VALID empty selection (nothing selected) ` +
         `— do not treat it as a failure. ` +
         ERROR_SEMANTICS,
       parameters: {},
       output: { schema: { type: 'json' }, render: renderJson },
       async execute(_args: unknown, exec: ToolExecLike): Promise<Json> {
         try {
           const options: EdaHostRequestOptions = exec?.signal
             ? { signal: exec.signal }
             : {}
           const selection = await env.client.getPcbSelection(options)
           return asJson<PcbSelectionResult>({ ok: true, selection })
         } catch (err) {
           return asJson<PcbSelectionResult>({ ok: false, error: failureOf(err) })
         }
       },
     }),

     defineTool({
       name: 'get_pcb_board',
       description:
         `Read the COMPLETE semantic PCB board from the current PCB editor through hq-edge ` +
         `(DSH → dsh-eda-host → hq-edge → EDA host). Returns { ok, snapshot: { footprints[], ` +
         `pads[], tracks[], arcs[], vias[], zones[], shapes[], texts[], dimensions[], groups[], ` +
         `nets[] } } — the same shape as get_pcb_selection, but covering every object on the ` +
         `board regardless of selection. ` +
         `Each footprint has reference, value, footprint, position {x,y} in mm, rotationDeg and ` +
         `pads[] (pin, type, shape, position, widthMm, heightMm, rotationDeg, layer, net{name, ` +
         `code}); tracks have layer, start/end in mm, widthMm, lengthMm and net; vias have ` +
         `layers[], drillMm, viaType and start/end; zones have layer, net and outline segments. ` +
         `Every object carries id — the EDA-host native object identity. ` +
         `IMPORTANT: ok:true with all-empty arrays is a VALID empty board — do not treat it as ` +
         `a failure. ` +
         ERROR_SEMANTICS,
       parameters: {},
       output: { schema: { type: 'json' }, render: renderJson },
       async execute(_args: unknown, exec: ToolExecLike): Promise<Json> {
         try {
           const options: EdaHostRequestOptions = exec?.signal
             ? { signal: exec.signal }
             : {}
           const snapshot = await env.client.getPcbBoard(options)
           return asJson<PcbBoardResult>({ ok: true, snapshot })
         } catch (err) {
           return asJson<PcbBoardResult>({ ok: false, error: failureOf(err) })
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

      defineTool({
        name: 'sync_schematic_to_pcb',
        description:
          `Request that the connected EDA host synchronize the current schematic ` +
          `with the PCB through hq-edge (DSH → dsh-eda-host → hq-edge → EDA host). ` +
          `This invokes the host's NATIVE schematic-to-PCB synchronization — the same ` +
          `operation as the host's "Update PCB from Schematic" action — by dispatching the ` +
          `existing hq.runtime.v1.Command.sync_sch_to_pcb command. It does NOT reimplement ` +
          `synchronization in TypeScript and requires no parameters. ` +
          `Returns { ok: true } when the host accepted and executed the synchronization ` +
          `command. A successful result confirms the host ran the command; it does NOT ` +
          `independently verify that every net and footprint is now identical — re-read the ` +
          `netlist (get_project_netlist) or board (get_pcb_board) afterward if you need to ` +
          `confirm the outcome. ` +
          ERROR_SEMANTICS,
        parameters: {},
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(_args: unknown, exec: ToolExecLike): Promise<Json> {
          try {
            const options: EdaHostRequestOptions = exec?.signal
              ? { signal: exec.signal }
              : {}
            await env.client.syncSchematicToPcb(options)
            return asJson<SyncSchematicToPcbResult>({ ok: true })
          } catch (err) {
            return asJson<SyncSchematicToPcbResult>({ ok: false, error: failureOf(err) })
          }
        },
      }),

      // ── Schematic Render (PNG export) ────────────────────────────────────

      defineTool({
        name: 'get_schematic_render_capabilities',
        description:
          `Query the connected EDA host's schematic render capabilities through ` +
          `hq-edge (DSH → dsh-eda-host → hq-edge → EDA host). ` +
          `Uses the hq.services.v1.SchematicRenderService.GetRenderCapabilities ` +
          `RPC. ` +
          `Returns { ok, capabilities } where capabilities reports supportsPng, ` +
          `supportsHierarchy, supportsSheetInstance, supportsRegionRender, ` +
          `maxWidth, maxHeight and related flags. Only PNG is currently supported; ` +
          `other format flags (SVG etc.) are reserved for future use. ` +
          `Call this FIRST before using get_schematic_png_screenshot — a host ` +
          `that does not advertise supportsPng=true will fail the render call. ` +
          ERROR_SEMANTICS,
        parameters: {},
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(_args: unknown, exec: ToolExecLike): Promise<Json> {
          try {
            const options: EdaHostRequestOptions = exec?.signal
              ? { signal: exec.signal }
              : {}
            const capabilities = await env.client.getRenderCapabilities(options)
            return asJson<RenderCapabilitiesResult>({ ok: true, capabilities })
          } catch (err) {
            return asJson<RenderCapabilitiesResult>({ ok: false, error: failureOf(err) })
          }
        },
      }),

      defineTool({
        name: 'list_schematic_sheets',
        description:
          `List the schematic sheets available for PNG rendering on the current ` +
          `project, through hq-edge (DSH → dsh-eda-host → hq-edge → EDA host). ` +
          `Uses the hq.services.v1.SchematicRenderService.ListSchematicSheets ` +
          `RPC. Returns { ok, sheets: { documentId, documentRevision, sheets[] } } ` +
          `where each sheet has instancePath, sheetName, sourcePath and sheetUuid. ` +
          `Call this before get_schematic_png_screenshot when you need to render ` +
          `a specific sheet rather than the currently-active one. ` +
          ERROR_SEMANTICS,
        parameters: {
          source: {
            type: 'string',
            description:
              'Schematic source selector. "SCHEMATIC_SOURCE_ACTIVE_DOCUMENT" (default) uses the currently-open schematic; "SCHEMATIC_SOURCE_DOCUMENT_ID" requires document_id.',
          },
          document_id: {
            type: 'string',
            description: 'Required when source is SCHEMATIC_SOURCE_DOCUMENT_ID.',
          },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
          try {
            const a = args as { source?: SchematicSource; document_id?: string }
            const options: EdaHostRequestOptions = exec?.signal
              ? { signal: exec.signal }
              : {}
            const document =
              a.source && a.source !== 'SCHEMATIC_SOURCE_UNSPECIFIED'
                ? {
                    source: a.source,
                    documentId: a.document_id,
                  }
                : undefined
            const sheets = await env.client.listSchematicSheets(document, options)
            return asJson<ListSchematicSheetsResultEnvelope>({ ok: true, sheets })
          } catch (err) {
            return asJson<ListSchematicSheetsResultEnvelope>({
              ok: false,
              error: failureOf(err),
            })
          }
        },
      }),

      defineTool({
        name: 'get_schematic_png_screenshot',
        description:
          `Render schematic sheets to PNG images through hq-edge ` +
          `(DSH → dsh-eda-host → hq-edge → EDA host). This invokes the host's ` +
          `NATIVE schematic render path — NOT reimplemented in TypeScript. ` +
          `Uses the hq.services.v1.SchematicRenderService.RenderSchematic RPC. ` +
          `Returns { ok, render: { documentId, documentRevision, images[] } } ` +
          `where each image carries base64-encoded PNG data in imageData, plus ` +
          `width/height in pixels and sheetInstancePath. ` +
          `DEFAULT BEHAVIOUR: active_document=true renders only the currently ` +
          `active view as PNG. Set active_document=false to render all sheets. ` +
          `Call get_schematic_render_capabilities first to confirm supportsPng=true; ` +
          `a host that does not support PNG will return ok:false with kind UNIMPLEMENTED. ` +
          ERROR_SEMANTICS,
        parameters: {
          active_document: {
            type: 'boolean',
            description:
              'When true (default): render only the currently-active view. When false: render all sheets.',
          },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
          try {
            const a = args as { active_document?: boolean }
            const options: EdaHostRequestOptions = exec?.signal
              ? { signal: exec.signal }
              : {}
            const render = await env.client.renderSchematic(
              {
                activeDocument: a.active_document ?? true,
                format: 1,
              },
              options,
            )
            return asJson<SchematicRenderResultEnvelope>({ ok: true, render })
          } catch (err) {
            return asJson<SchematicRenderResultEnvelope>({
              ok: false,
              error: failureOf(err),
            })
          }
        },
      }),
   ]
 }