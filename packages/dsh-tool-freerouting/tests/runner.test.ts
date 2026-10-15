import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { hasPendingHelpers, waitForHelpers } from '../src/ipc/helper-processes.js';
import { runHelper } from '../src/ipc/runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
let child: EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
});
afterEach(async () => {
  child.emit('close', 0);
  await waitForHelpers('runner-test');
  vi.useRealTimers();
});
const options = { pythonPath: 'test', socket: 'test', timeoutMs: 1000 };

it('launches the helper using an extended Windows path for native vendor imports', async () => {
  const promise = runHelper(options, 'discover', {}, z.object({ done: z.boolean() }));
  const args = vi.mocked(spawn).mock.calls.at(-1)?.[1];
  if (process.platform === 'win32') {
    expect(args?.[1]).toMatch(/^\\\\\?\\/);
  }
  child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, data: { done: true } })));
  child.emit('close', 0);
  await expect(promise).resolves.toEqual({ done: true });
});

it('reports a watchdog timeout without killing a mutating helper and waits for its actual exit', async () => {
  const promise = runHelper(
    options,
    'import',
    { clientName: 'runner-test' },
    z.object({ done: z.boolean() }),
    undefined,
    true,
  );
  const result = expect(promise).rejects.toMatchObject({ code: 'IMPORT_UNCERTAIN' });
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(child.kill).not.toHaveBeenCalled();
  expect(hasPendingHelpers('runner-test')).toBe(true);
  child.emit('close', 0);
  await waitForHelpers('runner-test');
  expect(hasPendingHelpers('runner-test')).toBe(false);
});

it('kills a cancelled read-only helper but retains its lifecycle until the process closes', async () => {
  const controller = new AbortController();
  const promise = runHelper(
    options,
    'export',
    { clientName: 'runner-test' },
    z.object({ done: z.boolean() }),
    controller.signal,
  );
  const result = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  await result;
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(hasPendingHelpers('runner-test')).toBe(true);
});

it('distinguishes a verified rollback from a lost process response', async () => {
  const promise = runHelper(
    options,
    'import',
    { clientName: 'runner-test' },
    z.object({ done: z.boolean() }),
    undefined,
    true,
  );
  child.stdout.emit(
    'data',
    Buffer.from(JSON.stringify({ ok: false, code: 'CREATE_FAILED', error: 'rolled back', outcome: 'rolled_back' })),
  );
  child.emit('close', 0);
  await expect(promise).rejects.toMatchObject({ code: 'CREATE_FAILED' });
});
