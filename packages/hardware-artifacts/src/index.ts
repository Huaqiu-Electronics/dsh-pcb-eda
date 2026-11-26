/**
 * `@huaqiu/hardware-artifacts` — Hardware Engineering host capability.
 *
 * Provides `hardwareArtifacts`, mounts same-origin read/export/launch routes, and
 * contributes a compact validated installation block to the agent prompt.
 * Nothing here injects hqEdge, opens a shell, or mutates global process env.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { createHardwareHandler, HARDWARE_ROUTE_PREFIX } from './routes.js'
import { HardwareArtifactService } from './service.js'
import { createHardwareTools } from './tools.js'
import { ToolchainManager, type ToolchainConfigPatch } from './toolchain/index.js'

export type {
  ArtifactKind,
  DiscoveryResult,
  FabricationResult,
  HardwareArtifact,
  HardwareProject,
  HardwareArtifactsOptions,
  Installations,
  InstallationInfo,
  NativeApplication,
  OpenArtifactRequest,
  OpenArtifactResult,
  OrderConfigInfo,
  PlaceOrderRequest,
  PlaceOrderResult,
} from './service.js'
export { HardwareArtifactService } from './service.js'
export {
  DEFAULT_ORDER_BASE_URL, DEFAULT_ORDER_PAGE_BASE, ORDER_PATHS, ORDER_SOURCE_TID, orderBomCsv,
  orderBomRows, orderIdsFromUrl, parsePositions, pcbOrderForm, pcbOrderUrl, positionsCsv,
  readBoardFacts, smtOrderForm, smtOrderUrl, smtOrderUrlFromBackend, snapHoleTier, snapThickness,
  snapTraceTier,
} from './order.js'
export type { BoardFacts, PositionRow } from './order.js'
export {
  expectedCopperLayers, validateFabricationPackage, validationSummary,
} from './package.js'
export type { PackageIssue, PackageIssueCode, PackageValidation } from './package.js'
export { createHardwareTools, hardwareToolNames } from './tools.js'
export type { HardwareToolEnv } from './tools.js'
export { createHardwareHandler, HARDWARE_ROUTE_PREFIX, TOOLCHAIN_ROUTE_PREFIX } from './routes.js'
export type { HardwareHandlerOptions, WorkspaceResolver } from './routes.js'
export { ToolchainManager } from './toolchain/index.js'
export type {
  InstallErrorCode, InstallJobSnapshot, InstallPhase, ManifestEntry, ManifestFailure,
  ToolDiscovery, ToolStatus, ToolchainConfigPatch, ToolchainManagerOptions, ToolchainSettings,
  ToolchainStatus, ToolchainId, ToolchainSource, ValidationOutcome,
} from './toolchain/index.js'

export const name = '@huaqiu/hardware-artifacts'
export const inject = ['webServer', 'systemPrompt'] as const

/**
 * User-scoped installation settings persisted by DSH's host-backed config.
 *
 * Every field is `.volatile()`: DSH's settings service only projects volatile
 * fields into editable forms, and only volatile writes are persisted to the
 * active profile patch. A non-volatile field here would make the Hardware
 * Engineering settings page read-only by construction.
 */
export const Config = Schema.object({
  kicadRoot: Schema.string().default('').volatile(),
  solidcraftRoot: Schema.string().default('').volatile(),
  /** Last validated KiCad version; display metadata, never the source of truth. */
  kicadVersion: Schema.string().default('').volatile(),
  /** How the KiCad path was obtained (`manual` | `browse` | `download` | `detected`). */
  kicadSource: Schema.string().default('').volatile(),
  /** Epoch milliseconds of the last successful KiCad validation. */
  kicadValidatedAt: Schema.number().default(0).volatile(),
  solidcraftVersion: Schema.string().default('').volatile(),
  solidcraftSource: Schema.string().default('').volatile(),
  solidcraftValidatedAt: Schema.number().default(0).volatile(),
  /**
   * First-run setup progress: empty until the operator answers, then `deferred`
   * (skipped: never re-prompt, keep the reminder) or `complete`.
   */
  toolchainSetup: Schema.string().default('').volatile(),
  /** Set by the first-run wizard once setup was completed or skipped. */
  onboardingComplete: Schema.boolean().default(false).volatile(),
  /**
   * Place-order origin. Empty uses `HUAQIU_ORDER_BASE_URL`, then the Huaqiu
   * host. It is only the transport target; it does not imply the endpoint
   * supports the order contract.
   */
  orderBaseUrl: Schema.string().default('').volatile(),
  /**
   * Huaqiu access token for the assembly endpoint. Volatile so it stays in the
   * profile patch and never reaches the client bundle.
   */
  accessToken: Schema.string().default('').volatile(),
})

/**
 * A schema field value: a plain value, or the stable reference a volatile
 * field resolves to (`{ get(): T }`, see `@deepseek-ai/cosmokit`).
 */
export type ConfigValue<T> = T | { get(): T }

export interface HardwareArtifactsPluginConfig {
  readonly kicadRoot?: ConfigValue<string>
  readonly solidcraftRoot?: ConfigValue<string>
  readonly kicadVersion?: ConfigValue<string>
  readonly kicadSource?: ConfigValue<string>
  readonly kicadValidatedAt?: ConfigValue<number>
  readonly solidcraftVersion?: ConfigValue<string>
  readonly solidcraftSource?: ConfigValue<string>
  readonly solidcraftValidatedAt?: ConfigValue<number>
  readonly toolchainSetup?: ConfigValue<string>
  readonly onboardingComplete?: ConfigValue<boolean>
  readonly orderBaseUrl?: ConfigValue<string>
  readonly accessToken?: ConfigValue<string>
}

/** Read one config field, resolving a volatile reference at call time. */
function readConfig<T>(value: ConfigValue<T> | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hardwareArtifacts: HardwareArtifactService
    /** Toolchain configuration, discovery and installation capability. */
    hardwareToolchains: ToolchainManager
  }
}

interface SystemPromptFace {
  context(entry: {
    name: string
    order: number
    text: string | (() => string)
    interpolate?: boolean
    required?: boolean
  }): () => void
}

export function apply(ctx: Context, config: HardwareArtifactsPluginConfig = {}): void {
  /**
   * Read one optional host service without declaring it in `inject`.
   *
   * `hardwareArtifacts` must stay usable — and unit-testable — in a profile
   * where auth, sessions or a sandbox policy are absent; each caller degrades
   * on its own instead of the whole plugin refusing to mount.
   */
  const hostService = <T>(name: string): T | undefined => {
    const get = (ctx as Context & { get?: (name: string) => unknown }).get
    return typeof get === 'function' ? get.call(ctx, name) as T | undefined : undefined
  }

  /**
   * The signed-in Huaqiu session, when the auth plugin is mounted.
   *
   * Read lazily rather than declared in `inject`: only the order path needs the
   * token.
   */
  const huaqiuAuth = (): { auth?: { getAccessToken?: () => Promise<string | null> } } | undefined =>
    hostService<{ auth?: { getAccessToken?: () => Promise<string | null> } }>('huaqiuAuth')

  /**
   * Workspace root of one DSH session, from the host's own session header.
   *
   * This is what makes authorization survive a workspace switch: the base for
   * a read comes from the session the request names, so another session's
   * discovery cannot revoke it. Falling back to the sandbox policy root keeps
   * a session without a header usable instead of unauthorized.
   */
  const sessionWorkspace = async (sessionId: string): Promise<string | undefined> => {
    const live = hostService<{ get?: (id: string) => { header?: { cwd?: string } } | undefined }>('sessions')
      ?.get?.(sessionId)?.header?.cwd
    if (live !== undefined) return live
    try {
      const stored = await hostService<{
        stat?: (id: string) => Promise<{ header?: { cwd?: string } } | undefined>
      }>('sessionPersistence')?.stat?.(sessionId)
      if (stored?.header?.cwd !== undefined) return stored.header.cwd
    } catch {
      // A session the persistence layer cannot answer for is not an error here.
    }
    return hostService<{ workspaceRoot?: string }>('sandboxPolicy')?.workspaceRoot
  }

  const service = new HardwareArtifactService({
    // The accessor keeps the service on the live profile config reference:
    // a settings write is visible to the next validation without a restart.
    settings: () => ({
      kicadRoot: readConfig(config.kicadRoot),
      solidcraftRoot: readConfig(config.solidcraftRoot),
      orderBaseUrl: readConfig(config.orderBaseUrl),
      accessToken: readConfig(config.accessToken),
    }),
    // hqpcb is a Huaqiu business: the login that authenticates the eda.cn API
    // is the token the order page expects. An explicit config token still wins.
    authToken: async () => {
      try {
        return (await huaqiuAuth()?.auth?.getAccessToken?.()) ?? null
      } catch {
        return null
      }
    },
  })
  ctx.effect(() => ctx.provide('hardwareArtifacts', service))

  /**
   * Toolchain capability (status/validate/discover/download).
   *
   * It reads the same live config the service reads and writes back through the
   * Host's own settings service, so there is exactly one configuration authority
   * (§10.5). The write is best-effort: a profile that mounted this row under a
   * different id still lets the client persist through its config form.
   */
  const SETTINGS_NS = 'hardware-artifacts'
  const persistToolchain = async (patch: ToolchainConfigPatch): Promise<boolean> => {
    const settings = hostService<{ update?: (ns: string, patch: object, expected?: number) => Promise<void> }>('settings')
    if (settings?.update === undefined) return false
    try {
      await settings.update(SETTINGS_NS, patch)
      return true
    } catch {
      return false
    }
  }

  /** The Host's own native directory chooser, when this host has one. */
  const pickFolder = async (title: string): Promise<string | null> => {
    void title
    const capability = hostService<{
      capability?: () => { kind?: string; pick?: (signal: AbortSignal) => Promise<string | null> }
    }>('directoryPicker')?.capability?.()
    if (capability?.kind !== 'native' || capability.pick === undefined) return null
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, 15 * 60_000)
    timer.unref?.()
    try {
      return await capability.pick(abort.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  const toolchains = new ToolchainManager({
    settings: () => ({
      kicadRoot: readConfig(config.kicadRoot),
      solidcraftRoot: readConfig(config.solidcraftRoot),
      kicadVersion: readConfig(config.kicadVersion),
      kicadSource: readConfig(config.kicadSource),
      kicadValidatedAt: readConfig(config.kicadValidatedAt),
      solidcraftVersion: readConfig(config.solidcraftVersion),
      solidcraftSource: readConfig(config.solidcraftSource),
      solidcraftValidatedAt: readConfig(config.solidcraftValidatedAt),
    }),
    persist: persistToolchain,
    pickFolder,
  })
  ctx.effect(() => ctx.provide('hardwareToolchains', toolchains))
  // The manifest is resolved once at boot, off the first UI request (§4.2).
  ctx.effect(() => {
    void toolchains.loadManifest()?.catch(() => undefined)
    return (): void => {}
  }, 'hardware-artifacts: toolchain manifest')

  if (ctx.webServer !== undefined) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: HARDWARE_ROUTE_PREFIX,
      handler: createHardwareHandler(service, { resolveWorkspace: sessionWorkspace, toolchain: toolchains }),
    }), 'hardware-artifacts: local read/launch routes')
  }

  /**
   * Agent tools.
   *
   * Acquired without `inject` for the same reason as the other optional
   * services: the panel and its routes must keep working in a host without a
   * tool registry, and a missing registry costs the agent surface, not the
   * plugin. The tools take a path and run `kicad-cli` themselves, so this is
   * the fabrication path that needs neither HQ Edge nor a running PCB editor.
   */
  const tools = hostService<{ register(tool: unknown): (() => void) | void }>('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    for (const tool of createHardwareTools({
      service,
      // A session-less call has no workspace to authorize against; the tool
      // falls back to the process directory rather than inventing one here.
      workspaceOf: sessionId => (sessionId === undefined ? undefined : sessionWorkspace(sessionId)),
    })) {
      const label = (tool as { readonly name?: string }).name ?? 'tool'
      ctx.effect(() => {
        const dispose = tools.register(tool)
        return typeof dispose === 'function' ? dispose : (): void => {}
      }, `hardware-artifacts: ${label}`)
    }
  }

  const prompt = (ctx as Context & { systemPrompt?: SystemPromptFace }).systemPrompt
  if (prompt !== undefined && typeof prompt.context === 'function') {
    ctx.effect(() => prompt.context({
      name: 'hardware-environment',
      order: 42,
      interpolate: false,
      text: () => service.environmentText(),
    }), 'hardware-artifacts: compact agent environment')
  }
}
