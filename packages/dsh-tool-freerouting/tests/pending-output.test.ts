import { afterEach, expect, it, vi } from 'vitest';
import { EngineHttp } from '../src/proxy/engine-http.js';
import { JobPoller } from '../src/proxy/job-poller.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  { state: 'RUNNING', outputStatus: 200 },
  { state: 'COMPLETED', outputStatus: 204 },
])('rejects invalid output for $state (HTTP $outputStatus)', async ({ state, outputStatus }) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (new URL(url).pathname.endsWith('/output')) {
        return new Response(outputStatus === 204 ? null : '{}', { status: outputStatus });
      }
      return new Response(JSON.stringify({ state }));
    }),
  );
  const options = {
    baseUrl: 'http://127.0.0.1:37864',
    environmentHost: 'test/1',
    pollIntervalMs: 250,
    pollTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    profileEmail: 'test@example.com',
    profileId: 'test',
  };
  const intermediate = vi.fn();
  const poller = new JobPoller(new EngineHttp(options), options, vi.fn());
  await expect(
    poller.poll(
      'job',
      { fast: true, realtime: true, drawtimeSec: 1, routeOnlyNets: [] },
      { onIntermediate: intermediate },
    ),
  ).rejects.toMatchObject({ code: 'FREEROUTING_PROTOCOL_FAILED' });
  expect(intermediate).not.toHaveBeenCalled();
});
