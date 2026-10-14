import type { RunRecord } from './contracts.js';
import type { RunStore } from './run-store.js';
import type { RouteProgress } from '../proxy/routing-contracts.js';
import { routingStageText, ruleProblemText } from '../presentation/routing-copy.js';
import type { DesignReport } from './design-report.js';
import { normalizeStatistics } from './statistics.js';
import type { Context } from '@deepseek-ai/cordis';

const SNAPSHOT_INTERVAL = 15_000;
const MAX_EVENTS = 64;

/** Observations only: recording a step never starts work or decides the board outcome. */
export class ProcessRecorder {
  private lastSnapshot = 0;
  private lastFingerprint = '';
  private lastPreviewSnapshot = 0;

  constructor(
    private readonly run: RunRecord,
    private readonly runs: RunStore,
    private readonly diagnostic: (message: string) => void,
  ) {
    run.activity ??= { round: 1, events: [], stageStartedAt: Date.now(), updatedAt: Date.now() };
  }

  note(text: string, kind: 'step' | 'progress' = 'step'): void {
    const activity = this.run.activity!;
    const now = Date.now();
    activity.events.push({ at: now, text: text.slice(0, 500), kind });
    if (activity.events.length > MAX_EVENTS) {
      const snapshot = activity.events.findIndex((event) => event.kind === 'progress');
      activity.events.splice(snapshot < 0 ? 0 : snapshot, 1);
    }
    activity.updatedAt = now;
    this.diagnostic(text);
  }

  diagnose(text: string): void {
    this.diagnostic(text);
  }

  stage(text: string, computing = false): void {
    if (this.run.progress?.state === text) {
      return;
    }
    if (!computing) {
      delete this.run.activity!.remainingConnections;
      delete this.run.activity!.engineUpdatedAt;
    }
    this.runs.setProgress(this.run.id, { state: text });
    this.run.activity!.stageStartedAt = Date.now();
    this.note(text);
  }

  round(value: 1 | 2): void {
    const activity = this.run.activity!;
    activity.round = value;
    delete activity.remainingConnections;
    delete activity.engineUpdatedAt;
    delete activity.preview;
  }

  progress(progress: RouteProgress): void {
    const now = Date.now();
    const activity = this.run.activity!;
    activity.engineUpdatedAt = now;
    const remaining = normalizeStatistics(progress.statistics).unroutedConnections;
    if (remaining !== undefined && Number.isInteger(remaining) && remaining >= 0) {
      activity.remainingConnections = remaining;
    } else {
      delete activity.remainingConnections;
    }
    const state = `第 ${activity.round} 轮：${progress.state === 'RUNNING' ? '正在寻找连接路径' : routingStageText(progress.state)}`;
    this.stage(state, true);
    const percentage = progress.percentage;
    const validPercentage =
      percentage !== undefined && Number.isFinite(percentage) && percentage >= 0 && percentage <= 100;
    this.runs.setProgress(this.run.id, { state, ...(validPercentage ? { percentage } : {}) });
    const fingerprint = JSON.stringify([
      state,
      validPercentage ? Math.floor(percentage) : null,
      activity.remainingConnections,
    ]);
    if (fingerprint === this.lastFingerprint || now - this.lastSnapshot < SNAPSHOT_INTERVAL) {
      return;
    }
    this.lastSnapshot = now;
    this.lastFingerprint = fingerprint;
    const details = [
      validPercentage ? `本轮计算进度 ${Math.floor(percentage)}%` : '',
      activity.remainingConnections === undefined ? '' : `引擎报告剩余 ${activity.remainingConnections} 个连接待处理`,
    ].filter(Boolean);
    if (details.length) {
      this.note(`第 ${activity.round} 轮：${details.join('；')}。最终接通情况仍需检查`, 'progress');
    }
  }

  preview(counts?: { tracks: number; vias: number }): void {
    const activity = this.run.activity!;
    if (!counts) {
      if (activity.preview) {
        this.note('已清理本轮过程走线，原有走线和过孔保留；最终结果尚未添加');
      }
      delete activity.preview;
      return;
    }
    const changed = activity.preview?.tracks !== counts.tracks || activity.preview?.vias !== counts.vias;
    const first = !activity.preview;
    activity.preview = { ...counts };
    if (changed) {
      activity.updatedAt = Date.now();
    }
    if (first || (changed && Date.now() - this.lastPreviewSnapshot >= SNAPSHOT_INTERVAL)) {
      this.lastPreviewSnapshot = Date.now();
      this.note(
        `KiCad 已显示过程走线 ${counts.tracks} 段、过孔 ${counts.vias} 个；仍会调整，尚未完成最终检查`,
        'progress',
      );
    }
  }
}

export function checkResultText(report: DesignReport): string {
  if (!report.count) {
    return '本轮新增走线的布线规则检查未发现问题；这不代表所有网络已接通';
  }
  const counts = new Map<string, number>();
  for (const issue of report.violations) {
    const label = ruleProblemText(issue.type);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const details = [...counts]
    .slice(0, 5)
    .map(([label, count]) => `${label} ${count} 项`)
    .join('；');
  return `本轮新增走线检查发现 ${report.count} 项规则问题：${details || '请查看具体冲突'}${report.truncated ? '（这里只统计已展示的问题）' : ''}`;
}

export function runLogger(ctx: Context, runs: RunStore, run: RunRecord): (message: string) => void {
  const lines: string[] = [...(run.log ?? [])];
  return (message) => {
    lines.push(message.slice(0, 200));
    if (lines.length > 20) {
      lines.shift();
    }
    runs.setLog(run.id, lines);
    try {
      ctx.logger.info(`[pcb-freerouting] ${run.id.slice(0, 8)}: ${lines.at(-1)}`);
    } catch {
      /* best effort */
    }
  };
}
