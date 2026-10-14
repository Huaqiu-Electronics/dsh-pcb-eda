import { expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent';
import { JobId } from '@deepseek-ai/dsh-jobs';
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { RunService } from '../src/runs/run-service.js';
import { RunStore } from '../src/runs/run-store.js';
import type { KicadIpcClient } from '../src/ipc/client.js';
import type { FreeroutingClient } from '../src/proxy/freerouting-client.js';

it('starts an owned route in the real DSH registry and delivers its result once to that session', async () => {
  const ctx = new Context();
  const agents = new AgentRegistry(ctx);
  const jobs = new LocalJobRegistry(ctx, LocalJobRegistry.Config({}));
  const detachController = jobs.attachController('freerouting-contract-test');
  const sessionId = 'routing-owner' as SessionId;
  // The agent loop is outside this test; the registry and owner lifetime are real.
  const owner = { id: sessionId, session: { id: sessionId }, ctx } as Agent;
  const detachOwner = agents.enter(owner, undefined);
  const runs = new RunStore({ maxPendingRuns: 1, resultTtlMs: 3600000 });
  const report = { count: 0, violations: [], truncated: false };
  let closed = false;
  const ipc = {
    open: async () => ({
      target: { boardPath: 'fixture.kicad_pcb' },
      exportDsn: async () => Buffer.from('(pcb (network (net GND (pins J1-1 J2-1))))'),
      reviewSession: async () => report,
      designReportArtifact: async () => undefined,
      importSession: async () => ({ outcome: 'committed', tracks: 3, vias: 1, designReport: report }),
      close: async () => {
        closed = true;
      },
    }),
  } as unknown as KicadIpcClient;
  const router = {
    route: async () => ({ sesBase64: Buffer.from('(session fixture)').toString('base64'), state: 'COMPLETED' }),
  } as unknown as FreeroutingClient;
  const service = new RunService(ctx, runs, router, ipc);
  try {
    const run = runs.create(
      'route',
      {
        drawtimeSec: 5,
        fast: false,
        realtime: false,
        fillZonesAfterRoute: false,
        skipNets: [],
        routeOnlyNets: [],
      },
      owner,
    );
    const id = JobId(await service.start(run));
    const completed = await jobs.wait(id, 5000, sessionId);
    expect(completed, JSON.stringify(run.error)).toMatchObject({ owner: sessionId, status: 'completed' });
    expect(() => jobs.read(id, 'another-session' as SessionId)).toThrow('another session');
    const result = jobs.read(id, sessionId).result;
    expect(JSON.parse(result!)).toMatchObject({ state: 'succeeded', summary: { imported: true, tracks: 3, vias: 1 } });
    expect(jobs.read(id, sessionId).result).toBeUndefined();
    expect(closed).toBe(true);
  } finally {
    await service.dispose();
    runs.dispose();
    detachController();
    detachOwner();
    await ctx.fiber.dispose();
  }
});
