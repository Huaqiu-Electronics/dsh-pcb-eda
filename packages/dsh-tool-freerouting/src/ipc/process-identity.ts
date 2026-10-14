import { z } from 'zod';
import { computeCommand } from '../runs/compute-client.js';

const identitySchema = z.object({
  pid: z.number().int().positive(),
  birth: z.string().regex(/^\d+$/).optional(),
  state: z.enum(['alive', 'closed', 'unknown']),
});
const responseSchema = z.object({ processes: z.array(identitySchema) });
export type ProcessIdentity = z.infer<typeof identitySchema>;
export interface ProcessTarget {
  pid: number;
  birth?: string;
  precision?: 'filetime' | 'microseconds';
}

/** No cache for external processes: every ownership check must detect PID reuse. */
export async function inspectProcesses(python: string, processes: ProcessTarget[]): Promise<ProcessIdentity[]> {
  const result = await computeCommand(python, { command: 'process-identities', processes }, responseSchema);
  if (
    result.processes.length !== processes.length ||
    result.processes.some((item, index) => item.pid !== processes[index]?.pid)
  ) {
    throw new Error('进程身份检查返回不匹配的对象');
  }
  return result.processes;
}

// Share the in-flight request too; simultaneous board leases only query the host once.
const hostBirths = new Map<string, Promise<string>>();
export function hostBirth(python: string): Promise<string> {
  let pending = hostBirths.get(python);
  if (!pending) {
    pending = processBirth(python, process.pid).catch((cause) => {
      hostBirths.delete(python);
      throw cause;
    });
    hostBirths.set(python, pending);
  }
  return pending;
}

export async function processBirth(python: string, pid: number): Promise<string> {
  const [identity] = await inspectProcesses(python, [{ pid, precision: 'microseconds' }]);
  if (identity?.state !== 'alive' || !identity.birth) {
    throw new Error('无法确认任务进程启动时间');
  }
  return identity.birth;
}
