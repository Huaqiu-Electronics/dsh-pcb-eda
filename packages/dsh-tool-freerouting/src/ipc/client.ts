import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BoardGuard } from './board-guard.js';
import { pythonPath } from './python-runtime.js';
import { runHelper, type HelperOptions } from './runner.js';

import { targetSchema, type IpcTarget } from './contracts.js';
import { IpcRun } from './session.js';
export interface IpcOptions {
  kicadPythonPath: string;
  kicadApiSocket: string;
  requestTimeoutMs: number;
  stateDirectory: string;
  onCleanupError?: (message: string) => void;
}

export class KicadIpcClient {
  readonly guard: BoardGuard;
  private selectedPython?: string;
  constructor(private readonly options: IpcOptions) {
    this.guard = new BoardGuard(options.stateDirectory, () => this.pythonExecutable());
  }
  pythonExecutable(): string {
    // Keep the selected runtime usable for cleanup after its editor has closed.
    return (this.selectedPython ??= pythonPath(this.options.kicadPythonPath));
  }

  private optionsFor(socket = this.options.kicadApiSocket): HelperOptions {
    return {
      pythonPath: this.pythonExecutable(),
      socket,
      timeoutMs: this.options.requestTimeoutMs,
      onCleanupError: this.options.onCleanupError,
    };
  }

  async target(signal?: AbortSignal): Promise<IpcTarget> {
    return runHelper(this.optionsFor(), 'discover', {}, targetSchema, signal);
  }

  async open(runId: string, signal: AbortSignal): Promise<IpcRun> {
    const options = this.optionsFor();
    const target = await runHelper(options, 'discover', {}, targetSchema, signal);
    const key = this.guard.key(target.boardPath);
    const globalKey = this.guard.key(join(this.options.stateDirectory, 'global-routing-slot'));
    const releaseGlobal = await this.guard.acquire(globalKey, runId);
    let releaseBoard: () => Promise<void>;
    try {
      releaseBoard = await this.guard.acquire(key, runId);
    } catch (cause) {
      await releaseGlobal();
      throw cause;
    }
    const release = async () => {
      await releaseBoard();
      await releaseGlobal();
    };
    let directory: string;
    try {
      directory = await mkdtemp(join(tmpdir(), 'dsh-freerouting-'));
    } catch (cause) {
      await release();
      throw cause;
    }
    return new IpcRun(
      { ...options, socket: target.socket },
      target,
      runId,
      key,
      directory,
      this.guard,
      release,
      globalKey,
    );
  }

  async acknowledge(): Promise<IpcTarget> {
    const target = await this.target();
    await this.guard.acknowledge(this.guard.key(target.boardPath));
    return target;
  }
}
