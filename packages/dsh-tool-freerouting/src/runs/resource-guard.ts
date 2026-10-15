import { z } from 'zod';
import { computeCommand } from './compute-client.js';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';

const MiB = 1024 * 1024;
export const resourceLimits = {
  // 32 MiB native SES limit + base64/JSON envelope.
  responseBytes: 48 * MiB,
  retainedBytes: 128 * MiB,
  // Conservative stop before the shipped 2 GiB JVM heap is exhausted.
  // Scope: the compute a run owns (the routing engine and its one-shot helpers).
  // A process the run merely shares the machine with (KiCad editor, DSH host) is
  // bounded by the machine-wide cleanup reserve, never by this ceiling.
  processPrivateBytes: 1536 * MiB,
  // >2x the measured dedicated editor private-byte peak.
  cleanupReserveBytes: 1024 * MiB,
  sampleIntervalMs: 2000,
};
const sampleSchema = z.object({
  available: z.number(),
  commitAvailable: z.number(),
  total: z.number(),
  processes: z.array(z.object({ pid: z.number(), private: z.number(), working: z.number() })),
});
export type ResourceSample = z.infer<typeof sampleSchema>;

export function resourceViolation(sample: ResourceSample): string | undefined {
  if (Math.min(sample.available, sample.commitAvailable) < resourceLimits.cleanupReserveBytes) {
    return '电脑可用内存不足，已停止布线并预留清理空间；已有可用结果仍保留';
  }
  if (sample.processes.some((item) => item.private > resourceLimits.processPrivateBytes)) {
    return '本次布线相关程序的内存占用达到保护上限，已停止布线；已有可用结果仍保留';
  }
}

/** Samples serialize and never stop the PCB editor or a mutating helper. */
export class ResourceGuard {
  constructor(private readonly python: () => string) {}

  /**
   * Watch the compute a run owns.
   *
   * `ownedPids` must return only processes this run started — the routing engine
   * and its one-shot helpers — because the sampler expands each root to its
   * descendants and `resourceLimits.processPrivateBytes` is calibrated for the
   * shipped JVM heap. Sampling a shared process such as the KiCad editor aborts
   * every run the moment that editor is normally loaded.
   */
  async watch(ownedPids: () => number[], stop: (reason: Error) => void): Promise<() => void> {
    let disposed = false,
      checking = false;
    const check = async () => {
      if (disposed || checking) {
        return;
      }
      checking = true;
      try {
        const sample = await computeCommand(this.python(), { command: 'sample', pids: ownedPids() }, sampleSchema);
        if (disposed) {
          return;
        }
        const issue = resourceViolation(sample);
        if (issue) {
          stop(new UpstreamServiceError('RESOURCE_LIMIT', 429, issue));
        }
      } catch {
        if (!disposed) {
          stop(
            new UpstreamServiceError('RESOURCE_CHECK_FAILED', 503, '无法确认可用内存，本次布线已暂停；已有结果仍保留'),
          );
        }
      } finally {
        checking = false;
      }
    };
    await check();
    const timer = setInterval(() => {
      void check();
    }, resourceLimits.sampleIntervalMs);
    timer.unref?.();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }
}
