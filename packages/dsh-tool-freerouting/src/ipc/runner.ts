import { trackHelper } from './helper-processes.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';

const envelope = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
  error: z.string().optional(),
  outcome: z.enum(['unchanged', 'rolled_back', 'committed', 'uncertain']).optional(),
  data: z.unknown().optional(),
});

export interface HelperOptions {
  pythonPath: string;
  socket: string;
  timeoutMs: number;
  onMutatingSpawn?: (pid: number) => Promise<void>;
  onCleanupError?: (message: string) => void;
}

function helperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '../python/kicad_helper.py'), join(here, '../../python/kicad_helper.py')];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new UpstreamServiceError('HELPER_MISSING', 503, '插件 Python helper 缺失，请重新安装插件');
  }
  // pnpm file dependencies can resolve beyond MAX_PATH. Python's native DLL
  // loader needs the extended Windows path, including for vendor imports.
  return toNamespacedPath(found);
}

/** A write command never receives the user's cancellation signal or gets forcibly killed. */
export async function runHelper<T>(
  options: HelperOptions,
  command: string,
  request: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  mutating = false,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.pythonPath, ['-u', helperPath(), command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUTF8: '1',
        DSH_COMPUTE_OWNER: JSON.stringify({ pid: process.pid }),
      },
    });
    const clientName = (request as { clientName?: string }).clientName ?? '';
    trackHelper(child, clientName);
    let bytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const settle = (error?: unknown, data?: T) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        reject(error);
      } else {
        resolve(data!);
      }
    };
    const uncertain = () =>
      new UpstreamServiceError('IMPORT_UNCERTAIN', 409, '回导状态待确认；请检查目标板子后明确解除标记，不要自动重试');
    const abort = () => {
      if (!mutating) {
        child.kill();
      }
      settle(signal?.reason instanceof Error ? signal.reason : new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      if (!mutating) {
        child.kill();
      }
      // Keep draining the process so it can finish a transaction. The durable marker remains.
      settle(mutating ? uncertain() : new UpstreamServiceError('HELPER_TIMEOUT', 504, 'KiCad helper 执行超时'));
    }, options.timeoutMs);
    if (!mutating) {
      signal?.addEventListener('abort', abort, { once: true });
    }
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 16 * 1024 * 1024) {
        chunks.push(chunk);
      } else {
        if (!mutating) {
          child.kill();
        }
        settle(mutating ? uncertain() : new UpstreamServiceError('HELPER_OUTPUT_LIMIT', 502, 'helper 输出超出限制'));
      }
    });
    // Do not log stderr: a transport exception could contain connection credentials.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () =>
      settle(
        mutating ? uncertain() : new UpstreamServiceError('HELPER_SPAWN_FAILED', 503, '无法启动 KiCad Python helper'),
      ),
    );
    child.on('close', (code) => {
      if (finished) {
        return;
      }
      try {
        const result = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!result.ok) {
          const known = result.outcome === 'unchanged' || result.outcome === 'rolled_back';
          throw new UpstreamServiceError(
            mutating && !known ? 'IMPORT_UNCERTAIN' : (result.code ?? 'KICAD_HELPER_FAILED'),
            409,
            result.error ?? 'KiCad 操作失败',
          );
        }
        if (code !== 0) {
          throw uncertain();
        }
        settle(undefined, schema.parse(result.data));
      } catch (cause) {
        settle(
          cause instanceof UpstreamServiceError
            ? cause
            : mutating
              ? uncertain()
              : new UpstreamServiceError('HELPER_PROTOCOL_FAILED', 502, 'helper 返回了无效结果'),
        );
      }
    });
    const send = async () => {
      if (mutating && child.pid) {
        await options.onMutatingSpawn?.(child.pid);
      }
      if (!finished) {
        child.stdin.end(
          JSON.stringify({ ...options, ...(request as object), token: process.env.KICAD_API_TOKEN ?? '' }),
        );
      } else {
        child.stdin.end();
      }
    };
    send().catch(() => {
      child.stdin.end();
      settle(mutating ? uncertain() : new UpstreamServiceError('HELPER_REQUEST_FAILED', 503, '无法发送 helper 请求'));
    });
    if (signal?.aborted && !mutating) {
      abort();
    }
  });
}
