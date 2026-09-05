/**
 * Huaqiu EDA symbol & footprint generation DSH tool plugin (node half) —
 * `@huaqiu/dsh-tool-symbol-footprint`.
 *
 * Exposes three agent-visible tools that drive the online 华秋/eda.cn
 * componentV2 chat backend over WebSocket:
 *
 *   generate_symbol_from_image          image → KiCad schematic symbol
 *   generate_footprint_from_image       image → dimensions → HUMAN → footprint
 *   generate_footprint_from_dimensions  confirmed dimensions → footprint
 *
 * ── Architectural boundary (migration plan §1/§8) ─────────────────────────────
 * Self-contained DSH plugin: no `@hqedge/*` dependency, no HTTP proxy. The
 * token comes from the `huaqiuAuth` service (capability: `getAccessToken()`);
 * generated artifacts are stored in the user-wide `huaqiuArtifacts` service
 * (in-process, not a loopback). The WebSocket transport is Node 22's global
 * `WebSocket`; the endpoint is a whitelist-checked constant (env-overridable).
 *
 * ── Human in the loop ────────────────────────────────────────────────────────
 * A footprint is generated ONLY from dimensions a human has seen. The dimension
 * confirmation UX is owned by the web client card (`needs_confirmation` result);
 * the direct-footprint accept/decline gate uses the `userQuestions` seam
 * opportunistically (`ctx.get`, not `inject`, so the tools still load when the
 * row is disabled).
 *
 * @module @huaqiu/dsh-tool-symbol-footprint
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { HuaqiuArtifacts } from '@huaqiu/dsh-artifacts'
import type { HuaqiuAuthService } from '@huaqiu/dsh-auth'
import type { ComponentGenBackend } from '@huaqiu/component-gen-server'
import { createComponentGenRoutes } from '@huaqiu/component-gen-server'
import { HistoryStore } from '@huaqiu/component-gen-server'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  createSymbolFootprintTools, runGenerateSymbol, runGenerateFootprintFromImage,
  runGenerateFootprintFromDimensions, type SymbolFootprintEnv,
} from './tools.js'
import type { UserQuestionsLike } from './dimensions.js'
import { resolveHitlLocale } from './hitl-i18n.js'
import { resolveEndpoint, packageTypes } from './protocol.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-tool-symbol-footprint'

/** Cordis services this half depends on. `userQuestions` is deliberately NOT
 *  injected — see the HIL note in the file header. `webServer` hosts the
 *  component-gen API routes (jobs/SSE/history) that the browser workspace
 *  drives. */
export const inject = ['tools', 'huaqiuAuth', 'huaqiuArtifacts', 'webServer'] as const

/** Console tag for filtering in logs. */
const LOG_TAG = '[dsh-symbol-footprint]'

export interface SymbolFootprintConfig {
  /** Endpoint override, env-backed (`HQ_EDA_COMPONENT_WS_URL`); still
   *  whitelist-checked. */
  endpoint?: string
  /**
   * UI language for the human-in-the-loop prompt (the accept/decline question
   * shown through the `userQuestions` seam). The node half has no DOM, so it
   * cannot read `<html lang>` the way the browser card does — this is the
   * deployment-side equivalent. Accepts `zh` / `en` (or a BCP-47 tag such as
   * `zh-CN`); falls back to the package default, which is zh to match the
   * card copy. Also settable via `HQ_EDA_HITL_LANGUAGE`.
   */
  hitlLanguage?: string
}

/**
 * Host plugin body — register the three generation tools.
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters all three tools on plugin dispose.
 */
export function apply(ctx: Context, config: SymbolFootprintConfig = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-tool-symbol-footprint requires the DSH `tools` service (ctx.tools.register).')
  }
  if (!ctx.huaqiuAuth || !ctx.huaqiuAuth.auth || typeof ctx.huaqiuAuth.auth.getAccessToken !== 'function') {
    throw new Error(
      '@huaqiu/dsh-tool-symbol-footprint requires the `huaqiuAuth` service (provided by @huaqiu/dsh-auth).',
    )
  }
  if (!ctx.huaqiuArtifacts || typeof ctx.huaqiuArtifacts.create !== 'function') {
    throw new Error(
      '@huaqiu/dsh-tool-symbol-footprint requires the `huaqiuArtifacts` service (provided by @huaqiu/dsh-artifacts).',
    )
  }

  const auth: HuaqiuAuthService = ctx.huaqiuAuth
  const artifacts: HuaqiuArtifacts = ctx.huaqiuArtifacts

  // Fail fast at load time on a misconfigured endpoint override.
  const endpoint = resolveEndpoint(config.endpoint ? { HQ_EDA_COMPONENT_WS_URL: config.endpoint } : undefined)

  // Config wins over env; both go through `resolveHitlLocale`, which coerces
  // tags (`zh-CN`) to an id and falls back to the package default.
  const hitlLanguage = resolveHitlLocale(
    config.hitlLanguage ??
      (typeof process !== 'undefined' ? process.env['HQ_EDA_HITL_LANGUAGE'] : undefined),
  )

  const env = {
    auth: auth.auth,
    artifacts,
    hitlLanguage,
    deps: { processEnv: typeof process !== 'undefined' ? process.env : undefined },
    getUserQuestions: (): UserQuestionsLike | undefined => {
      try {
        return ctx.get('userQuestions') as UserQuestionsLike | undefined
      } catch {
        return undefined
      }
    },
  }

  const disposers: Array<() => void> = []

  try {
    for (const tool of createSymbolFootprintTools(env)) {
      disposers.push(ctx.tools.register(tool))
    }
  } catch (error) {
    for (const disposeTool of disposers.reverse()) {
      try {
        disposeTool()
      } catch {
        // Registration failure remains the primary error.
      }
    }
    throw error
  }

  // ── Component Gen workspace (standalone symbol/footprint generator) ────────
  // The same generation pipeline, driven by the browser workspace instead of
  // the agent tools. The app env deliberately disables the native HIL popup
  // (`getUserQuestions: undefined`) so the workspace is the single driver
  // (single-HIL). History is user-level JSON under `~/.dsh/component-gen/`.
  const appEnv: SymbolFootprintEnv = {
    ...env,
    getUserQuestions: () => undefined,
  }
  const appBackend = createComponentGenBackend(appEnv)
  const history = new HistoryStore(dshHomePath('component-gen'))
  let webServerDisposer: (() => void) | undefined
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register(createComponentGenRoutes({
      backend: appBackend,
      history,
      hostMode: auth.hostMode,
    })))
  } else {
    // eslint-disable-next-line no-console
    console.warn(LOG_TAG, 'webServer unavailable — component-gen workspace API disabled')
  }

  // eslint-disable-next-line no-console
  console.log(LOG_TAG, 'registered agent tools', {
    tools: disposers.length,
    endpoint,
    packageTypes: packageTypes.length,
  })

  return function dispose() {
    for (const disposeTool of disposers) {
      try {
        disposeTool()
      } catch {
        // One failing unregister must not hide the others.
      }
    }
  }
}

/**
 * Build the component-gen HTTP backend over the plugin's existing generation
 * functions. Shared by the DSH integration (this plugin) and the standalone
 * server (`@huaqiu/component-gen-server/standalone`).
 *
 * @param env - `SymbolFootprintEnv`; set `getUserQuestions: () => undefined`
 *   to make the workspace the single HIL driver (no native accept/decline
 *   popup).
 */
export function createComponentGenBackend(env: SymbolFootprintEnv): ComponentGenBackend {
  return {
    generateSymbol: (args, exec) =>
      runGenerateSymbol(
        { image: args.imageDataUrl, instruction: args.instruction },
        { signal: exec.signal },
        env,
      ),
    extractFootprint: (args, exec) =>
      runGenerateFootprintFromImage(
        { image: args.imageDataUrl, package_type: args.packageType, instruction: args.instruction },
        { signal: exec.signal },
        env,
      ),
    generateFootprint: (args, exec) =>
      runGenerateFootprintFromDimensions(
        { package_type: args.packageType, file_name: args.fileName, dimensions: args.dimensions },
        { signal: exec.signal },
        env,
      ),
  }
}

/** Exported for tests: the supported package list. */
export { packageTypes }
/** Exported for tests: the wire command types this plugin speaks. */
export { commandTypes, agentActions } from './protocol.js'
/** The generation pipeline — reused by `@huaqiu/component-gen-server/standalone`. */
export {
  runGenerateSymbol, runGenerateFootprintFromImage, runGenerateFootprintFromDimensions,
  type SymbolFootprintEnv, type SymbolFootprintDeps,
} from './tools.js'
