/**
 * Huaqiu EDA schematic & system-design generation DSH tool plugin (node half) —
 * `@huaqiu/dsh-tool-schematic-gen`.
 *
 * Exposes two agent-visible tools that drive the online HQ-EDA CopilotKit
 * agents (`schemagen`, `modular_circuit`) over SSE:
 *
 *   generate_schematic_from_description   description → KiCad schematic
 *   generate_system_module_graph          description → module graph → KiCad zip
 *
 * ── Architectural boundary (migration plan §1/§8/§9) ───────────────────────────
 * Self-contained DSH plugin: no `@hqedge/*` dependency, no HTTP proxy, and NO
 * demo credentials. The eda.cn account is the `huaqiuAuth` capability
 * (`getUserInfo()` → `x-user-id` / `x-user-token`); generated artifacts are
 * stored in the user-wide `huaqiuArtifacts` service (in-process). The zip
 * artifact is the single source of truth for system designs — never inlined.
 *
 * @module @huaqiu/dsh-tool-schematic-gen
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HuaqiuAuthService } from '@huaqiu/dsh-auth'
import type { HuaqiuArtifacts } from '@huaqiu/dsh-artifacts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createSchematicGenTools, type SchematicGenDeps } from './tools.js'
import { resolveConfig } from './config.js'
import { HTTP_TIMEOUT_MS } from './sse.js'
import { ProgressStore } from './progress.js'
import { createProgressHandler, PROGRESS_ROUTE_PREFIX } from './routes.js'
import { registerSchematicGenPromptSection } from './prompt.js'
import { getLogger } from '@huaqiu/dsh-plugin-log'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-tool-schematic-gen'

/**
 * Cordis services this half depends on.
 *
 * `webServer` carries the live-progress route that the browser card polls.
 * It is already transitively required, because `@huaqiu/dsh-artifacts`
 * (which we inject as `huaqiuArtifacts) declares it too.
 */
/**
 * `systemPrompt` carries the standing tool-policy section (see `prompt.ts`).
 * It is declared here so DSH holds the plugin until the service exists, but
 * registration is still guarded: a deployment without it must load the tools
 * regardless.
 */
export const inject = ['tools', 'huaqiuAuth', 'huaqiuArtifacts', 'webServer', 'systemPrompt'] as const

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-schematic-gen'
const log = getLogger(COMPONENT)

export interface SchematicGenPluginConfig {
  /** Endpoint overrides, env-backed. */
  copilotkitUrl?: string
  exportZipUrl?: string
}

/**
 * Host plugin body — register the two generation tools.
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters both tools on plugin dispose.
 */
export function apply(ctx: Context, config: SchematicGenPluginConfig = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-tool-schematic-gen requires the DSH `tools` service (ctx.tools.register).')
  }
  if (!ctx.huaqiuAuth || !ctx.huaqiuAuth.auth || typeof ctx.huaqiuAuth.auth.getUserInfo !== 'function') {
    throw new Error(
      '@huaqiu/dsh-tool-schematic-gen requires the `huaqiuAuth` service (provided by @huaqiu/dsh-auth) — ' +
      'the eda.cn account is never baked in.',
    )
  }
  if (!ctx.huaqiuArtifacts || typeof ctx.huaqiuArtifacts.create !== 'function') {
    throw new Error(
      '@huaqiu/dsh-tool-schematic-gen requires the `huaqiuArtifacts` service (provided by @huaqiu/dsh-artifacts).',
    )
  }

  const auth: HuaqiuAuthService = ctx.huaqiuAuth
  const artifacts: HuaqiuArtifacts = ctx.huaqiuArtifacts

  // Fail fast at load time on a misconfigured endpoint override.
  const configOverride: Record<string, string | undefined> = {}
  if (config.copilotkitUrl) configOverride.HQ_EDA_COPILOTKIT_URL = config.copilotkitUrl
  if (config.exportZipUrl) configOverride.HQ_EDA_EXPORT_ZIP_URL = config.exportZipUrl
  const finalConfig = resolveConfig({ ...(typeof process !== 'undefined' ? process.env : undefined), ...configOverride })

  // Live progress: an in-memory store the tool bodies write to and the browser
  // card polls. Best-effort — when the webServer surface is missing the tools
  // still generate, they simply cannot report progress.
  const progress = new ProgressStore()
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: PROGRESS_ROUTE_PREFIX,
      handler: createProgressHandler(progress),
    }))
  } else {
    log.warn('webServer unavailable — live progress reporting is disabled')
  }

  const deps: SchematicGenDeps = {}
  const env = {
    config: finalConfig,
    auth: auth.auth,
    artifacts,
    timeoutMs: HTTP_TIMEOUT_MS,
    progress,
    deps,
  }

  const disposers = createSchematicGenTools(env).map((tool) => ctx.tools.register(tool))

  // Standing tool policy — complementary to the per-turn intent the
  // `@schematic-gen` chip's codec splices into the user message.
  disposers.push(registerSchematicGenPromptSection(
    (ctx as unknown as { systemPrompt?: unknown }).systemPrompt,
  ))

  log.info('registered agent tools', {
    tools: disposers.length,
    copilotkitUrl: finalConfig.copilotkitUrl,
    exportZipUrl: finalConfig.exportZipUrl,
    auth: 'huaqiuAuth',
  })

  return function dispose() {
    for (const disposeTool of disposers) {
      try {
        disposeTool()
      } catch {
        // One failing unregister must not hide the others.
      }
    }
    progress.sweep()
  }
}

/** Exported for tests: the agent ids this plugin drives. */
export { agentIds } from './config.js'
