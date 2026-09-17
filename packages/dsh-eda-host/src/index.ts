/**
 * `@huaqiu/dsh-eda-host` — node plugin entry.
 *
 * Provides the `edaHost` service (semantic EDA-host capability) and registers
 * six agent tools:
 *
 *   get_project_netlist      complete project netlist
 *   get_selection_netlist    currently selected components netlist
 *   get_active_page_netlist  active schematic page netlist
 *   get_pcb_selection        semantic PCB selection of the current PCB editor
 *   get_eda_host_info        which EDA host, version, installation
 *   get_eda_host_capabilities  what the current host can actually do
 *
 * ── Architectural boundary (task: add-dsh-eda-host) ─────────────────────────
 * The ONLY production request path is DSH → dsh-eda-host → hq-edge → EDA host.
 * This plugin owns DSH integration only: it translates tool calls into hq-edge
 * requests and returns the semantic `SchematicNetlist`. It contains no
 * KiCad-specific logic, no schematic parsing, and no host IPC. The plugin is
 * self-contained — no `@hqedge/*` dependency. The base URL is resolved at
 * request time in this order: (1) the `ctx.hqEdge.baseUrl` service provided by
 * the edge-bridge HOST (the loopback HQ Edge endpoint), then (2) the
 * supervisor's overlay config (`hqEdgeBaseUrl`), then (3) `HQ_EDGE_BASE_URL`
 * env fallback (same convention as `@huaqiu/dsh-auth`). `hqEdge` is a REQUIRED
 * inject — the plugin cannot reach hq-edge without the bridge.
 *
 * @module @huaqiu/dsh-eda-host
 */
import type { Context } from '@deepseek-ai/cordis'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import { createEdaHostClient, type EdaHostClient } from './client.js'
import { hasHost, resolveEdaHostConfig, type EdaHostConfig } from './config.js'
import { createEdaHostTools, createNetListTools } from './tools.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-eda-host'

/**
 * Cordis services this half depends on.
 *
 * `hqEdge` is REQUIRED: the edge-bridge (the HOST) provides the node-side
 * `hqEdge` service whose `baseUrl` is the loopback HQ Edge endpoint
 * (`createNodeHqEdge(upstreamRoot, …)` → `get baseUrl()`). Without it the
 * plugin cannot reach hq-edge at all — by design it cannot work standalone
 * (the user-confirmed contract is "eda-host cannot work without hqEdge").
 * Declaring it here is what lets `apply()` read `ctx.hqEdge` without Cordis
 * throwing `cannot get property "hqEdge" without inject` (its context proxy
 * walks the fiber tree and throws at the root fiber when the service was
 * never injected into this plugin's fiber).
 *
 * `tools` is the DSH node runtime tool registry used to register the netlist
 * tools.
 */
export const inject = ['hqEdge', 'tools'] as const

export type { EdaHostConfig } from './config.js'
export type { EdaHostClient, EdaHostRequestOptions } from './client.js'
export type {
  EdaHostCapability,
  EdaHostExecutable,
  EdaHostIdentity,
  EdaHostInfo,
  EdaHostInstallation,
  EdaHostType,
  ElectricalNet,
  ElectricalType,
  NetlistErrorKind,
  PcbArc,
  PcbDimension,
  PcbFootprint,
  PcbGroup,
  PcbNetRef,
  PcbPad,
  PcbPoint,
  PcbSegment,
  PcbSelection,
  PcbShape,
  PcbText,
  PcbTrack,
  PcbVia,
  PcbZone,
  PinDefinition,
  PinReference,
  SchematicComponent,
  SchematicNetlist,
} from './types.js'
export { NetlistError } from './types.js'
export { parseNetlistBody } from './client.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    edaHost: EdaHostClient
    /**
     * Provided by the hq-edge `edge-bridge` plugin (the HOST). `baseUrl` is the
     * loopback HQ Edge endpoint, e.g. "http://localhost:18080". We read it
     * lazily so this plugin does not hard-depend on the bridge and still works
     * in standalone DSH installs (where the service is absent).
     */
    /**
     * Provided by the hq-edge `edge-bridge` plugin (the HOST). `baseUrl` is the
     * loopback HQ Edge endpoint, e.g. "http://localhost:18080". This is a
     * REQUIRED inject (see `export const inject` above): `apply()` reads
     * `ctx.hqEdge` to resolve the endpoint, so the service must be present or
     * Cordis throws `cannot get property "hqEdge" without inject`. When present
     * but its `baseUrl` is empty, the netlist tools degrade to a clear
     * FAILED_PRECONDITION rather than throwing at load time.
     */
    hqEdge: { baseUrl?: string }
  }
}

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-eda-host'
const log = getLogger(COMPONENT)

// Emitted on import, before any Cordis dependency is resolved. Pairs with the
// "node half ready" marker in apply(): if this line is logged but that one is
// not, the edge-bridge never provided `hqEdge` and this plugin is still
// pending — which is otherwise completely silent.
log.info('dsh-eda-host: module loaded (waiting for the hqEdge + tools services)')

/**
 * Host plugin body — provide `edaHost` and register the three netlist tools.
 *
 * The HQ Edge endpoint is resolved **lazily at request time** (see
 * `getHqEdgeBaseUrl`): the edge-bridge plugin provides `ctx.hqEdge.baseUrl`,
 * which wins over the static `config.hqEdgeBaseUrl` / `HQ_EDGE_BASE_URL` env
 * fallback. This matches how `@huaqiu/dsh-artifacts` and `@huaqiu/dsh-tool-
 * symbol-footprint` reach hq-edge, and means the URL is correct even when this
 * plugin is applied before the bridge. When no host URL is available at call
 * time, the tools degrade to a clear FAILED_PRECONDITION instead of throwing at
 * load time — so the plugin still installs in standalone DSH where hq-edge is
 * absent.
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters the tools on plugin dispose.
 */
export function apply(ctx: Context, config: Partial<EdaHostConfig> = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(
      '@huaqiu/dsh-eda-host requires the DSH `tools` service (ctx.tools.register).',
    )
  }

  const resolved = resolveEdaHostConfig(config)

  // ── Explicit bridge dependency ───────────────────────────────────────────
  // `hqEdge` is a REQUIRED inject, so Cordis only calls `apply()` once the
  // edge-bridge has provided it. That means a missing bridge would otherwise
  // leave this plugin pending forever with the tools never registered and
  // nothing logged. Two things make that diagnosable:
  //
  //   1. `apply()` asserts the bridge actually gave us a usable endpoint and
  //      THROWS when it did not — a loud startup failure beats five tools that
  //      fail one by one at call time.
  //   2. The module-level marker below is emitted on import. If
  //      "dsh-eda-host: module loaded" appears in the log but
  //      "dsh-eda-host: node half ready" never does, the bridge never provided
  //      `hqEdge` and this plugin is still pending.
  //
  // hq-edge is NOT optional here — this plugin must never become a standalone
  // DSH plugin (docs/tasks/expose-capability.md §3, §7).
  const hq = ctx.hqEdge
  if (!hq || typeof hq.baseUrl !== 'string' || hq.baseUrl.trim().length === 0) {
    throw new Error(
      '@huaqiu/dsh-eda-host requires a usable hq-edge context: the edge-bridge ' +
        'plugin did not provide ctx.hqEdge.baseUrl. EDA host tools cannot work ' +
        'without hq-edge — check that the bridge started and that the HQ Edge ' +
        'port is valid.',
    )
  }

  // Late-bound host endpoint: prefer the edge-bridge service, then the overlay
  // config / env value. Consulted on every request (see client.ts).
  const getHqEdgeBaseUrl = (): string | undefined => {
    const current = ctx.hqEdge
    return current?.baseUrl && current.baseUrl.trim().length > 0 ? current.baseUrl : undefined
  }

  log.info('applying dsh-eda-host node half', {
    hasConfigHost: hasHost(resolved),
    hqEdgeBaseUrlFromConfig: resolved.hqEdgeBaseUrl ?? null,
    netlistPathPrefix: resolved.netlistPathPrefix,
    hostPathPrefix: resolved.hostPathPrefix,
    requestTimeoutMs: resolved.requestTimeoutMs,
  })

  const client = createEdaHostClient(resolved, { baseUrlResolver: getHqEdgeBaseUrl })

  ctx.effect(() => ctx.provide('edaHost', client))

  const tools = [...createNetListTools({ client }), ...createEdaHostTools({ client })]
  const disposers: Array<() => void> = []
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool))
  }

  log.info('dsh-eda-host node half ready', {
    tools: tools.length,
    configHostMode: hasHost(resolved),
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // best-effort teardown
      }
    }
  }
}
