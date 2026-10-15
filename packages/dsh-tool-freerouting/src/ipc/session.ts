import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';
import { computeCommand } from '../runs/compute-client.js';
import type { BoardGuard } from './board-guard.js';
import { runHelper, type HelperOptions } from './runner.js';
import { waitForHelpers, hasPendingHelpers } from './helper-processes.js';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';
import { designReportSchema, type DesignReport } from '../runs/design-report.js';

import { type IpcTarget, type ImportResult, importSchema, fillSchema } from './contracts.js';
export class IpcRun {
  importStarted = false;
  private cleanup?: Promise<void>;
  private previewActive = false;
  private previewUncertain = false;
  constructor(
    private readonly options: HelperOptions,
    readonly target: IpcTarget,
    private readonly runId: string,
    private readonly key: string,
    private readonly directory: string,
    private readonly guard: BoardGuard,
    private readonly release: () => Promise<void>,
    private readonly globalKey?: string,
  ) {
    this.options.onMutatingSpawn = async (pid) => {
      await this.guard.setHelper(this.key, pid);
      if (this.globalKey) {
        await this.guard.setHelper(this.globalKey, pid);
      }
    };
  }

  private request() {
    return {
      directory: this.directory,
      boardPath: this.target.boardPath,
      instance: this.target.instance,
      clientName: `dsh-freerouting-${this.runId}`,
    };
  }

  async exportDsn(signal: AbortSignal, recordWarning?: (message: string) => void): Promise<Buffer> {
    const result = await runHelper(
      this.options,
      'export',
      this.request(),
      z.object({ exported: z.literal(true), warnings: z.array(z.string()) }),
      signal,
    );
    for (const warning of result.warnings) {
      recordWarning?.(warning);
    }
    return readFile(join(this.directory, 'board.dsn'));
  }

  async previewSession(ses: Buffer, nets: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    await writeFile(join(this.directory, 'preview.ses'), ses);
    signal.throwIfAborted();
    if (!this.previewActive) {
      await this.guard.markImporting(this.key);
      this.previewActive = true;
    }
    try {
      signal.throwIfAborted();
      return await runHelper(
        this.options,
        'preview',
        { ...this.request(), nets },
        importSchema.omit({ designReport: true }),
        undefined,
        true,
      );
    } catch (cause) {
      if (cause instanceof UpstreamServiceError && cause.code === 'IMPORT_UNCERTAIN') {
        this.previewUncertain = true;
      }
      throw cause;
    }
  }

  async clearPreview(): Promise<void> {
    if (!this.previewActive || this.previewUncertain) {
      return;
    }
    if (hasPendingHelpers(`dsh-freerouting-${this.runId}`)) {
      this.previewUncertain = true;
      throw new UpstreamServiceError('IMPORT_UNCERTAIN', 409, '预览更新尚未确认，请先检查板子');
    }
    try {
      const cleared = await runHelper(
        this.options,
        'clear-preview',
        this.request(),
        z.object({ cleared: z.literal(true), displayWarning: z.string().optional() }),
        undefined,
        true,
      );
      await this.resolveMarker(false);
      this.previewActive = false;
      if (cleared.displayWarning) {
        this.options.onCleanupError?.(cleared.displayWarning);
      }
    } catch {
      this.previewUncertain = true;
      throw new UpstreamServiceError('IMPORT_UNCERTAIN', 409, '暂时无法确认本轮预览走线是否已清理，请先检查板子');
    }
  }

  async reviewSession(ses: Buffer, nets: readonly string[], signal: AbortSignal): Promise<DesignReport> {
    signal.throwIfAborted();
    await writeFile(join(this.directory, 'board.ses'), ses);
    return runHelper(this.options, 'review', { ...this.request(), nets }, designReportSchema, signal);
  }

  async repairDsn(
    avoidObjectIds: string[] | undefined,
    signal: AbortSignal,
    record?: (message: string) => void,
  ): Promise<Buffer> {
    const result = await runHelper(
      this.options,
      'repair',
      { ...this.request(), avoidObjectIds },
      z.object({ obstacles: z.number().int().nonnegative() }),
      signal,
    );
    record?.(
      result.obstacles
        ? `已补充 ${result.obstacles} 处铜文字避让范围，接下来重新布线一次；没有修改原板文字或元件`
        : '没有可补充的铜文字避让范围，将沿用原有约束重新尝试一次；未切换算法',
    );
    return readFile(join(this.directory, 'board.dsn'));
  }

  async designReportArtifact(): Promise<Buffer | undefined> {
    try {
      return await readFile(join(this.directory, 'design-check.json'));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw cause;
    }
  }

  async importSession(
    ses: Buffer,
    nets: readonly string[],
    signal?: AbortSignal,
    allowDesignViolations = false,
  ): Promise<ImportResult> {
    signal?.throwIfAborted();
    await writeFile(join(this.directory, 'board.ses'), ses);
    signal?.throwIfAborted();
    await this.guard.markImporting(this.key);
    try {
      signal?.throwIfAborted();
      this.importStarted = true;
      const result = await runHelper(
        this.options,
        'import',
        { ...this.request(), nets, allowDesignViolations },
        importSchema,
        undefined,
        true,
      );
      await this.resolveMarker(result.outcome === 'committed');
      return result;
    } catch (cause) {
      if (!this.importStarted || (cause instanceof UpstreamServiceError && cause.code !== 'IMPORT_UNCERTAIN')) {
        await this.resolveMarker(false);
      }
      throw cause;
    }
  }

  private async resolveMarker(committed: boolean): Promise<void> {
    try {
      await this.guard.resolve(this.key);
    } catch {
      throw new UpstreamServiceError(
        'IMPORT_UNCERTAIN',
        409,
        committed
          ? '布线已回导，但回导状态标记清理失败；请检查板子后明确解除标记，已提交走线保留'
          : '回导状态标记未能清理，请检查目标板子后明确解除标记；不要自动重试',
      );
    }
  }

  async stopComputation(): Promise<void> {
    await computeCommand(
      this.options.pythonPath,
      { command: 'stop-directory', directory: this.directory },
      z.object({ stopped: z.literal(true) }),
    );
  }

  async fillZones(): Promise<z.infer<typeof fillSchema>> {
    return runHelper(this.options, 'fill', this.request(), fillSchema, undefined, true);
  }
  async close(): Promise<void> {
    const clientName = `dsh-freerouting-${this.runId}`;
    const pending = hasPendingHelpers(clientName);
    this.cleanup ??= this.cleanupSession(clientName).catch(() => {
      // Cleanup cannot rewrite a confirmed commit/rollback result. Diagnose it
      // separately; the unknown-state marker is never removed here.
      try {
        this.options.onCleanupError?.(`IPC 任务 ${this.runId} 的临时目录或租约清理失败，请检查 ${this.directory}`);
      } catch {
        /* logger failure cannot change the board result */
      }
    });
    // A watchdog must report uncertainty immediately while the helper settles.
    if (!pending) {
      await this.cleanup;
    }
  }
  private async cleanupSession(clientName: string): Promise<void> {
    await waitForHelpers(clientName);
    try {
      const journal = join(this.directory, 'compute-launch.json');
      const present = await access(journal).then(
        () => true,
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') {
            return false;
          }
          throw cause;
        },
      );
      if (present) {
        await computeCommand(
          this.options.pythonPath,
          { command: 'release-directory', directory: this.directory },
          z.object({ released: z.literal(true) }),
        );
      }
      await rm(this.directory, { recursive: true, force: true });
    } finally {
      await this.release();
    }
  }
}
