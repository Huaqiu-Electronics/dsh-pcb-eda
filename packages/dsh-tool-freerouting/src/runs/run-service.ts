import { RoutingRound } from './routing-round.js';
import { RepairNeeded, type RepairPlan } from './repair-plan.js';
import type { Context } from '@deepseek-ai/cordis';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { KicadIpcClient } from '../ipc/client.js';
import type { IpcRun } from '../ipc/session.js';
import type { FreeroutingClient } from '../proxy/freerouting-client.js';
import { runError, UpstreamServiceError } from '../proxy/upstream-errors.js';
import type { RunRecord } from './contracts.js';
import type { FreeroutingLauncher } from './launcher.js';
import type { RunStore } from './run-store.js';

import { briefConflicts } from './design-report.js';
import { routingRunText } from '../presentation/routing-copy.js';

import { ProcessRecorder, runLogger } from './process-recorder.js';
import type { EditorLifecycle } from './editor-lifecycle.js';
import type { ResourceGuard } from './resource-guard.js';
import { activeHelperPids, hasAnyPendingHelpers } from '../ipc/helper-processes.js';
import { pid as processId } from 'node:process';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'pcb-freerouting': 'pcb-freerouting';
  }
}

/** Resolve and lock the target before acknowledging a new routing request. */
export class RunService {
  private readonly round: RoutingRound;
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<JobOutcome>>();
  private readonly starts = new Set<Promise<string>>();
  private disposed = false;
  private readonly pendingRepairs = new Map<
    string,
    {
      session: IpcRun;
      timer: ReturnType<typeof setTimeout>;
      fallback: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly ctx: Context,
    private readonly runs: RunStore,
    freerouting: FreeroutingClient,
    private readonly ipc: KicadIpcClient,
    private readonly launcher?: FreeroutingLauncher,
    private readonly editors?: EditorLifecycle,
    private readonly resources?: ResourceGuard,
  ) {
    this.round = new RoutingRound(runs, freerouting, launcher);
  }

  start(run: RunRecord, signal?: AbortSignal): Promise<string> {
    const existing = this.controllers.keys().next().value ?? this.pendingRepairs.keys().next().value;
    if (existing || this.starts.size || hasAnyPendingHelpers()) {
      const error = new UpstreamServiceError(
        'BOARD_RUN_ACTIVE',
        409,
        `当前布线或板子处理尚未结束；已有任务：${existing ?? '正在完成清理'}`,
      );
      this.runs.fail(run.id, runError(error));
      return Promise.reject(error);
    }
    const pending = this.startBound(run, signal);
    this.starts.add(pending);
    pending.then(
      () => this.starts.delete(pending),
      () => this.starts.delete(pending),
    );
    return pending;
  }

  private async startBound(run: RunRecord, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const cancelled = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) {
      cancelled();
    }
    let session: IpcRun | undefined;
    this.controllers.set(run.id, controller);
    try {
      if (this.disposed) {
        throw new Error('Plugin disposed');
      }
      controller.signal.throwIfAborted();
      const process = new ProcessRecorder(run, this.runs, runLogger(this.ctx, this.runs, run));
      process.stage('正在连接目标板子，检查是否可以开始布线');
      session = await this.ipc.open(run.id, controller.signal);
      this.editors?.bind(session.target.instance, run.id);
      process.note('已确认目标板子；后续处理固定使用这块板子，原有走线和过孔保留');
      controller.signal.throwIfAborted();
      const jobId = this.launchJob(run, session, controller);
      return jobId;
    } catch (cause) {
      this.controllers.delete(run.id);
      await session?.close();
      await this.editors?.release(run.id);
      this.runs.fail(run.id, runError(cause));
      throw cause;
    } finally {
      signal?.removeEventListener('abort', cancelled);
    }
  }

  private launchJob(run: RunRecord, bound: IpcRun, controller: AbortController, repair?: RepairPlan): string {
    const jobId = this.ctx.jobs.start({
      kind: 'pcb-freerouting',
      label: run.algorithm === 'route' ? 'PCB 整板自动布线' : 'PCB 指定网络自动布线',
      outputLimitBytes: 16 * 1024,
      owner: run.owner.id,
      run: () => {
        const done = this.execute(run, bound, controller.signal, repair);
        this.tasks.add(done);
        done.then(
          () => this.tasks.delete(done),
          () => this.tasks.delete(done),
        );
        return { cancel: (reason) => controller.abort(reason), done };
      },
    });
    this.runs.setJobId(run.id, jobId);
    return jobId;
  }

  async repair(run: RunRecord, avoidObjectIds?: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const pending = this.pendingRepairs.get(run.id);
    if (this.disposed || run.state !== 'repair_pending' || !pending || run.expiresAt <= Date.now()) {
      throw new UpstreamServiceError('REPAIR_UNAVAILABLE', 409, '本次任务不能再次自动重新布线');
    }
    // Claim synchronously before starting a job: concurrent continuation requests cannot reroute twice.
    this.pendingRepairs.delete(run.id);
    clearTimeout(pending.timer);
    clearTimeout(pending.fallback);
    this.runs.running(run.id);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    try {
      return this.launchJob(run, pending.session, controller, { avoidObjectIds });
    } catch (cause) {
      this.controllers.delete(run.id);
      this.runs.fail(run.id, runError(cause));
      await pending.session.close();
      await this.editors?.release(run.id);
      throw cause;
    }
  }

  async cancel(run: RunRecord): Promise<void> {
    const pending = this.pendingRepairs.get(run.id);
    if (pending) {
      this.pendingRepairs.delete(run.id);
      clearTimeout(pending.timer);
      clearTimeout(pending.fallback);
      this.runs.cancel(run.id);
      await pending.session.close();
      await this.editors?.release(run.id);
    } else {
      this.controllers.get(run.id)?.abort(new DOMException('Cancelled', 'AbortError'));
    }
  }

  async editorClosed(runIds: string[]): Promise<void> {
    const cancelled: Promise<void>[] = [];
    for (const id of runIds) {
      const run = this.runs.require(id);
      if (!['queued', 'running', 'repair_pending'].includes(run.state)) {
        continue;
      }
      new ProcessRecorder(run, this.runs, runLogger(this.ctx, this.runs, run)).note(
        '目标 PCB 编辑器已关闭，已请求停止布线；请重新打开后检查板子状态',
      );
      if (this.pendingRepairs.has(id)) {
        cancelled.push(this.cancel(run));
      } else {
        this.controllers.get(id)?.abort(new UpstreamServiceError('EDITOR_CLOSED', 409, '目标 PCB 编辑器已关闭'));
      }
    }
    await Promise.allSettled(cancelled);
  }

  async acknowledge(): Promise<{ boardPath: string }> {
    return this.ipc.acknowledge();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.controllers.values()) {
      controller.abort('plugin disposed');
    }
    await this.editors?.dispose();
    await Promise.allSettled([...this.starts]);
    await Promise.allSettled([...this.tasks]);
    const pending = [...this.pendingRepairs.values()];
    this.pendingRepairs.clear();
    for (const value of pending) {
      clearTimeout(value.timer);
      clearTimeout(value.fallback);
    }
    await Promise.allSettled(pending.map((value) => value.session.close()));
  }

  private async execute(
    run: RunRecord,
    session: IpcRun,
    signal: AbortSignal,
    repair?: RepairPlan,
  ): Promise<JobOutcome> {
    this.runs.running(run.id);
    const process = new ProcessRecorder(run, this.runs, runLogger(this.ctx, this.runs, run));
    const record = (message: string) => process.note(message);
    let stopResources: (() => void) | undefined;
    try {
      stopResources = await this.resources?.watch(
        () =>
          [
            processId,
            Number(session.target.instance.split(':')[0]),
            this.launcher?.pid ?? 0,
            ...activeHelperPids,
          ].filter((pid) => pid > 0),
        (reason) => {
          this.controllers.get(run.id)?.abort(reason);
          // Stop compute only; preview cleanup and begun board writes stay protected.
          Promise.allSettled([this.launcher?.shutdown(), session.stopComputation?.()]).then((results) => {
            if (results.some((result) => result.status === 'rejected')) {
              record('已请求停止计算，但退出尚未确认；后续复用前将再次检查');
            }
          });
        },
      );
      const output = await this.round.execute(run, session, signal, process, repair);
      this.runs.succeed(run.id, output);
      const detail = routingRunText({ state: run.state, summary: output.routing });
      process.stage('布线任务已结束，请检查结果后再手动保存');
      record(detail);
      return {
        status: 'completed',
        detail,
        result: JSON.stringify({
          user_message: detail,
          run_id: run.id,
          state: run.state,
          summary: {
            imported: output.routing.imported,
            tracks: output.routing.tracks,
            vias: output.routing.vias,
            zone_fill: output.routing.zoneFill,
            warning: output.routing.warning?.slice(0, 1000),
            repair_attempts: output.routing.repairAttempts,
            rule_problem_count: output.routing.designReport?.count,
          },
          conflicts: briefConflicts(output.routing.designReport),
        }),
      };
    } catch (cause) {
      if (!signal.aborted) {
        await this.editors?.check();
      }
      if (cause instanceof RepairNeeded && !signal.aborted) {
        this.runs.awaitRepair(run.id, cause.report);
        process.stage('等待自动处理布线冲突；过程走线已清理，最终结果尚未添加');
        const timer = setTimeout(
          () => {
            this.pendingRepairs.delete(run.id);
            this.runs.expire(run.id);
            session
              .close()
              .then(() => this.editors?.release(run.id))
              .catch(() => record('过期任务清理未能完成，请保留诊断信息并检查板子状态'));
          },
          Math.max(1, run.expiresAt - Date.now()),
        );
        timer.unref?.();
        // The user authorized automatic handling, including when the agent cannot
        // continue. A bounded grace period lets it decide before using the safe
        // default repair. Both paths share the same synchronous one-attempt claim.
        const fallback = setTimeout(
          () => {
            if (this.disposed || !this.pendingRepairs.has(run.id)) {
              return;
            }
            record('按已授权的默认方案继续同一任务，尝试补充铜文字避让范围后重新布线一次');
            this.repair(run).catch(() => {
              /* repair already records dispatch failure and releases the lease */
            });
          },
          Math.min(30_000, Math.max(1, (run.expiresAt - Date.now()) / 2)),
        );
        fallback.unref?.();
        this.pendingRepairs.set(run.id, { session, timer, fallback });
        return {
          status: 'completed',
          detail: '发现布线规则问题，助手需自动处理后继续；尚未添加到板子',
          result: JSON.stringify({
            user_message: routingRunText({ state: 'repair_pending' }),
            run_id: run.id,
            state: 'repair_pending',
            imported: false,
            next_tool: 'pcb_repair_route',
            rule_problem_count: cause.report.count,
            instruction:
              '自动判断并调用 pcb_repair_route 继续同一任务，不询问用户，不新建布线任务。默认避让所有原板铜文字。只重新布线一次，剩余规则错误自动放行并说明。',
            conflicts: briefConflicts(cause.report),
          }),
        };
      }
      const error = runError(
        !(cause instanceof UpstreamServiceError && cause.code === 'IMPORT_UNCERTAIN') &&
          signal.aborted &&
          signal.reason instanceof UpstreamServiceError &&
          signal.reason.code.startsWith('RESOURCE_')
          ? signal.reason
          : cause,
      );
      if (
        signal.aborted &&
        error.code !== 'IMPORT_UNCERTAIN' &&
        !session.importStarted &&
        !(signal.reason instanceof UpstreamServiceError && signal.reason.code.startsWith('RESOURCE_'))
      ) {
        const detail =
          signal.reason instanceof UpstreamServiceError && signal.reason.code === 'EDITOR_CLOSED'
            ? '目标 PCB 编辑器已关闭，布线任务已取消，最终结果未添加'
            : '任务已取消，本轮过程走线已清理，最终结果未添加';
        process.stage(detail);
        this.runs.cancel(run.id);
        return { status: 'killed', detail };
      }
      process.diagnose(error.message);
      process.stage(routingRunText({ state: 'failed', error }));
      this.runs.fail(run.id, error);
      return {
        status: 'failed',
        detail: routingRunText({ state: 'failed', error }),
        result: JSON.stringify({
          run_id: run.id,
          state: 'failed',
          user_message: routingRunText({ state: 'failed', error }),
        }),
      };
    } finally {
      stopResources?.();
      this.controllers.delete(run.id);
      if (!this.pendingRepairs.has(run.id)) {
        await session.close();
        await this.editors?.release(run.id);
      }
    }
  }
}
