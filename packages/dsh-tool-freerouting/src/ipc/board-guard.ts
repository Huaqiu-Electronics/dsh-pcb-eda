import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, link, rename } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';
import { confirmBoard } from './board-confirm.js';
import { hostBirth, processBirth, inspectProcesses, type ProcessTarget } from './process-identity.js';

const leaseSchema = z.object({
  runId: z.string(),
  pid: z.number().int().positive(),
  birth: z.string(),
  helperPid: z.number().int().positive().optional(),
  helperBirth: z.string().optional(),
});
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw cause;
  }
}

/** File-scoped guard also covers different KiCad instances opening the same PCB. */
export class BoardGuard {
  constructor(
    private readonly directory: string,
    private readonly getPython: () => string,
  ) {}

  key(boardPath: string): string {
    return createHash('sha256').update(win32.normalize(boardPath).toLowerCase()).digest('hex');
  }

  private paths(key: string) {
    return {
      lease: join(this.directory, `${key}.lease`),
      marker: join(this.directory, `${key}.uncertain`),
      confirmation: join(this.directory, `${key}.confirmation`),
    };
  }

  async acquire(key: string, runId: string): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true });
    const paths = this.paths(key);
    await this.confirmationIdle(paths.confirmation);
    const temporary = await this.prepare(paths.lease, {
      runId,
      pid: process.pid,
      birth: await hostBirth(this.getPython()),
    });
    // Publish a complete lease atomically. A competing request can always read
    // the owning run ID, rather than observing an empty just-created file.
    try {
      await link(temporary, paths.lease);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw cause;
      }
      const lease = leaseSchema.parse(JSON.parse(await readFile(paths.lease, 'utf8')));
      if (await this.ownsLease(lease)) {
        throw new UpstreamServiceError('BOARD_RUN_ACTIVE', 409, `该板子已有任务 ${lease.runId}，首期不排队`);
      }
      if (await exists(paths.marker)) {
        this.blocked();
      }
      throw new UpstreamServiceError(
        'STALE_BOARD_LEASE',
        409,
        '上次进程异常退出；请检查板子后调用 pcb_confirm_board_checked 解除残留任务标记',
      );
    } finally {
      await unlink(temporary);
    }
    try {
      await this.confirmationIdle(paths.confirmation);
      if (await exists(paths.marker)) {
        this.blocked();
      }
    } catch (cause) {
      await unlink(paths.lease);
      throw cause;
    }
    return async () => {
      await unlink(paths.lease).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw cause;
        }
      });
    };
  }

  async markImporting(key: string): Promise<void> {
    // Write ahead of any IPC mutation, so a whole-DSH crash cannot lose the uncertainty.
    const file = await open(this.paths(key).marker, 'wx');
    try {
      await file.writeFile('{"state":"uncertain","version":1}');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async resolve(key: string): Promise<void> {
    await unlink(this.paths(key).marker);
  }

  async setHelper(key: string, helperPid: number): Promise<void> {
    const path = this.paths(key).lease;
    const lease = leaseSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const temporary = await this.prepare(path, {
      ...lease,
      helperPid,
      helperBirth: await processBirth(this.getPython(), helperPid),
    });
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw cause;
        }
      });
    }
  }

  private async ownsLease(lease: z.infer<typeof leaseSchema>): Promise<boolean> {
    const targets: ProcessTarget[] = [{ pid: lease.pid, birth: lease.birth, precision: 'microseconds' }];
    if (lease.helperPid) {
      targets.push({ pid: lease.helperPid, birth: lease.helperBirth, precision: 'microseconds' });
    }
    try {
      const identities = await inspectProcesses(this.getPython(), targets);
      return identities.some((identity) => identity.state !== 'closed');
    } catch {
      // Unreadable process identity must never release a live task.
      return true;
    }
  }

  private async prepare(path: string, value: unknown): Promise<string> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } catch (cause) {
      await file.close();
      await unlink(temporary);
      throw cause;
    }
    await file.close();
    return temporary;
  }

  async acknowledge(key: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await confirmBoard(this.getPython(), this.paths(key));
  }

  private async confirmationIdle(path: string): Promise<void> {
    try {
      await readFile(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw new UpstreamServiceError(
        'BOARD_CONFIRM_IN_PROGRESS',
        409,
        '正在确认目标板子状态，当前请求已拒绝；请稍后重试',
      );
    }
  }

  private blocked(): never {
    throw new UpstreamServiceError(
      'IMPORT_UNCERTAIN',
      409,
      '该板子的回导状态待确认；请检查板子后调用 pcb_confirm_board_checked，重启不会解除标记',
    );
  }
}
