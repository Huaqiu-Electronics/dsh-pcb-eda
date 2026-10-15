import { afterEach, expect, it, vi } from 'vitest';
import { EditorLifecycle } from '../src/runs/editor-lifecycle.js';
import type { EditorState } from '../src/ipc/editor-process.js';

const watches: EditorLifecycle[] = [];
afterEach(async () => {
  for (const watch of watches.splice(0)) {
    await watch.dispose();
  }
  vi.useRealTimers();
});
function harness() {
  const state = new Map<string, EditorState>();
  const probe = vi.fn(async (instance: string) => state.get(instance) ?? 'alive');
  const onClosed = vi.fn(async (_runs: string[]) => {});
  const shutdown = vi.fn(async () => {});
  const onError = vi.fn();
  const watch = new EditorLifecycle({ probe, onClosed, shutdown, onError });
  watches.push(watch);
  return { state, probe, onClosed, shutdown, onError, watch };
}

it('cancels the closed editor task and stops Java even while a protected helper is settling', async () => {
  const h = harness();
  h.watch.bind('editor-A', 'run-A');
  h.state.set('editor-A', 'closed');
  let finish!: () => void;
  h.onClosed.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const checking = h.watch.check();
  await vi.waitFor(() => expect(h.shutdown).toHaveBeenCalledTimes(1));
  expect(h.onClosed).toHaveBeenCalledWith(['run-A']);
  finish();
  await checking;
  await h.watch.check();
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

it('keeps watching after completion and closes idle Java when that editor exits', async () => {
  const h = harness();
  h.watch.bind('editor-A', 'run-A');
  await h.watch.release('run-A');
  expect(h.shutdown).not.toHaveBeenCalled();
  h.state.set('editor-A', 'closed');
  await h.watch.check();
  expect(h.onClosed).toHaveBeenCalledWith([]);
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

it('does not stop another editor task using the shared engine and releases it after the final user finishes', async () => {
  const h = harness();
  h.watch.bind('editor-A', 'run-A');
  h.watch.bind('editor-B', 'run-B');
  h.state.set('editor-A', 'closed');
  await h.watch.check();
  expect(h.onClosed).toHaveBeenCalledWith(['run-A']);
  expect(h.shutdown).not.toHaveBeenCalled();
  await h.watch.release('run-B');
  expect(h.shutdown).toHaveBeenCalledTimes(1);
});

it('does not equate unavailable process information with editor exit and never overlaps slow probes', async () => {
  vi.useFakeTimers();
  const h = harness();
  let finish!: (state: EditorState) => void;
  h.probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.watch.bind('editor-A', 'run-A');
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.probe).toHaveBeenCalledTimes(1);
  finish('unknown');
  await h.watch.check();
  expect(h.onClosed).not.toHaveBeenCalled();
  expect(h.shutdown).not.toHaveBeenCalled();
});

it('retires watcher timers when the host disposes the plugin', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.watch.bind('editor-A', 'run-A');
  await h.watch.dispose();
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.probe).not.toHaveBeenCalled();
});

it('limits failed exit attempts and retains the engine for a future checked reuse', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.shutdown.mockRejectedValue(new Error('exit denied'));
  h.watch.bind('editor-A', 'run-A');
  h.state.set('editor-A', 'closed');
  await h.watch.check();
  await vi.advanceTimersByTimeAsync(20000);
  expect(h.shutdown).toHaveBeenCalledTimes(3);
  expect(h.onError).toHaveBeenCalled();
  expect(h.onError.mock.calls[0]?.[0]).toContain('保留引擎');
  h.watch.bind('editor-B', 'run-B');
  await vi.advanceTimersByTimeAsync(4000);
  expect(h.shutdown).toHaveBeenCalledTimes(3);
  h.shutdown.mockResolvedValue();
  h.state.set('editor-B', 'closed');
  await h.watch.check();
  expect(h.shutdown).toHaveBeenCalledTimes(4);
});
