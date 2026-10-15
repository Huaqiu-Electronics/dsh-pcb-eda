import { engineRouterSettings } from './fixtures/engine-router-settings.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Config, resolveConfig } from '../src/config.js';
import { FreeroutingClient } from '../src/proxy/freerouting-client.js';

// Native Promise timers are not patched by Vitest's virtual clock. Only the
// polling wait is replaced here; poll-wait.test.ts exercises real cancellation.
vi.mock('../src/proxy/poll-wait.js', () => ({
  waitForPoll: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([204, 409])(
  'waits for unavailable snapshots (HTTP %i) and returns subsequent preview and final bytes',
  async (unavailableStatus) => {
    vi.useFakeTimers();
    let started = false;
    let polls = 0;
    let outputReads = 0;
    const intermediate = Buffer.from('intermediate'.repeat(20)).toString('base64');
    const final = Buffer.from('final-result').toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/start')) {
          started = true;
        }
        if (path.endsWith('/output')) {
          outputReads++;
          if (outputReads === 1) {
            return new Response(unavailableStatus === 204 ? null : '{}', { status: unavailableStatus });
          }
          return new Response(JSON.stringify({ data: polls < 4 ? intermediate : final }));
        }
        if (path.endsWith('/settings')) {
          return new Response(JSON.stringify(engineRouterSettings()));
        }
        const data = path.endsWith('/sessions/list')
          ? ['session']
          : path.endsWith('/enqueue')
            ? { id: 'job' }
            : path.endsWith('/jobs/job')
              ? { state: started && ++polls >= 4 ? 'COMPLETED' : 'RUNNING', router_settings: engineRouterSettings() }
              : {};
        return new Response(JSON.stringify(data));
      }),
    );
    const client = new FreeroutingClient({
      baseUrl: 'http://localhost:37864',
      environmentHost: 'test/1',
      pollIntervalMs: 1000,
      pollTimeoutMs: 60000,
      profileEmail: 'test@example.com',
      profileId: 'test',
      requestTimeoutMs: 1000,
    });
    const seen: string[] = [];
    const result = client.route(
      'board.dsn',
      'ZHNu',
      { fast: false, realtime: false, routeOnlyNets: [], drawtimeSec: 1 },
      {
        onIntermediate: (snapshot) => {
          seen.push(snapshot);
        },
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([intermediate]);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).sesBase64).toBe(final);
    expect(seen).toEqual([intermediate, intermediate]);
    expect(outputReads).toBe(4);
  },
);

it('defaults both configuration paths to a thirty minute wait and keeps explicit overrides', () => {
  expect(resolveConfig().pollTimeoutMs).toBe(1_800_000);
  expect(Config({}).pollTimeoutMs).toBe(1_800_000);
  expect(resolveConfig({ pollTimeoutMs: 60_000 }).pollTimeoutMs).toBe(60_000);
});

it('applies the engine deadline after input upload and before starting the job', async () => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push({ method: init.method!, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith('/settings')) {
        return new Response(
          JSON.stringify({
            ...engineRouterSettings(7),
            automatic_neckdown: false,
            scoring: { default_undesired_direction_trace_cost: 1.1 },
          }),
        );
      }
      const data = path.endsWith('/sessions/list')
        ? ['session']
        : path.endsWith('/enqueue')
          ? { id: 'job' }
          : path.endsWith('/output')
            ? { data: 'c2Vz' }
            : path.endsWith('/jobs/job')
              ? {
                  state: 'COMPLETED',
                  router_settings: {
                    ...engineRouterSettings(7),
                    automatic_neckdown: false,
                    scoring: { default_undesired_direction_trace_cost: 1.1 },
                  },
                }
              : {};
      return new Response(JSON.stringify(data));
    }),
  );
  const client = new FreeroutingClient({
    baseUrl: 'http://localhost:37864',
    environmentHost: 'test/1',
    pollIntervalMs: 250,
    pollTimeoutMs: 1_800_000,
    profileEmail: 'test@example.com',
    profileId: 'test',
    requestTimeoutMs: 1_000,
  });
  await client.route('board.dsn', 'ZHNu', { fast: false, realtime: false, routeOnlyNets: [], drawtimeSec: 5 }, {});
  const input = requests.findIndex((request) => request.path.endsWith('/input'));
  const settings = requests.findIndex((request) => request.method === 'POST' && request.path.endsWith('/settings'));
  const start = requests.findIndex((request) => request.path.endsWith('/start'));
  expect(settings).toBeGreaterThan(input);
  expect(start).toBeGreaterThan(settings);
  expect(requests[settings]?.body).toMatchObject({
    job_timeout: '00:30:00',
    autorouter: { algorithm: 'freerouting-router', max_passes: 7 },
    automatic_neckdown: false,
    scoring: { default_undesired_direction_trace_cost: 1.1 },
  });
});

it('keeps waiting after fifteen minutes and cancels at the thirty-minute limit without reading output', async () => {
  vi.useFakeTimers();
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path.endsWith('/settings')) {
        return new Response(JSON.stringify(engineRouterSettings()));
      }
      const data = path.endsWith('/sessions/list')
        ? ['session']
        : path.endsWith('/enqueue')
          ? { id: 'job' }
          : path.endsWith('/jobs/job')
            ? { state: 'RUNNING', router_settings: engineRouterSettings() }
            : {};
      return new Response(JSON.stringify(data));
    }),
  );
  const client = new FreeroutingClient({
    baseUrl: 'http://localhost:37864',
    environmentHost: 'test/1',
    pollIntervalMs: 60_000,
    pollTimeoutMs: 1_800_000,
    profileEmail: 'test@example.com',
    profileId: 'test',
    requestTimeoutMs: 1_000,
  });
  const outcome = expect(
    client.route('board.dsn', 'ZHNu', { fast: false, realtime: false, routeOnlyNets: [], drawtimeSec: 5 }, {}),
  ).rejects.toMatchObject({ code: 'FREEROUTING_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(900_000);
  expect(requests.some((path) => path.endsWith('/cancel'))).toBe(false);
  await vi.advanceTimersByTimeAsync(900_000);
  await outcome;
  expect(requests.some((path) => path.endsWith('/cancel'))).toBe(true);
  expect(requests.some((path) => path.endsWith('/output'))).toBe(false);
});

it('cancels the engine when a native intermediate update fails', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path.endsWith('/settings')) {
        return new Response(JSON.stringify(engineRouterSettings()));
      }
      const data = path.endsWith('/sessions/list')
        ? ['session']
        : path.endsWith('/enqueue')
          ? { id: 'job' }
          : path.endsWith('/output')
            ? { data: Buffer.from('preview-session'.repeat(20)).toString('base64') }
            : path.endsWith('/jobs/job')
              ? { state: 'RUNNING', router_settings: engineRouterSettings() }
              : {};
      return new Response(JSON.stringify(data));
    }),
  );
  const client = new FreeroutingClient({
    baseUrl: 'http://localhost:37864',
    environmentHost: 'test/1',
    pollIntervalMs: 250,
    pollTimeoutMs: 60000,
    profileEmail: 'test@example.com',
    profileId: 'test',
    requestTimeoutMs: 1000,
  });
  const failure = new Error('native preview rejected');
  await expect(
    client.route(
      'board.dsn',
      'ZHNu',
      { fast: false, realtime: true, routeOnlyNets: [], drawtimeSec: 1 },
      {
        onIntermediate: async () => {
          throw failure;
        },
      },
    ),
  ).rejects.toBe(failure);
  expect(requests).toContain('/v1/jobs/job/cancel');
});

it('refuses an unsupported restricted scope before creating a routing job', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path.endsWith('/settings')) {
        return new Response(JSON.stringify(engineRouterSettings()));
      }
      const data = path.endsWith('/sessions/list')
        ? ['session']
        : path.endsWith('/enqueue')
          ? { id: 'job' }
          : path.endsWith('/jobs/job')
            ? { state: 'READY_TO_START', router_settings: engineRouterSettings() }
            : {};
      return new Response(JSON.stringify(data));
    }),
  );
  const client = new FreeroutingClient({
    baseUrl: 'http://localhost:37864',
    environmentHost: 'test/1',
    pollIntervalMs: 250,
    pollTimeoutMs: 60000,
    profileEmail: 'test@example.com',
    profileId: 'test',
    requestTimeoutMs: 1000,
  });
  await expect(
    client.route(
      'board.dsn',
      'ZHNu',
      { fast: false, realtime: true, routeOnlyNets: ['GND'], drawtimeSec: 1, requireNetFilter: true },
      {},
    ),
  ).rejects.toMatchObject({ code: 'NET_FILTER_UNSUPPORTED' });
  expect(requests.some((path) => path.endsWith('/start'))).toBe(false);
  expect(requests.some((path) => path.endsWith('/enqueue'))).toBe(false);
  expect(requests.some((path) => path.endsWith('/settings'))).toBe(false);
});

it('rejects unbounded or non-positive polling configuration before creating a job', () => {
  const valid = {
    baseUrl: 'http://localhost:37864',
    environmentHost: 'test',
    pollIntervalMs: 250,
    pollTimeoutMs: 1_800_000,
    profileEmail: 'test@example.com',
    profileId: 'test',
    requestTimeoutMs: 1000,
  };
  for (const options of [
    { ...valid, pollTimeoutMs: Infinity },
    { ...valid, pollTimeoutMs: NaN },
    { ...valid, pollTimeoutMs: 0 },
    { ...valid, pollIntervalMs: 0 },
    { ...valid, pollIntervalMs: -1 },
  ]) {
    expect(() => new FreeroutingClient(options)).toThrow(
      expect.objectContaining({ code: 'FREEROUTING_CONFIG_INVALID' }),
    );
  }
});

it('rejects malformed intermediate output and cancels the engine instead of hiding a protocol mismatch', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (path.endsWith('/settings')) {
        return new Response(JSON.stringify(engineRouterSettings()));
      }
      const data = path.endsWith('/sessions/list')
        ? ['session']
        : path.endsWith('/enqueue')
          ? { id: 'job' }
          : path.endsWith('/output')
            ? { ses: Buffer.from('preview'.repeat(40)).toString('base64') }
            : path.endsWith('/jobs/job')
              ? { state: 'RUNNING', router_settings: engineRouterSettings() }
              : {};
      return new Response(JSON.stringify(data));
    }),
  );
  const client = new FreeroutingClient({
    baseUrl: 'http://localhost:37864',
    environmentHost: 'test',
    pollIntervalMs: 250,
    pollTimeoutMs: 10000,
    profileEmail: 'test@example.com',
    profileId: 'test',
    requestTimeoutMs: 1000,
  });
  await expect(
    client.route(
      'board.dsn',
      'ZHNu',
      { fast: false, realtime: true, routeOnlyNets: [], drawtimeSec: 1 },
      { onIntermediate: vi.fn() },
    ),
  ).rejects.toMatchObject({ code: 'FREEROUTING_PROTOCOL_FAILED' });
  expect(requests.some((path) => path.endsWith('/cancel'))).toBe(true);
});
