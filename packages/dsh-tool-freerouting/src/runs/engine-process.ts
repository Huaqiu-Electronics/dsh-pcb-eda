import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { computeCommand, computeRecordSchema, type ComputeRecord } from './compute-client.js';

/** Only the exact compute job created by this launcher is owned. */
export class EngineProcess {
  private timer?: ReturnType<typeof setInterval>;
  private checking?: Promise<void>;
  private stopping?: Promise<void>;
  private cleanup?: Promise<void>;

  private constructor(
    readonly record: ComputeRecord,
    private readonly python: string,
    private readonly directory: string,
    private readonly onExit: () => void,
  ) {
    this.timer = setInterval(() => {
      if (this.checking) {
        return;
      }
      this.checking = this.inspect()
        .catch(() => {})
        .finally(() => {
          this.checking = undefined;
        });
    }, 2000);
    this.timer.unref?.();
  }

  static async launch(python: string, argv: string[], directory: string, onExit: () => void): Promise<EngineProcess> {
    let record: ComputeRecord;
    try {
      record = await computeCommand(
        python,
        { command: 'launch', argv, directory, owner: { pid: process.pid } },
        computeRecordSchema,
      );
    } catch (cause) {
      await computeCommand(python, { command: 'recover-launch', directory }, z.object({ recovered: z.literal(true) }));
      await rm(directory, { recursive: true, force: true });
      throw cause;
    }
    return new EngineProcess(record, python, directory, onExit);
  }

  async isAlive(): Promise<boolean> {
    const result = await computeCommand(
      this.python,
      { command: 'state', record: this.record },
      z.object({ state: z.enum(['alive', 'closed']) }),
    );
    if (result.state === 'closed') {
      await this.finish();
    }
    return result.state === 'alive';
  }

  get pid(): number {
    return this.record.pid;
  }

  private async inspect(): Promise<void> {
    const result = await computeCommand(
      this.python,
      { command: 'state', record: this.record },
      z.object({ state: z.enum(['alive', 'closed']) }),
    );
    if (result.state === 'closed') {
      await this.finish();
    }
  }

  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    this.stopping = this.stopOnce().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private finish(): Promise<void> {
    this.cleanup ??= this.cleanupOnce();
    return this.cleanup;
  }
  private async stopOnce(): Promise<void> {
    await computeCommand(
      this.python,
      { command: 'stop', record: this.record },
      z.object({ state: z.literal('closed') }),
    );
    await this.finish();
  }

  private async cleanupOnce(): Promise<void> {
    clearInterval(this.timer);
    // Never retry consumption of a remote handle: CLOSE_SOURCE can consume on error.
    try {
      await computeCommand(
        this.python,
        { command: 'release', record: this.record },
        z.object({ released: z.literal(true) }),
      );
      await rm(this.directory, { recursive: true, force: true });
    } finally {
      // Actual exit was confirmed before finish. A file/handle cleanup failure
      // must not keep a dead engine blocking every later launch.
      this.onExit();
    }
  }
}
