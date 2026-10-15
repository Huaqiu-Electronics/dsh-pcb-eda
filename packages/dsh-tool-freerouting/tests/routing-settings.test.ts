import { expect, it } from 'vitest';
import { configureRoutingSettings } from '../src/proxy/routing-settings.js';
import { engineRouterSettings } from './fixtures/engine-router-settings.js';

it('uses the supported optimizer switch for fast mode and preserves all input-derived rules', () => {
  const input = {
    ...engineRouterSettings(7),
    scoring: { default_undesired_direction_trace_cost: 1.1 },
    optimizer: { enabled: true, max_threads: 2 },
  };
  expect(configureRoutingSettings(input, 1_800_000, true)).toEqual({
    ...input,
    job_timeout: '00:30:00',
    optimizer: { enabled: false, max_threads: 2 },
  });
  expect(input.optimizer.enabled).toBe(true);
  expect(configureRoutingSettings(input, 60_000, false).optimizer.enabled).toBe(true);
});

it.each([
  {},
  { algorithm: 'freerouting-router/fast', max_passes: 100 },
  { ...engineRouterSettings(), optimizer: null },
])('rejects missing or legacy settings before the job is started: %j', (settings) => {
  expect(() => configureRoutingSettings(settings, 60_000, true)).toThrow(
    expect.objectContaining({ code: 'FREEROUTING_PROTOCOL_FAILED' }),
  );
});

it('attempts one routing pass when a KiCad DSN specifies zero, without resetting other settings', () => {
  const configured = configureRoutingSettings(
    {
      autorouter: { algorithm: 'freerouting-router', max_passes: 0, ignore_net_classes: [] },
      optimizer: { enabled: true },
      copper_to_edge_clearance_um: 250,
    },
    1_800_000,
    false,
  );
  expect(configured.autorouter).toMatchObject({ max_passes: 1, ignore_net_classes: [] });
  expect(configured).toMatchObject({ copper_to_edge_clearance_um: 250, job_timeout: '00:30:00' });
});
