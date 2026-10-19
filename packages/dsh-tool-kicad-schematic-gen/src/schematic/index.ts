/** Register KiCad schematic tools and expose their read helpers. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { registerSchematicTools } from './tools.ts'

export { Config } from './config.ts'
export * from './tools.ts'
export const name = 'kicad-schematic-tools'
export const inject = ['tools', 'fs'] as const

export function apply(ctx: Context, config: Config): void {
  registerSchematicTools(ctx, config)
}
