/**
 * Runtime config resolution for `@huaqiu/dsh-eda-host`.
 *
 * The plugin never opens a direct connection to the EDA host — it only talks
 * to `hq-edge`, which owns the host session. The base URL is delivered by the
 * hq-edge supervisor as overlay config (`hqEdgeBaseUrl`), with the
 * `HQ_EDGE_BASE_URL` env as fallback for non-supervisor installs. This mirrors
 * the `@huaqiu/dsh-auth` host-config convention.
 *
 * @module
 */

export interface EdaHostConfig {
  /** HQ Edge base URL, e.g. "http://localhost:18080". Absent → no host. */
  hqEdgeBaseUrl?: string
  /** Path prefix on the host; default "/api/v1/netlist". */
  netlistPathPrefix?: string
}

export const DEFAULT_NETLIST_PATH_PREFIX = '/api/v1/netlist'

/** Scope → route suffix on the host netlist router. */
export type NetlistScope = 'project' | 'selection' | 'active-page'

export const SCOPE_ROUTE: Record<NetlistScope, string> = {
  project: '/project',
  selection: '/selection',
  'active-page': '/active-page',
}

export function resolveEdaHostConfig(
  config?: Partial<EdaHostConfig> | null,
  env: NodeJS.ProcessEnv = process.env,
): EdaHostConfig {
  const baseUrl = config?.hqEdgeBaseUrl ?? env.HQ_EDGE_BASE_URL ?? ''
  const pathPrefix =
    config?.netlistPathPrefix ?? env.HQ_EDGE_NETLIST_PATH ?? DEFAULT_NETLIST_PATH_PREFIX
  return {
    hqEdgeBaseUrl: baseUrl,
    netlistPathPrefix: pathPrefix,
  }
}

/** True when a host base URL is available (host mode). */
export function hasHost(config: EdaHostConfig): boolean {
  return typeof config.hqEdgeBaseUrl === 'string' && config.hqEdgeBaseUrl.trim().length > 0
}

/** Build the absolute URL for one netlist scope. */
export function netlistUrlOf(config: EdaHostConfig, scope: NetlistScope): string {
  const base = (config.hqEdgeBaseUrl ?? '').replace(/\/+$/, '')
  const prefix = (config.netlistPathPrefix ?? DEFAULT_NETLIST_PATH_PREFIX).replace(/^\/+|\/+$/g, '')
  return `${base}/${prefix}${SCOPE_ROUTE[scope]}`
}
