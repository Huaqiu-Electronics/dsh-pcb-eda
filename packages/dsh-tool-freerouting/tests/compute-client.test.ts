import { execa } from 'execa';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { computeCommand } from '../src/runs/compute-client.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execute }));
beforeEach(() => vi.clearAllMocks());
const schema = z.object({ state: z.literal('closed') });

it('passes JSON through stdin with bounded execution and validates the reply', async () => {
  execute.mockResolvedValue({ stdout: Buffer.from('{"state":"closed"}') });
  const command = { command: 'state', record: { job: '测试 job' } };
  await expect(computeCommand('C:/KiCad 10/bin/python.exe', command, schema)).resolves.toEqual({ state: 'closed' });
  expect(execa).toHaveBeenCalledWith(
    'C:/KiCad 10/bin/python.exe',
    ['-B', '-u', expect.stringContaining('compute_host.py')],
    expect.objectContaining({
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 128 * 1024,
      encoding: 'buffer',
      input: JSON.stringify(command),
      shell: false,
    }),
  );
});

it('does not expose subprocess input or output when process control fails', async () => {
  execute.mockRejectedValue(new Error('stdin token=private-value; output=private-value'));
  const outcome = computeCommand('python.exe', { token: 'private-value' }, schema);
  await expect(outcome).rejects.toMatchObject({ code: 'COMPUTE_CONTROL_FAILED', status: 503 });
  await expect(outcome).rejects.not.toThrow('private-value');
});

it('rejects a successful process reply that does not satisfy its schema', async () => {
  execute.mockResolvedValue({ stdout: Buffer.from('{"state":"alive"}') });
  await expect(computeCommand('python.exe', {}, schema)).rejects.toBeInstanceOf(z.ZodError);
});
