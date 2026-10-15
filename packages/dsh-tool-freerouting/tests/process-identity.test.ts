import { afterEach, expect, it, vi } from 'vitest';
import { hostBirth, inspectProcesses } from '../src/ipc/process-identity.js';
import { editorProcessState } from '../src/ipc/editor-process.js';
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../src/runs/compute-client.js', () => ({ computeCommand: command }));
afterEach(() => vi.clearAllMocks());

it('shares an in-flight host identity, while rechecking external processes', async () => {
  let finish!: (value: unknown) => void;
  command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = hostBirth('cache-test-python');
  const second = hostBirth('cache-test-python');
  expect(first).toBe(second);
  expect(command).toHaveBeenCalledOnce();
  finish({ processes: [{ pid: process.pid, state: 'alive', birth: '123' }] });
  expect(await first).toBe('123');
  await hostBirth('cache-test-python');
  expect(command).toHaveBeenCalledOnce();
  command.mockResolvedValue({ processes: [{ pid: 456, state: 'alive', birth: '789' }] });
  await inspectProcesses('cache-test-python', [{ pid: 456 }]);
  await inspectProcesses('cache-test-python', [{ pid: 456 }]);
  expect(command).toHaveBeenCalledTimes(3);
});

it('does not cache failed host queries or accept mismatched process responses', async () => {
  command.mockRejectedValueOnce(new Error('denied'));
  await expect(hostBirth('retry-test-python')).rejects.toThrow('denied');
  command.mockResolvedValueOnce({ processes: [{ pid: process.pid, state: 'alive', birth: '123' }] });
  expect(await hostBirth('retry-test-python')).toBe('123');
  command.mockResolvedValueOnce({ processes: [{ pid: 999, state: 'alive', birth: '123' }] });
  await expect(inspectProcesses('python', [{ pid: 456 }])).rejects.toThrow('不匹配');
});

it('uses the fixed runtime for editor probes and fails conservatively', async () => {
  command.mockResolvedValueOnce({ processes: [{ pid: 456, state: 'closed', birth: '123' }] });
  expect(await editorProcessState('456:0:7b', 'selected-python')).toBe('closed');
  expect(command).toHaveBeenCalledWith(
    'selected-python',
    { command: 'process-identities', processes: [{ pid: 456, birth: '123' }] },
    expect.anything(),
  );
  command.mockRejectedValueOnce(new Error('denied'));
  expect(await editorProcessState('456:0:7b', 'selected-python')).toBe('unknown');
  expect(await editorProcessState('malformed', 'selected-python')).toBe('unknown');
});
