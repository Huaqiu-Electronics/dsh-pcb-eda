/**
 * `@huaqiu/dsh-eda-host` — node plugin entry.
 *
 * Provides the `edaHost` service (semantic EDA-host capability) and registers
 * three agent tools:
 *
 *   get_project_netlist      complete project netlist
 *   get_selection_netlist    currently selected components netlist
 *   get_active_page_netlist  active schematic page netlist
 *
 * ── Architectural boundary (task: add-dsh-eda-host) ─────────────────────────
 * The ONLY production request path is DSH → dsh-eda-host → hq-edge → EDA host.
 * This plugin owns DSH integration only: it translates tool calls into hq-edge
 * requests and returns the semantic `SchematicNetlist`. It contains no
 * KiCad-specific logic, no schematic parsing, and no host IPC. The plugin is
 * self-contained — no `@hqedge/*` dependency; the base URL is delivered by the
 * hq-edge supervisor as overlay config (`hqEdgeBaseUrl`), with
 * `HQ_EDGE_BASE_URL` as env fallback (same convention as `@huaqiu/dsh-auth`).
 *
 * @module @huaqiu/dsh-eda-host
 */
import type { Context } from '@deepseek-ai/cordis'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import { createEdaHostClient, type EdaHostClient } from './client.js'
import { hasHost, resolveEdaHostConfig, type EdaHostConfig } from './config.js'
import { createNetListTools } from './tools.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-eda-host'

/** Cordis services this half depends on. */
export const inject = ['tools'] as const

export type { EdaHostConfig } from './config.js'
export type { EdaHostClient } from './client.js'
export type {
  ElectricalNet,
  ElectricalType,
  NetlistErrorKind,
  PinDefinition,
  PinReference,
  SchematicComponent,
  SchematicNetlist,
} from './types.js'
export { NetlistError } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    edaHost: EdaHostClient
    /**
     * Provided by the hq-edge `edge-bridge` plugin (the HOST). `baseUrl` is the
     * loopback HQ Edge endpoint, e.g. "http://localhost:18080". We read it
     * lazily so this plugin does not hard-depend on the bridge and still works
     * in standalone DSH installs (where the service is absent).
     */
    hqEdge?: { baseUrl?: string }
  }
}

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-eda-host'
const log = getLogger(COMPONENT)

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

  // Late-bound host endpoint: prefer the edge-bridge service, then the overlay
  // config / env value. Consulted on every request (see client.ts).
  const getHqEdgeBaseUrl = (): string | undefined => {
    const hq = ctx.hqEdge
    return hq?.baseUrl && hq.baseUrl.trim().length > 0 ? hq.baseUrl : undefined
  }

  log.info('applying dsh-eda-host node half', {
    hasConfigHost: hasHost(resolved),
    hqEdgeBaseUrlFromConfig: resolved.hqEdgeBaseUrl ?? null,
    netlistPathPrefix: resolved.netlistPathPrefix,
  })

  const client = createEdaHostClient(resolved, { baseUrlResolver: getHqEdgeBaseUrl })

  ctx.effect(() => ctx.provide('edaHost', client))

  const tools = createNetListTools({ client })
  const disposers: Array<() => void> = []
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool))
  }

  log.info('dsh-eda-host node half ready', { tools: 3, configHostMode: hasHost(resolved) })

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
