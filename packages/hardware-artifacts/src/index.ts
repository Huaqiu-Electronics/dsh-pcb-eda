/**
 * `@huaqiu/hardware-artifacts` — Hardware Engineering host capability.
 *
 * Provides `hardwareArtifacts`, mounts same-origin read/launch routes, and
 * contributes a compact validated installation block to the agent prompt.
 * Nothing here injects hqEdge, opens a shell, or mutates global process env.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { createHardwareHandler, HARDWARE_ROUTE_PREFIX } from './routes.js'
import { HardwareArtifactService } from './service.js'

export type {
  ArtifactKind,
  DiscoveryResult,
  HardwareArtifact,
  HardwareProject,
  HardwareArtifactsOptions,
  Installations,
  InstallationInfo,
  NativeApplication,
  OpenArtifactRequest,
  OpenArtifactResult,
} from './service.js'
export { HardwareArtifactService } from './service.js'
export { createHardwareHandler, HARDWARE_ROUTE_PREFIX } from './routes.js'

export const name = '@huaqiu/hardware-artifacts'
export const inject = ['webServer', 'systemPrompt'] as const

/** User-scoped installation settings persisted by DSH's host-backed config. */
export const Config = Schema.object({
  kicadRoot: Schema.string().default(''),
  solidcraftRoot: Schema.string().default(''),
})

export interface HardwareArtifactsPluginConfig {
  readonly kicadRoot?: string
  readonly solidcraftRoot?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hardwareArtifacts: HardwareArtifactService
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
  const service = new HardwareArtifactService({
    ...(config.kicadRoot ? { kicadRoot: config.kicadRoot } : {}),
    ...(config.solidcraftRoot ? { solidcraftRoot: config.solidcraftRoot } : {}),
  })
  ctx.effect(() => ctx.provide('hardwareArtifacts', service))

  if (ctx.webServer !== undefined) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: HARDWARE_ROUTE_PREFIX,
      handler: createHardwareHandler(service),
    }), 'hardware-artifacts: local read/launch routes')
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
