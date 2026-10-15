import { Buffer } from 'node:buffer';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { dirname, join, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';

export const computeRecordSchema = z.object({
  pid: z.number().int().positive(),
  birth: z.string(),
  job: z.string(),
  remote: z.string(),
  owner: z.object({ pid: z.number().int().positive(), birth: z.string() }),
});
export type ComputeRecord = z.infer<typeof computeRecordSchema>;

export async function computeCommand<T>(python: string, command: object, schema: z.ZodType<T>): Promise<T> {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = [join(here, '../python/compute_host.py'), join(here, '../../python/compute_host.py')].find(existsSync);
  if (!script) {
    throw new UpstreamServiceError('COMPUTE_HELPER_MISSING', 503, '计算进程管理文件缺失，请重新安装插件');
  }
  let stdout: Uint8Array;
  try {
    ({ stdout } = await execa(python, ['-B', '-u', toNamespacedPath(script)], {
      windowsHide: true,
      shell: false,
      timeout: 15000,
      maxBuffer: 128 * 1024,
      encoding: 'buffer',
      input: JSON.stringify(command),
      env: { PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    }));
  } catch {
    // Execa errors include stdin and output. Never expose those in diagnostics.
    throw new UpstreamServiceError('COMPUTE_CONTROL_FAILED', 503, '未能确认计算进程的启动或退出，请保留诊断信息');
  }
  return schema.parse(JSON.parse(Buffer.from(stdout).toString('utf8')));
}
