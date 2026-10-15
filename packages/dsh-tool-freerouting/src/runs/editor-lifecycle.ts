import type { EditorState } from '../ipc/editor-process.js';

interface EditorLifecycleOptions {
  probe: (instance: string) => Promise<EditorState>;
  onClosed: (runIds: string[]) => Promise<void>;
  shutdown: () => Promise<void>;
  onError: (message: string) => void;
  intervalMs?: number;
}

/** Keep a PID watch after a run finishes, so closing an idle editor releases Java too.
 * Active runs on another editor retain the shared engine until they finish. */
export class EditorLifecycle {
  private readonly editors = new Map<string, Set<string>>();
  private timer?: ReturnType<typeof setInterval>;
  private scan?: Promise<void>;
  private stopping?: Promise<void>;
  private shutdownRequested = false;
  private disposed = false;
  private shutdownAttempts = 0;

  constructor(private readonly options: EditorLifecycleOptions) {}

  bind(instance: string, runId: string): void {
    if (this.disposed) {
      throw new Error('Editor lifecycle disposed');
    }
    // A new task adopts any retained idle engine; no old retry may kill it.
    this.shutdownRequested = false;
    this.shutdownAttempts = 0;
    const runs = this.editors.get(instance) ?? new Set<string>();
    runs.add(runId);
    this.editors.set(instance, runs);
    this.timer ??= setInterval(() => {
      this.check();
    }, this.options.intervalMs ?? 2000);
    this.timer.unref?.();
  }

  async release(runId: string): Promise<void> {
    for (const runs of this.editors.values()) {
      runs.delete(runId);
    }
    await this.stopIfIdle();
  }

  /** Serialize scans; a slow OS process probe never creates overlapping watchers. */
  check(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.scan) {
      return this.scan;
    }
    this.scan = Promise.all(
      [...this.editors].map(async ([instance, runs]) => {
        const state = await this.options.probe(instance);
        if (this.disposed || state !== 'closed' || this.editors.get(instance) !== runs) {
          return;
        }
        this.editors.delete(instance);
        this.shutdownRequested = true;
        this.shutdownAttempts = 0;
        // onClosed synchronously signals cancellation before waiting for a protected
        // Python operation. Java owns no live-board transaction and can exit now.
        const cancelled = this.options.onClosed([...runs]);
        await this.stopIfIdle();
        await cancelled;
      }),
    )
      .then(async () => {
        await this.stopIfIdle();
        if (!this.editors.size && (!this.shutdownRequested || this.shutdownAttempts >= 3) && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      })
      .catch(() => {
        this.options.onError('未能完成编辑器退出后的任务或引擎清理，请保留诊断信息');
      })
      .finally(() => {
        this.scan = undefined;
      });
    return this.scan;
  }

  private async stopIfIdle(): Promise<void> {
    if (!this.shutdownRequested || [...this.editors.values()].some((runs) => runs.size)) {
      return;
    }
    if (this.stopping) {
      return this.stopping;
    }
    if (this.shutdownAttempts >= 3) {
      return;
    }
    this.shutdownAttempts++;
    this.stopping = this.options
      .shutdown()
      .then(() => {
        this.shutdownRequested = false;
      })
      .catch(() => {
        this.options.onError('任务已停止，但布线引擎退出未能确认；已保留引擎，下次确认上一轮计算停止后尝试复用');
      })
      .finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    await this.scan;
    await this.stopping;
    this.editors.clear();
  }
}
