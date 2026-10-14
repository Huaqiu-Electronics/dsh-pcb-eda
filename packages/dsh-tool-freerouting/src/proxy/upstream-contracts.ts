import { z } from 'zod';

import { UpstreamServiceError } from './upstream-errors.js';

/** Protocol of the pinned bundled engine. Missing/unknown states must fail closed. */
export const jobStateSchema = z.enum([
  'INVALID',
  'QUEUED',
  'READY_TO_START',
  'RUNNING',
  'STOPPING',
  'PAUSED',
  'COMPLETED',
  'TIMED_OUT',
  'CANCELLED',
  'TERMINATED',
]);
export type FreeroutingJobState = z.infer<typeof jobStateSchema>;

export const jobStatusSchema = z.looseObject({
  router_settings: z.record(z.string(), z.unknown()).optional(),
  state: jobStateSchema,
  status: z.never().optional(),
  progress_percentage: z.number().optional(),
  // Some FreeRouting builds also report a nested `statistics` blob while the job is
  // still RUNNING; accept it so live progress can surface violations/connections.
  statistics: z.record(z.string(), z.unknown()).optional(),
});

export const jobOutputSchema = z.object({
  data: z.string(),
  filename: z.string().optional(),
  // FreeRouting `statistics` is a nested, build-dependent blob (values may be null,
  // numbers, strings, or objects), so accept any JSON value instead of failing the run.
  statistics: z.record(z.string(), z.unknown()).optional(),
});

export const identifierSchema = z.object({
  id: z.string().min(1),
});

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobOutput = z.infer<typeof jobOutputSchema>;

export function parseJobStatus(value: unknown): JobStatus {
  const result = jobStatusSchema.safeParse(value);
  if (!result.success) {
    throw new UpstreamServiceError(
      'FREEROUTING_PROTOCOL_FAILED',
      502,
      '布线引擎返回了无法识别的任务状态，请保留诊断信息',
    );
  }
  return result.data;
}

export function parseJobOutput(value: unknown): JobOutput {
  const result = jobOutputSchema.safeParse(value);
  if (!result.success) {
    throw new UpstreamServiceError(
      'FREEROUTING_PROTOCOL_FAILED',
      502,
      '布线引擎返回了无法识别的布线结果，请保留诊断信息',
    );
  }
  return result.data;
}

export function parseIdentifier(value: unknown): z.infer<typeof identifierSchema> {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new UpstreamServiceError(
      'FREEROUTING_PROTOCOL_FAILED',
      502,
      '布线引擎返回了无法识别的任务或连接编号，请保留诊断信息',
    );
  }
  return parsed.data;
}
