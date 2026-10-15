import { afterEach, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { KicadIpcClient } from '../src/ipc/client.js';
import type { FreeroutingClient } from '../src/proxy/freerouting-client.js';
import type { RouteHandlers } from '../src/proxy/routing-contracts.js';
import { RunStore } from '../src/runs/run-store.js';
import { RunService } from '../src/runs/run-service.js';
import { createRunHttpApp } from '../src/http/app.js';
import { createPreviewReader } from '../src/runs/preview.js';
import { previewDsn, previewSes } from './preview-fixture.js';

const stores: RunStore[] = [];
const services: RunService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.dispose();
  }
  for (const store of stores.splice(0)) {
    store.dispose();
  }
});
const parameters = {
  fast: false,
  realtime: false,
  fillZonesAfterRoute: false,
  drawtimeSec: 5,
  skipNets: [],
  routeOnlyNets: [],
};
import type { DesignReport } from '../src/runs/design-report.js';

const cleanReport: DesignReport = { count: 0, violations: [], truncated: false };
function harness() {
  const runs = new RunStore({ maxPendingRuns: 4, resultTtlMs: 3600000 });
  stores.push(runs);
  let done!: Promise<JobOutcome>;
  const ctx = {
    logger: { info: vi.fn() },
    jobs: {
      start: (job: { run: () => { done: Promise<JobOutcome> } }) => {
        done = job.run().done;
        return 'preview-job';
      },
    },
  } as unknown as Context;
  const bound = {
    target: { boardPath: 'E:/preview.kicad_pcb' },
    importStarted: false,
    exportDsn: vi.fn(async () => Buffer.from(previewDsn)),
    repairDsn: vi.fn(async (..._args: unknown[]) => Buffer.from(previewDsn)),
    reviewSession: vi.fn(async () => cleanReport),
    designReportArtifact: vi.fn(async () => Buffer.from('{}')),
    importSession: vi.fn(async (..._args: unknown[]) => ({
      outcome: 'committed',
      tracks: 2,
      vias: 1,
      designReport: cleanReport,
    })),
    previewSession: vi.fn(async () => ({ outcome: 'committed', tracks: 2, vias: 1 })),
    clearPreview: vi.fn(async () => {}),
    fillZones: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const freerouting = {
    route: vi.fn(async (..._args: unknown[]) => ({
      sesBase64: Buffer.from(previewSes).toString('base64'),
      state: 'COMPLETED',
    })),
  };
  const service = new RunService(
    ctx,
    runs,
    freerouting as unknown as FreeroutingClient,
    { open: async () => bound } as unknown as KicadIpcClient,
  );
  services.push(service);
  const run = runs.create('route', parameters, { id: 'preview-owner' } as Agent);
  return { runs, run, service, bound, freerouting, done: () => done };
}

it('publishes intermediate paths while the editor remains untouched, then imports only the final session', async () => {
  const h = harness();
  const app = createRunHttpApp(h.runs, '/pcb');
  const url = `/pcb/api/runs/${h.run.id}`;
  const auth = { headers: { authorization: `Bearer ${h.run.token}` } };
  let snapshots = 0;
  h.freerouting.route.mockImplementation(async (...args: unknown[]) => {
    const handlers = args[3] as RouteHandlers;
    await handlers.onIntermediate?.(Buffer.from(previewSes).toString('base64'));
    snapshots++;
    expect(h.bound.importSession).not.toHaveBeenCalled();
    expect(h.bound.reviewSession).not.toHaveBeenCalled();
    const status = await (await app.request(url + '/status', auth)).json();
    expect(status.preview).toMatchObject({ state: 'ready', round: 1, final: false });
    expect(status.preview.scene).toBeUndefined();
    expect((await app.request(url + '/preview')).status).toBe(401);
    expect((await app.request(url + '/preview', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(
      (await app.request(url + '/preview', { headers: { ...auth.headers, 'sec-fetch-site': 'cross-site' } })).status,
    ).toBe(403);
    const response = await app.request(url + '/preview', auth);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await response.json();
    expect(payload.scene.paths[0].points).toEqual([
      [1, 11],
      [19, 29],
    ]);
    expect(JSON.stringify(payload)).not.toContain(h.run.token);
    const revision = h.run.preview?.meta.revision;
    await handlers.onIntermediate?.(Buffer.from(previewSes).toString('base64'));
    // Unchanged output is not republished.
    expect(h.run.preview?.meta.revision).toBe(revision);
    await handlers.onIntermediate?.(Buffer.from(previewSes.slice(0, -1)).toString('base64'));
    expect((await app.request(url + '/preview', auth)).status).toBe(409);
    return { sesBase64: Buffer.from(previewSes).toString('base64'), state: 'COMPLETED' };
  });
  await h.service.start(h.run);
  await h.done();
  expect(snapshots).toBe(1);
  expect(h.run.state).toBe('succeeded');
  expect(h.run.preview?.meta.imported).toBe(true);
  expect(h.run.preview?.meta).toMatchObject({ state: 'ready', round: 1, final: true });
  expect(h.bound.importSession).toHaveBeenCalledTimes(1);
  expect(h.bound.importSession.mock.calls[0]?.[0]).toEqual(Buffer.from(previewSes));
  h.runs.cleanup(h.run.expiresAt + 1);
  expect((await app.request(url + '/preview', auth)).status).toBe(401);
});

it('clears the first round immediately and keeps final review failures independent from preview success', async () => {
  const h = harness();
  const report = {
    count: 1,
    truncated: false,
    violations: [
      {
        type: 'clearance',
        severity: 'error',
        description: 'too close',
        items: [{ uuid: 'new', description: 'track', x: 1, y: 2 }],
      },
    ],
  };
  h.bound.reviewSession.mockResolvedValueOnce(report);
  await h.service.start(h.run);
  await h.done();
  expect(h.run.state).toBe('repair_pending');
  expect(h.run.preview?.scene).toEqual(createPreviewReader(previewDsn)(previewSes));
  expect(h.bound.importSession).not.toHaveBeenCalled();
  h.bound.repairDsn.mockImplementation(async () => {
    expect(h.run.preview).toMatchObject({ meta: { round: 2, state: 'waiting' } });
    expect(h.run.preview?.scene).toBeUndefined();
    throw new Error('board changed');
  });
  await h.service.repair(h.run);
  await h.done();
  expect(h.run.state).toBe('failed');
  expect(h.bound.importSession).not.toHaveBeenCalled();
});

it('updates the native editor and clears intermediate copper before final review/import', async () => {
  const h = harness();
  h.run.parameters.realtime = true;
  const events: string[] = [];
  h.bound.previewSession.mockImplementation(async () => {
    events.push('preview');
    return { outcome: 'committed', tracks: 2, vias: 1 };
  });
  h.bound.clearPreview.mockImplementation(async () => {
    events.push('clear');
  });
  h.bound.reviewSession.mockImplementation(async () => {
    events.push('review');
    return cleanReport;
  });
  h.bound.importSession.mockImplementation(async () => {
    events.push('import');
    return { outcome: 'committed', tracks: 2, vias: 1, designReport: cleanReport };
  });
  h.freerouting.route.mockImplementation(async (...args: unknown[]) => {
    await (args[3] as RouteHandlers).onIntermediate?.(Buffer.from(previewSes).toString('base64'));
    expect(h.bound.importSession).not.toHaveBeenCalled();
    return { sesBase64: Buffer.from(previewSes).toString('base64'), state: 'COMPLETED' };
  });
  await h.service.start(h.run);
  await h.done();
  expect(h.run.state).toBe('succeeded');
  expect(events).toEqual(['preview', 'clear', 'review', 'import']);
});

it('publishes actual preview, rule check and repair actions across both rounds through the status endpoint', async () => {
  const h = harness();
  h.run.parameters.realtime = true;
  const app = createRunHttpApp(h.runs, '/pcb');
  const url = `/pcb/api/runs/${h.run.id}/status`;
  const auth = { headers: { authorization: `Bearer ${h.run.token}` } };
  const report = {
    count: 1,
    truncated: false,
    violations: [
      {
        type: 'copper_edge_clearance',
        severity: 'error',
        description: 'too close',
        items: [{ uuid: 'new', description: 'GND', x: 1, y: 2 }],
      },
    ],
  };
  h.freerouting.route.mockImplementation(async (...args: unknown[]) => {
    const handlers = args[3] as RouteHandlers;
    handlers.onProgress?.({ state: 'RUNNING', ticks: 1, percentage: 98 });
    await handlers.onIntermediate?.(Buffer.from(previewSes).toString('base64'));
    const status = await (await app.request(url, auth)).json();
    expect(status.process.preview).toEqual({ tracks: 2, vias: 1 });
    expect(status.process.events.some((event: { text: string }) => event.text.includes('尚未完成最终检查'))).toBe(true);
    return { sesBase64: Buffer.from(previewSes).toString('base64'), state: 'COMPLETED' };
  });
  h.bound.reviewSession.mockImplementation(async () => {
    const status = await (await app.request(url, auth)).json();
    expect(status.process.preview).toBeUndefined();
    expect(status.progress.state).toContain('正在检查新增走线');
    expect(status.progress.percentage).toBeUndefined();
    expect(h.bound.importSession).not.toHaveBeenCalled();
    return report;
  });
  await h.service.start(h.run);
  await h.done();
  expect(h.run.state).toBe('repair_pending');
  expect(h.run.activity?.events.some((e) => e.text.includes('离板边太近'))).toBe(true);
  const firstRound = h.run.activity!.events.map((e) => e.text);
  h.bound.repairDsn.mockImplementation(async (...args: unknown[]) => {
    (args[2] as (message: string) => void)('没有可补充的铜文字避让范围，将沿用原有约束重新尝试一次；未切换算法');
    return Buffer.from(previewDsn);
  });
  h.bound.importSession.mockResolvedValue({ outcome: 'committed', tracks: 2, vias: 1, designReport: report });
  await h.service.repair(h.run);
  await h.done();
  expect(h.run.state).toBe('partial');
  expect(h.run.activity?.round).toBe(2);
  const texts = h.run.activity!.events.map((e) => e.text);
  expect(texts.slice(0, firstRound.length)).toEqual(firstRound);
  expect(texts.some((e) => e.includes('未切换算法'))).toBe(true);
  expect(texts.some((e) => e.includes('检查未全部通过'))).toBe(true);
  expect(texts.some((e) => e.includes('已跳过铺铜步骤'))).toBe(true);
  expect(texts.at(-1)).toContain('新增走线 2 段、过孔 1 个');
  expect(texts.join()).not.toContain('扩大板边避让');
});

it('keeps software exceptions in diagnostics while the process record explains the board outcome', async () => {
  const h = harness();
  h.bound.repairDsn.mockRejectedValue(new Error('IPC helper crashed at /internal/private/path'));
  h.bound.exportDsn.mockRejectedValue(new Error('IPC helper crashed at /internal/private/path'));
  await h.service.start(h.run);
  await h.done();
  expect(h.run.state).toBe('failed');
  expect(h.run.activity!.events.map((e) => e.text).join()).not.toContain('/internal/private/path');
  expect(h.run.activity!.events.at(-1)?.text).toContain('自动布线未能完成');
  expect(h.run.log?.join()).toContain('/internal/private/path');
});
