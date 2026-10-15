import { afterEach, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { RunStore } from '../src/runs/run-store.js';
import { ProcessRecorder } from '../src/runs/process-recorder.js';
import { statusResponse } from '../src/runs/contracts.js';

const stores: RunStore[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.dispose();
  }
});
function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  const store = new RunStore({ maxPendingRuns: 4, resultTtlMs: 3600000 });
  stores.push(store);
  const run = store.create(
    'route',
    { fast: true, realtime: true, fillZonesAfterRoute: false, drawtimeSec: 5, skipNets: [], routeOnlyNets: [] },
    { id: 'owner' } as Agent,
  );
  const recorder = new ProcessRecorder(run, store, vi.fn());
  return { store, run, recorder };
}

it('distinguishes engine heartbeat from real progress and throttles snapshots without inventing counts', () => {
  const { run, recorder } = harness();
  recorder.progress({ state: 'RUNNING', ticks: 1 });
  const changed = run.activity!.updatedAt;
  vi.advanceTimersByTime(60000);
  recorder.progress({ state: 'RUNNING', ticks: 2 });
  expect(run.activity!.updatedAt).toBe(changed);
  expect(run.activity!.engineUpdatedAt).toBe(Date.now());
  expect(run.progress?.percentage).toBeUndefined();
  expect(run.activity!.remainingConnections).toBeUndefined();
  recorder.progress({ state: 'RUNNING', ticks: 3, percentage: 20, statistics: { connections: { remaining: 8 } } });
  const snapshots = run.activity!.events.length;
  vi.advanceTimersByTime(5000);
  recorder.progress({ state: 'RUNNING', ticks: 4, percentage: 21 });
  expect(run.activity!.events).toHaveLength(snapshots);
  vi.advanceTimersByTime(10000);
  recorder.progress({ state: 'RUNNING', ticks: 5, percentage: 22 });
  expect(run.activity!.events.length).toBe(snapshots + 1);
  expect(run.activity!.events.map((e) => e.text).join()).not.toContain('已全部接通');
});

it('preserves first-round history, clears preview counts and removes computing percentage at rule checks', () => {
  const { run, store, recorder } = harness();
  recorder.progress({ state: 'RUNNING', ticks: 1, percentage: 99 });
  recorder.preview({ tracks: 7, vias: 2 });
  recorder.preview();
  recorder.stage('正在检查新增走线');
  expect(run.activity!.preview).toBeUndefined();
  expect(run.progress?.percentage).toBeUndefined();
  const previous = run.activity!.events.map((e) => e.text);
  const next = new ProcessRecorder(run, store, vi.fn());
  next.round(2);
  next.stage('正在重新布线一次');
  expect(run.activity!.events.map((e) => e.text)).toEqual([...previous, '正在重新布线一次']);
  const response = statusResponse(run);
  expect(response.process?.round).toBe(2);
  expect(response.process?.events[0]?.at).toBe('2026-10-12T00:00:00.000Z');
  response.process!.events[0]!.text = 'tampered';
  expect(run.activity!.events[0]!.text).not.toBe('tampered');
});

it('bounds progress history while preserving check and repair milestones', () => {
  const { run, recorder } = harness();
  recorder.note('第一轮检查：离板边过近');
  for (let i = 0; i < 100; i++) {
    vi.advanceTimersByTime(15000);
    recorder.progress({ state: 'RUNNING', ticks: i, statistics: { connections: { remaining: 100 - i } } });
  }
  expect(run.activity!.events).toHaveLength(64);
  expect(run.activity!.events[0]?.text).toBe('第一轮检查：离板边过近');
  recorder.note('第二轮仍有问题，保留结果并提示');
  expect(run.activity!.events).toHaveLength(64);
  expect(run.activity!.events.at(-1)?.text).toContain('第二轮仍有问题');
});
