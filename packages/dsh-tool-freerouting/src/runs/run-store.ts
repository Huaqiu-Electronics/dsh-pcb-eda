import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Agent } from '@deepseek-ai/dsh-agent';

import type {
  RouteParameters,
  RunError,
  RunOutput,
  RunArtifact,
  RunProgress,
  RunRecord,
  RunState,
  RoutingAlgorithm,
} from './contracts.js';
import type { DesignReport } from './design-report.js';
import type { PreviewScene } from '../contracts/preview.js';
import { resourceLimits } from './resource-guard.js';

interface RunStoreOptions {
  maxPendingRuns: number;
  resultTtlMs: number;
}

export class RunStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = 'RunStoreError';
  }
}

function tokenEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isActive(state: RunState): boolean {
  return state === 'queued' || state === 'running' || state === 'repair_pending';
}

/**
 * In-memory routing run registry. Unlike the autoplacement store there is no upload
 * phase: a run is created directly in `queued` and the DSN is pulled from KiCad by the
 * background job, so the browser only ever reads status/output.
 */
export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: RunStoreOptions) {
    this.timer = setInterval(() => this.cleanup(), Math.min(options.resultTtlMs, 60_000));
    this.timer.unref?.();
  }

  create(algorithm: RoutingAlgorithm, parameters: RouteParameters, owner: Agent): RunRecord {
    this.ensureBudget(0);
    const pending = [...this.runs.values()].filter((run) => isActive(run.state)).length;
    if (pending >= this.options.maxPendingRuns) {
      const existing = [...this.runs.values()].find((run) => isActive(run.state))!;
      throw new RunStoreError('BOARD_RUN_ACTIVE', 409, `整个插件当前只允许一个布线任务，已有任务：${existing.id}`);
    }

    const now = Date.now();
    const run: RunRecord = {
      algorithm,
      createdAt: now,
      expiresAt: now + this.options.resultTtlMs,
      id: randomUUID(),
      owner,
      ownerSessionId: owner.id,
      parameters,
      state: 'queued',
      token: randomBytes(32).toString('base64url'),
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  authorize(id: string, token: string): RunRecord | undefined {
    const run = this.runs.get(id);
    if (run === undefined || run.state === 'expired' || (!isActive(run.state) && run.expiresAt <= Date.now())) {
      return undefined;
    }
    return tokenEquals(run.token, token) ? run : undefined;
  }

  require(id: string): RunRecord {
    const run = this.runs.get(id);
    if (run === undefined) {
      throw new RunStoreError('RUN_NOT_FOUND', 404, '这次布线任务已无法找到，请查看原对话的最终结果');
    }
    return run;
  }

  setJobId(id: string, jobId: string): void {
    const run = this.require(id);
    run.jobId = jobId;
    run.updatedAt = Date.now();
  }

  running(id: string): void {
    this.transition(this.require(id), 'running');
  }

  awaitRepair(id: string, report: DesignReport): void {
    const run = this.require(id);
    run.designReport = report;
    run.expiresAt = Date.now() + this.options.resultTtlMs;
    this.transition(run, 'repair_pending');
  }

  expire(id: string): void {
    this.transition(this.require(id), 'expired');
  }

  setProgress(id: string, progress: RunProgress): void {
    const run = this.require(id);
    run.progress = progress;
    run.updatedAt = Date.now();
  }

  /** Retain only the latest snapshot, under the task's existing capability and expiry. */
  setPreview(
    id: string,
    round: 1 | 2,
    state: 'waiting' | 'ready' | 'unavailable',
    scene?: PreviewScene,
    final = false,
  ): void {
    const run = this.require(id);
    run.preview = {
      meta: {
        revision: (run.preview?.meta.revision ?? 0) + 1,
        round,
        state,
        final,
        imported: false,
        updated_at: new Date().toISOString(),
      },
      ...(scene === undefined ? {} : { scene }),
    };
    run.updatedAt = Date.now();
  }

  previewImported(id: string): void {
    const run = this.require(id);
    if (run.preview) {
      run.preview.meta = { ...run.preview.meta, imported: true };
    }
    run.updatedAt = Date.now();
  }

  /** Replace the run's rolling, user-visible log (already capped by the caller). */
  setLog(id: string, log: readonly string[]): void {
    const run = this.require(id);
    run.log = [...log];
    run.updatedAt = Date.now();
  }

  succeed(id: string, output: RunOutput): void {
    this.ensureBudget(output.content === this.require(id).artifact?.content ? 0 : output.content.byteLength);
    const run = this.require(id);
    run.output = output;
    delete run.error;
    run.expiresAt = Date.now() + this.options.resultTtlMs;
    this.transition(
      run,
      output.routing.zoneFill === 'failed' || output.routing.designReport?.count ? 'partial' : 'succeeded',
    );
  }

  retain(id: string, artifact: RunArtifact): void {
    this.ensureBudget(artifact.content.byteLength - (this.require(id).artifact?.content.byteLength ?? 0));
    this.require(id).artifact = artifact;
  }

  retainReport(id: string, artifact?: RunArtifact): void {
    this.ensureBudget((artifact?.content.byteLength ?? 0) - (this.require(id).reportArtifact?.content.byteLength ?? 0));
    this.require(id).reportArtifact = artifact;
  }

  private ensureBudget(additional: number): void {
    this.cleanup();
    const bytes = [...this.runs.values()].reduce(
      (sum, run) =>
        sum +
        (run.artifact?.content.byteLength ?? 0) +
        (run.output?.content === run.artifact?.content ? 0 : (run.output?.content.byteLength ?? 0)) +
        (run.reportArtifact?.content.byteLength ?? 0),
      0,
    );
    if (bytes + additional >= resourceLimits.retainedBytes) {
      throw new RunStoreError(
        'RESOURCE_LIMIT',
        429,
        '保留结果的容量已达到保护上限，请等待旧结果过期；已有结果仍可下载',
      );
    }
  }

  fail(id: string, error: RunError): void {
    const run = this.require(id);
    run.error = error;
    run.expiresAt = Date.now() + this.options.resultTtlMs;
    this.transition(run, 'failed');
  }

  cancel(id: string): void {
    const run = this.require(id);
    run.expiresAt = Date.now() + this.options.resultTtlMs;
    this.transition(run, 'cancelled');
  }

  cleanup(now = Date.now()): void {
    for (const [id, run] of this.runs) {
      if (run.expiresAt > now || isActive(run.state)) {
        continue;
      }
      run.state = 'expired';
      this.runs.delete(id);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.runs.clear();
  }

  private transition(run: RunRecord, state: RunState): void {
    run.state = state;
    run.updatedAt = Date.now();
  }
}
