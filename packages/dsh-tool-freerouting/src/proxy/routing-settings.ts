import { z } from 'zod';
import { UpstreamServiceError } from './upstream-errors.js';

/** Pinned FreeRouting 2.5 API settings. Preserve DSN-derived fields at this boundary. */
const routerSettingsSchema = z.looseObject({
  autorouter: z.looseObject({
    algorithm: z.string().min(1),
    max_passes: z.number().int().nonnegative(),
  }),
  optimizer: z.looseObject({ enabled: z.boolean() }),
});

export function configureRoutingSettings(value: unknown, timeoutMs: number, fast: boolean) {
  const parsed = routerSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new UpstreamServiceError('FREEROUTING_PROTOCOL_FAILED', 502, '无法确认布线引擎的参数，本次没有开始布线');
  }
  const seconds = Math.max(1, Math.floor(timeoutMs / 1000));
  const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return {
    ...parsed.data,
    // KiCad DSN exports may contain zero passes. A requested routing task
    // must attempt at least one pass, while retaining larger configured limits.
    autorouter: { ...parsed.data.autorouter, max_passes: Math.max(1, parsed.data.autorouter.max_passes) },
    job_timeout: parts.map((part) => String(part).padStart(2, '0')).join(':'),
    optimizer: { ...parsed.data.optimizer, enabled: fast ? false : parsed.data.optimizer.enabled },
  };
}
