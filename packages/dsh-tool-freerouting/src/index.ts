/** KiCad 10 IPC through an ephemeral Python helper; FreeRouting through local HTTP. */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import { apply as applyRuntime } from './runtime.js';

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-tool-freerouting';

/** Required DSH integration services. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'jobs'] as const;

export type { ResolvedConfig } from './config.js';
export { Config as ConfigSchema } from './config.js';
export { Config } from './config.js';

/**
 * Host plugin body — register routing tools, web server, and system prompt.
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters the tools on plugin dispose.
 */
export async function apply(ctx: Context, config: Partial<Config> = {}): Promise<() => void> {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-tool-freerouting requires the DSH `tools` service (ctx.tools.register).');
  }

  const dispose = await applyRuntime(ctx, config);
  return dispose;
}
