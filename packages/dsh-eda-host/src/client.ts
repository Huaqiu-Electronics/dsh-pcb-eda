/**
 * Netlist transport for `@huaqiu/dsh-eda-host`.
 *
 * DSH → dsh-eda-host → hq-edge → EDA Host is the ONLY production path. This
 * module fetches the semantic netlist from the hq-edge netlist router and
 * maps the HTTP status back to the semantic gRPC error categories. It never
 * parses schematic files and never touches KiCad.
 *
 * @module
 */

import { netlistUrlOf, type EdaHostConfig, type NetlistScope } from './config.js'
import {
  NetlistError,
  type SchematicNetlist,
} from './types.js'

export interface EdaHostClientDeps {
  fetchImpl?: typeof fetch
}

export interface EdaHostClient {
  /** Netlist of the currently selected components. */
  getSelectionNetlist(): Promise<SchematicNetlist>
  /** Complete logical netlist for the current project. */
  getProjectNetlist(): Promise<SchematicNetlist>
  /** Netlist of the current active schematic page. */
  getActivePageNetlist(): Promise<SchematicNetlist>
}

/** HTTP status → semantic error kind (see routes/netlist.ts on hq-edge). */
function statusToKind(status: number): NetlistError['kind'] {
  if (status === 412) return 'FAILED_PRECONDITION'
  if (status === 501) return 'UNIMPLEMENTED'
  if (status === 503) return 'UNAVAILABLE'
  return 'INTERNAL'
}

export function createEdaHostClient(
  config: EdaHostConfig,
  deps: EdaHostClientDeps = {},
): EdaHostClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch

  async function fetchScope(scope: NetlistScope): Promise<SchematicNetlist> {
    const url = netlistUrlOf(config, scope)

    let response: Response
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } })
    } catch (err) {
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
        `eda-host: netlist request failed (${response.status}${detail ? `: ${detail}` : ''})`,
      )
    }

    // Valid (possibly empty) result: { netlist: { components, nets } }.
    const body = (await response.json()) as { netlist?: SchematicNetlist }
    if (!body || typeof body.netlist !== 'object' || body.netlist === null) {
      throw new NetlistError('INTERNAL', 'eda-host: malformed netlist response from hq-edge')
    }

    const netlist = body.netlist
    netlist.components ??= []
    netlist.nets ??= []
    return netlist
  }

  return {
    getSelectionNetlist: () => fetchScope('selection'),
    getProjectNetlist: () => fetchScope('project'),
    getActivePageNetlist: () => fetchScope('active-page'),
  }
}
