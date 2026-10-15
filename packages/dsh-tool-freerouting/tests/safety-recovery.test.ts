import { engineRouterSettings } from './fixtures/engine-router-settings.js';
import { afterEach, expect, it, vi } from 'vitest';
import { FreeroutingClient } from '../src/proxy/freerouting-client.js';
import { resourceViolation, resourceLimits } from '../src/runs/resource-guard.js';
import { boundedResponse } from '../src/proxy/bounded-response.js';
import { RunStore } from '../src/runs/run-store.js';
import { resolveConfig } from '../src/config.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RunArtifact } from '../src/runs/contracts.js';

afterEach(() => vi.unstubAllGlobals());
const params = { fast: true, realtime: false, drawtimeSec: 1, routeOnlyNets: [] };
const client = () =>
  new FreeroutingClient({
    baseUrl: 'http://127.0.0.1:37864',
    environmentHost: 'test',
    pollIntervalMs: 250,
    pollTimeoutMs: 30000,
    requestTimeoutMs: 1000,
    profileId: 'test',
    profileEmail: 'test@example.com',
  });

it('obtains a valid session after engine restart and routes again without reloading the plugin', async () => {
  let generation = 1;
  const enqueued: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/enqueue')) {
        enqueued.push(JSON.parse(String(init.body)).session_id);
      }
      if (path.endsWith('/settings')) {
        return new Response(JSON.stringify(engineRouterSettings()));
      }
      const data = path.endsWith('/sessions/list')
        ? [`session-${generation}`]
        : path.endsWith('/enqueue')
          ? { id: 'job' }
          : path.endsWith('/jobs/job')
            ? { state: 'COMPLETED', router_settings: engineRouterSettings() }
            : path.endsWith('/output')
              ? { data: 'c2Vz' }
              : {};
      return new Response(JSON.stringify(data));
    }),
  );
  const router = client();
  await router.route('board.dsn', 'ZHNu', params, {});
  generation++;
  await router.route('board.dsn', 'ZHNu', params, {});
  expect(enqueued).toEqual(['session-1', 'session-2']);
});

it('refuses engine reuse until the cancelled old job is confirmed stopped', async () => {
  let terminal = false,
    enqueueCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/enqueue')) {
        enqueueCount++;
      }
      if (path.endsWith('/settings')) {
        return new Response(JSON.stringify(engineRouterSettings()));
      }
      const data = path.endsWith('/sessions/list')
        ? ['session']
        : path.endsWith('/enqueue')
          ? { id: 'job' }
          : path.endsWith('/jobs/job')
            ? { state: terminal ? 'COMPLETED' : 'RUNNING', router_settings: engineRouterSettings() }
            : path.endsWith('/output')
              ? { data: 'c2Vz' }
              : {};
      return new Response(JSON.stringify(data));
    }),
  );
  const router = client();
  const stopped = new AbortController();
  await expect(
    router.route('board.dsn', 'ZHNu', params, { onProgress: () => stopped.abort() }, stopped.signal),
  ).rejects.toBeDefined();
  await expect(router.route('board.dsn', 'ZHNu', params, {})).rejects.toMatchObject({
    code: 'ENGINE_TASK_UNCONFIRMED',
  });
  expect(enqueueCount).toBe(1);
  terminal = true;
  await router.route('board.dsn', 'ZHNu', params, {});
  expect(enqueueCount).toBe(2);
});

it('cancels an oversized response stream before materializing the entire body', async () => {
  const cancelled = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel: cancelled,
    }),
  );
  await expect(boundedResponse(response, 8)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  expect(cancelled).toHaveBeenCalledOnce();
});

it('reserves cleanup memory and responds to actual private-memory limits', () => {
  const normal = { available: 4e9, commitAvailable: 4e9, total: 8e9, processes: [] };
  expect(resourceViolation(normal)).toBeUndefined();
  expect(resourceViolation({ ...normal, available: resourceLimits.cleanupReserveBytes - 1 })).toContain('清理');
  expect(
    resourceViolation({
      ...normal,
      processes: [{ pid: 1, private: resourceLimits.processPrivateBytes + 1, working: 1 }],
    }),
  ).toContain('上限');
});

it('rejects a second board request with its existing task identifier; config cannot enable parallel routing', () => {
  expect(resolveConfig({ maxPendingRuns: 4 }).maxPendingRuns).toBe(1);
  const store = new RunStore({ maxPendingRuns: 1, resultTtlMs: 60000 });
  const parameters = { ...params, skipNets: [], fillZonesAfterRoute: false };
  try {
    const first = store.create('route', parameters, { id: 'owner' } as Agent);
    expect(() => store.create('route', parameters, { id: 'owner' } as Agent)).toThrow(first.id);
  } finally {
    store.dispose();
  }
});

it('checks untracked engine jobs before adopting a retained service', async () => {
  let state = 'RUNNING';
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(new URL(url).pathname.endsWith('/sessions/list') ? ['old-session'] : [{ state }])),
    ),
  );
  const router = client();
  await expect(router.verifyEngineIdle()).rejects.toMatchObject({ code: 'ENGINE_TASK_UNCONFIRMED' });
  state = 'COMPLETED';
  await expect(router.verifyEngineIdle()).resolves.toBeUndefined();
});

it('refuses excessive retained data without deleting the previous downloadable result', () => {
  const originalLimit = resourceLimits.retainedBytes;
  const store = new RunStore({ maxPendingRuns: 4, resultTtlMs: 60000 });
  const parameters = { ...params, skipNets: [], fillZonesAfterRoute: false };
  try {
    resourceLimits.retainedBytes = 16;
    const first = store.create('route', parameters, { id: 'owner' } as Agent);
    const artifact: RunArtifact = {
      content: Buffer.alloc(8),
      contentType: 'text/plain; charset=utf-8',
      filename: 'board.ses',
    };
    store.retain(first.id, artifact);
    const second = store.create('route', parameters, { id: 'owner' } as Agent);
    expect(() => store.retain(second.id, { ...artifact, content: Buffer.alloc(9) })).toThrow('容量');
    expect(store.require(first.id).artifact).toBe(artifact);
    expect(store.require(second.id).artifact).toBeUndefined();
  } finally {
    resourceLimits.retainedBytes = originalLimit;
    store.dispose();
  }
});
