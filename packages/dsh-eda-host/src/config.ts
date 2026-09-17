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
  /** Path prefix for host discovery; default "/api/v1/host". */
  hostPathPrefix?: string
  /**
   * End-to-end budget for one EDA-host request, in milliseconds.
   *
   * This is the SINGLE request budget for the whole chain — the plugin does
   * not define separate per-layer timeouts. It is enforced here (outermost)
   * and mirrored by the KiCad UI-dispatch bound, so no agent request can wait
   * indefinitely. See docs/tasks/expose-capability.md §6.
   */
  requestTimeoutMs?: number
}

export const DEFAULT_NETLIST_PATH_PREFIX = '/api/v1/netlist'

export const DEFAULT_HOST_PATH_PREFIX = '/api/v1/host'

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

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
  const hostPrefix =
    config?.hostPathPrefix ?? env.HQ_EDGE_HOST_PATH ?? DEFAULT_HOST_PATH_PREFIX
  const timeoutRaw = config?.requestTimeoutMs ?? env.HQ_EDGE_REQUEST_TIMEOUT_MS
  const timeout = Number.parseInt(String(timeoutRaw ?? ''), 10)
  return {
    hqEdgeBaseUrl: baseUrl,
    netlistPathPrefix: pathPrefix,
    hostPathPrefix: hostPrefix,
    requestTimeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_REQUEST_TIMEOUT_MS,
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

/** Host discovery route suffix. */
export type HostRoute = 'info' | 'capabilities'

const HOST_ROUTE: Record<HostRoute, string> = {
  info: '/info',
  capabilities: '/capabilities',
}

/** Build the absolute URL for one host discovery route. */
export function hostUrlOf(config: EdaHostConfig, route: HostRoute): string {
  const base = (config.hqEdgeBaseUrl ?? '').replace(/\/+$/, '')
  const prefix = (config.hostPathPrefix ?? DEFAULT_HOST_PATH_PREFIX).replace(/^\/+|\/+$/g, '')
  return `${base}/${prefix}${HOST_ROUTE[route]}`
}
