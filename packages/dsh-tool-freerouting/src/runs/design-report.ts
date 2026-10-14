import { ruleProblemText } from '../presentation/routing-copy.js';
import { z } from 'zod';

export const designReportSchema = z
  .object({
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
    violations: z
      .array(
        z.object({
          type: z.string(),
          severity: z.string(),
          description: z.string(),
          items: z.array(
            z.object({
              uuid: z.string(),
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
  .refine(
    (report) =>
      report.count >= report.violations.length && (report.truncated || report.count === report.violations.length),
    'Incomplete design report',
  );

export type DesignReport = z.infer<typeof designReportSchema>;

export function designWarning(report: DesignReport): string | undefined {
  if (!report.count) {
    return undefined;
  }
  const copper = report.violations.some((issue) => issue.type === 'clearance' || issue.type === 'shorting_items');
  return copper
    ? `布线已添加，但仍有未解决的铜相碰或间距问题（共 ${report.count} 项布线规则问题），请检查下方具体冲突`
    : `布线已添加，但仍有 ${report.count} 项未解决的布线规则问题，请检查下方具体冲突`;
}

export function briefConflicts(report?: DesignReport) {
  return report?.violations.slice(0, 5).map((issue) => ({
    problem: ruleProblemText(issue.type),
    locations: issue.items
      .slice(0, 2)
      .map((item) => ({ object: item.label ?? '冲突对象', x_mm: item.x, y_mm: item.y })),
    // Object identities are control data for the repair tool, never user-facing labels.
    object_ids: issue.items.slice(0, 2).map((item) => item.uuid),
  }));
}
