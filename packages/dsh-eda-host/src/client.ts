/**
 * Transport for `@huaqiu/dsh-eda-host`.
 *
 * DSH → dsh-eda-host → hq-edge → EDA Host is the ONLY production path. This
 * module fetches the semantic netlist and the EDA-independent host information
 * from hq-edge, maps HTTP statuses back to the semantic gRPC error categories,
 * and enforces the single end-to-end request budget. It never parses schematic
 * files and never touches KiCad.
 *
 * @module
 */

import { DEFAULT_REQUEST_TIMEOUT_MS, hostUrlOf, netlistUrlOf, pcbSelectionUrlOf, type EdaHostConfig, type NetlistScope } from './config.js'
import {
  NetlistError,
  type EdaHostCapability,
  type EdaHostInfo,
  type PcbSelection,
  type SchematicNetlist,
} from './types.js'

export interface EdaHostClientDeps {
  fetchImpl?: typeof fetch
  /**
   * Optional late-bound resolver for the HQ Edge base URL. When supplied it is
   * consulted on EVERY request and takes priority over the static `config`
   * value. This lets the node half read the endpoint from the `ctx.hqEdge`
   * service the edge-bridge plugin provides — the same pattern `@huaqiu/
   * dsh-artifacts` and `@huaqiu/dsh-tool-symbol-footprint` use — so the URL is
   * picked up even if this plugin is applied before the bridge, and stays
   * correct in standalone installs where no host is present.
   */
  baseUrlResolver?: () => string | undefined
}

/** Per-call options. `signal` lets DSH cancel a request (see §6 of the task). */
export interface EdaHostRequestOptions {
  signal?: AbortSignal
}

export interface EdaHostClient {
  /** Netlist of the currently selected components. */
  getSelectionNetlist(options?: EdaHostRequestOptions): Promise<SchematicNetlist>
  /** Complete logical netlist for the current project. */
  getProjectNetlist(options?: EdaHostRequestOptions): Promise<SchematicNetlist>
  /** Netlist of the current active schematic page. */
  getActivePageNetlist(options?: EdaHostRequestOptions): Promise<SchematicNetlist>
  /**
   * EDA-independent identity / installation of the host. Presence of a result
   * is the availability signal — `hq.host.v1` has no availability field.
   */
  getEdaHostInfo(options?: EdaHostRequestOptions): Promise<EdaHostInfo>
  /** Capabilities the host currently provides. */
  getEdaHostCapabilities(options?: EdaHostRequestOptions): Promise<EdaHostCapability[]>
  /**
   * Semantic PCB selection of the current PCB editor (hq.pcb.v1
   * PcbSelectionService.GetSelection bridged through hq-edge). An empty
   * selection resolves to an all-empty `PcbSelection` — never an error.
   */
  getPcbSelection(options?: EdaHostRequestOptions): Promise<PcbSelection>
}

/** HTTP status → semantic error kind (see routes/edaHostStatus.ts on hq-edge). */
function statusToKind(status: number): NetlistError['kind'] {
  if (status === 412) return 'FAILED_PRECONDITION'
  if (status === 501) return 'UNIMPLEMENTED'
  if (status === 503) return 'UNAVAILABLE'
  if (status === 504) return 'DEADLINE_EXCEEDED'
  return 'INTERNAL'
}

/** True when a thrown fetch error is an abort/timeout rather than a transport error. */
function isAbortError(err: unknown): boolean {
  const name = (err as Error | undefined)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Combine an optional caller signal with the plugin's own budget.
 *
 * `AbortSignal.any` is not available on every Node version DSH may run on, so
 * fall back to whichever signal exists — the budget is always present, which is
 * what guarantees no request can wait indefinitely.
 */
function resolveSignal(deadlineMs: number, caller?: AbortSignal): AbortSignal | undefined {
  const budget = deadlineMs > 0 ? AbortSignal.timeout(deadlineMs) : undefined
  const signals = [caller, budget].filter((s): s is AbortSignal => Boolean(s))
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  return typeof anyFn === 'function' ? anyFn.call(AbortSignal, signals) : signals[0]
}

/**
 * Extract the semantic `SchematicNetlist` from an hq-edge netlist body.
 *
 * hq-edge now emits a single-level body: `{ netlist: { components, nets } }`.
 * Older hq-edge builds serialized the protobuf envelope
 * (`GetNetListResponse.oneof result`), which produced a second `netlist` level
 * and made every populated design look empty. That legacy shape is unwrapped
 * EXPLICITLY — not silently — and anything else is a hard error, because
 * "malformed" must never masquerade as "empty design".
 */
export function parseNetlistBody(body: unknown): SchematicNetlist {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new NetlistError('INTERNAL', 'eda-host: malformed netlist response from hq-edge')
  }

  let candidate: unknown = (body as { netlist?: unknown }).netlist

  if (
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    (candidate as { components?: unknown }).components === undefined &&
    typeof (candidate as { netlist?: unknown }).netlist === 'object'
  ) {
    // Legacy double-nested envelope — unwrap exactly one level.
    candidate = (candidate as { netlist: unknown }).netlist
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new NetlistError('INTERNAL', 'eda-host: malformed netlist response from hq-edge')
  }

  const { components, nets } = candidate as { components?: unknown; nets?: unknown }

  // proto3 JSON omits empty arrays, so `undefined` is a legitimate empty list.
  if (components !== undefined && !Array.isArray(components)) {
    throw new NetlistError('INTERNAL', 'eda-host: netlist.components is not an array')
  }
  if (nets !== undefined && !Array.isArray(nets)) {
    throw new NetlistError('INTERNAL', 'eda-host: netlist.nets is not an array')
  }

  return {
    components: (components ?? []) as SchematicNetlist['components'],
    nets: (nets ?? []) as SchematicNetlist['nets'],
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Extract a complete `EdaHostInfo` from an hq-edge host-info body.
 *
 * `hq.host.v1` has no availability flags, so the only way to distinguish "the
 * host is here" from "the host is not" is whether this call succeeded at all.
 * That makes the *shape* the contract: proto3 JSON omits default-valued fields,
 * so a host that legitimately reports nothing arrives as `{}`. Rather than let
 * a half-empty object reach the agent — where a missing field could be misread
 * as "not available" — absent values are filled with their proto3 defaults.
 *
 * Values that are present are never reinterpreted; unknown `hostType` strings
 * pass through so a newer host cannot be silently downgraded.
 */
export function parseEdaHostInfo(value: unknown): EdaHostInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NetlistError('INTERNAL', 'eda-host: malformed host info response from hq-edge')
  }

  const raw = value as {
    identity?: { hostType?: unknown; hostName?: unknown; version?: unknown }
    installation?: { applicationPath?: unknown; executables?: unknown }
  }

  const executables = Array.isArray(raw.installation?.executables)
    ? (raw.installation?.executables as unknown[])
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
        .map((e) => ({ name: str(e.name), path: str(e.path) }))
    : []

  return {
    identity: {
      hostType:
        typeof raw.identity?.hostType === 'string'
          ? (raw.identity.hostType as EdaHostInfo['identity']['hostType'])
          : 'EDA_HOST_TYPE_UNSPECIFIED',
      hostName: str(raw.identity?.hostName),
      version: str(raw.identity?.version),
    },
    installation: {
      applicationPath: str(raw.installation?.applicationPath),
      executables,
    },
  }
}

export function createEdaHostClient(
  config: EdaHostConfig,
  deps: EdaHostClientDeps = {},
): EdaHostClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch

  /**
   * Resolve the host endpoint per request. A resolver (ctx.hqEdge) wins over
   * the static config/env value; if neither yields a URL we degrade to the
   * same clear FAILED_PRECONDITION the standalone install path uses.
   */
  function resolveConfig(): EdaHostConfig {
    const baseUrl = deps.baseUrlResolver?.()?.trim() ?? config.hqEdgeBaseUrl?.trim() ?? ''
    if (baseUrl.length === 0) {
      throw new NetlistError(
        'FAILED_PRECONDITION',
        'eda-host: no hq-edge base URL configured (ctx.hqEdge.baseUrl / hqEdgeBaseUrl / ' +
          'HQ_EDGE_BASE_URL) — EDA host tools require the hq-edge bridge.',
      )
    }
    return { ...config, hqEdgeBaseUrl: baseUrl }
  }

  /** Perform one GET and return the parsed JSON body, mapping failures. */
  async function getJson(
    url: string,
    options: EdaHostRequestOptions | undefined,
    what: string,
  ): Promise<unknown> {
    const signal = resolveSignal(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, options?.signal)

    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      // An aborted request is a timeout, never an empty result.
      if (isAbortError(err)) {
        throw new NetlistError(
          'DEADLINE_EXCEEDED',
          `eda-host: ${what} request exceeded its time budget at ${url}`,
        )
      }
      // Connection-level failure: host not running / unreachable.
      throw new NetlistError(
        'UNAVAILABLE',
        `eda-host: cannot reach hq-edge at ${url}: ${String((err as Error)?.message ?? err)}`,
      )
    }

    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as { detail?: unknown }
        if (typeof body.detail === 'string') detail = body.detail
      } catch {
        // non-JSON error body — fall through with empty detail
      }
      throw new NetlistError(
        statusToKind(response.status),
        `eda-host: ${what} request failed (${response.status}${detail ? `: ${detail}` : ''})`,
      )
    }

    return response.json()
  }

  async function fetchScope(
    scope: NetlistScope,
    options?: EdaHostRequestOptions,
  ): Promise<SchematicNetlist> {
    const resolved = resolveConfig()
    const url = netlistUrlOf(resolved, scope)
    return parseNetlistBody(await getJson(url, options, 'netlist'))
  }

  function parsePcbSelection(value: unknown): PcbSelection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NetlistError(
        'INTERNAL',
        'eda-host: malformed PCB selection response from hq-edge',
      )
    }

    const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

    // proto3 JSON omits empty arrays; every field is a repeated list.
    return {
      footprints: asArray((value as Record<string, unknown>).footprints),
      pads: asArray((value as Record<string, unknown>).pads),
      tracks: asArray((value as Record<string, unknown>).tracks),
      arcs: asArray((value as Record<string, unknown>).arcs),
      vias: asArray((value as Record<string, unknown>).vias),
      zones: asArray((value as Record<string, unknown>).zones),
      shapes: asArray((value as Record<string, unknown>).shapes),
      texts: asArray((value as Record<string, unknown>).texts),
      dimensions: asArray((value as Record<string, unknown>).dimensions),
      groups: asArray((value as Record<string, unknown>).groups),
      nets: asArray((value as Record<string, unknown>).nets),
    } as PcbSelection
  }

  return {
    getSelectionNetlist: (options) => fetchScope('selection', options),
    getProjectNetlist: (options) => fetchScope('project', options),
    getActivePageNetlist: (options) => fetchScope('active-page', options),

    getEdaHostInfo: async (options) => {
      const resolved = resolveConfig()
      const url = hostUrlOf(resolved, 'info')
      const body = (await getJson(url, options, 'host info')) as { info?: unknown }

      if (!body || typeof body.info !== 'object' || body.info === null) {
        throw new NetlistError('INTERNAL', 'eda-host: malformed host info response from hq-edge')
      }
      return parseEdaHostInfo(body.info)
    },

    getEdaHostCapabilities: async (options) => {
      const resolved = resolveConfig()
      const url = hostUrlOf(resolved, 'capabilities')
      const body = (await getJson(url, options, 'host capabilities')) as {
        capabilities?: unknown
      }

      if (!body || !Array.isArray(body.capabilities)) {
        throw new NetlistError(
          'INTERNAL',
          'eda-host: malformed host capabilities response from hq-edge',
        )
      }
      return body.capabilities.filter(
        (c): c is EdaHostCapability => typeof c === 'string',
      )
    },

    getPcbSelection: async (options) => {
      const resolved = resolveConfig()
      const url = pcbSelectionUrlOf(resolved)
      const body = (await getJson(url, options, 'pcb selection')) as unknown
      return parsePcbSelection(body)
    },
  }
}
