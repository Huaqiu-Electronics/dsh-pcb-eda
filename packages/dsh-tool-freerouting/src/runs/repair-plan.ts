import type { DesignReport } from './design-report.js';
export class RepairNeeded extends Error {
  constructor(readonly report: DesignReport) {
    super('需要自动处理布线冲突');
  }
}
export interface RepairPlan {
  avoidObjectIds?: string[];
}
