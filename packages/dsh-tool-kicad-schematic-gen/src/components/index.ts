/** KiCad model inspection, datasheets and workspace-scoped symbol import. */
import type { Context } from '@deepseek-ai/cordis'
import { validateConfig, type Config } from './config.ts'
import { createKicadLibraryTools } from './tools.ts'

export { Config } from './config.ts'
export const name = '@local/dsh-tool-kicad-library'
export const inject = ['tools', 'fs', 'sandboxPolicy'] as const

export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  for (const tool of createKicadLibraryTools(ctx, config)) {
    ctx.effect(() => ctx.tools.register(tool))
  }
}
