import { z } from 'zod';
import { designReportSchema } from '../runs/design-report.js';
export const targetSchema = z.object({
  socket: z.string(),
  boardPath: z.string(),
  version: z.string(),
  instance: z.string(),
});
export const importSchema = z.object({
  outcome: z.enum(['committed', 'unchanged']),
  tracks: z.number().int().nonnegative(),
  vias: z.number().int().nonnegative(),
  designReport: designReportSchema,
  displayWarning: z.string().optional(),
});
export const fillSchema = z.object({ zonesFilled: z.number().int().nonnegative(), skipped: z.boolean() });
export type IpcTarget = z.infer<typeof targetSchema>;
export type ImportResult = z.infer<typeof importSchema>;
