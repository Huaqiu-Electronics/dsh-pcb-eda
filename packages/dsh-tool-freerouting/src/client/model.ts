import { z } from 'zod';
import { previewMetaSchema } from '../contracts/preview.js';

export const capabilitySchema = z.object({
  card: z.literal('pcb-freerouting-run'),
  routePrefix: z
    .string()
    .regex(/^\/[\w/-]*[\w-]$/)
    .refine((value) => !value.includes('//')),
  runId: z.string().uuid(),
  token: z.string().regex(/^[\w-]{43}$/),
});

export const statusSchema = z.object({
  preview: previewMetaSchema.optional(),
  user_message: z.string().optional(),
  run_id: z.string().uuid(),
  state: z.enum(['queued', 'running', 'repair_pending', 'succeeded', 'partial', 'failed', 'cancelled', 'expired']),
  expires_at: z.string(),
  output_name: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  progress: z.object({ state: z.string(), percentage: z.number().finite().optional() }).optional(),
  log: z.array(z.string()).optional(),
  created_at: z.iso.datetime().optional(),
  process: z
    .object({
      round: z.union([z.literal(1), z.literal(2)]),
      events: z
        .array(z.object({ at: z.iso.datetime(), text: z.string().max(500), kind: z.enum(['step', 'progress']) }))
        .max(64),
      stage_started_at: z.iso.datetime(),
      updated_at: z.iso.datetime(),
      engine_updated_at: z.iso.datetime().optional(),
      remaining_connections: z.number().int().nonnegative().optional(),
      preview: z.object({ tracks: z.number().int().nonnegative(), vias: z.number().int().nonnegative() }).optional(),
    })
    .optional(),
  report_name: z.string().optional(),
  design_report: z
    .object({
      count: z.number().int().nonnegative(),
      truncated: z.boolean(),
      violations: z
        .array(
          z.object({
            description: z.string(),
            type: z.string(),
            items: z.array(
              z.object({
                description: z.string(),
                label: z.string().optional(),
                x: z.number().finite(),
                y: z.number().finite(),
              }),
            ),
          }),
        )
        .max(100),
    })
    .optional(),
  summary: z
    .object({
      imported: z.boolean(),
      tracks: z.number().int().nonnegative(),
      vias: z.number().int().nonnegative(),
      warning: z.string().optional(),
      zone_fill: z.string().optional(),
    })
    .optional(),
});

export type Capability = z.infer<typeof capabilitySchema>;
export type RunStatus = z.infer<typeof statusSchema>;

export const stateLabels: Record<RunStatus['state'], string> = {
  queued: '正在准备',
  running: '布线进行中',
  repair_pending: '助手正在处理布线冲突',
  succeeded: '布线结果已添加到板子',
  partial: '布线结果已添加，仍有问题需要检查',
  failed: '自动布线未完成',
  cancelled: '任务已取消',
  expired: '结果已过期',
};

export function active(status: RunStatus): boolean {
  return status.state === 'queued' || status.state === 'running' || status.state === 'repair_pending';
}
