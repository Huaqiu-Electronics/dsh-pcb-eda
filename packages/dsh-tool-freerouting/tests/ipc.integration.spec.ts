import type { DesignReport } from '../src/runs/design-report.js';
import type { ResourceGuard } from '../src/runs/resource-guard.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import { BoardGuard } from '../src/ipc/board-guard.js';
import { activeHelperPids } from '../src/ipc/helper-processes.js';
import type { KicadIpcClient } from '../src/ipc/client.js';
import { RunStore } from '../src/runs/run-store.js';
import { RunService } from '../src/runs/run-service.js';
import { statusResponse } from '../src/runs/contracts.js';
import { createRunHttpApp } from '../src/http/app.js';
import type { FreeroutingClient } from '../src/proxy/freerouting-client.js';
import { UpstreamServiceError } from '../src/proxy/upstream-errors.js';

const owner = { id: 'test-agent' } as Agent;
const cleanReport = {
  count: 0,
  violations: [],
  truncated: false,
} as DesignReport;
const parameters = {
  drawtimeSec: 5,
  fast: false,
  realtime: false,
  fillZonesAfterRoute: true,
  skipNets: [],
  routeOnlyNets: [],
};
const directories: string[] = [];
const stores: RunStore[] = [];
afterEach(async () => {
  stores.forEach((store) => store.dispose());
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function guard() {
  const directory = await mkdtemp(join(tmpdir(), 'ipc-test-'));
  directories.push(directory);
  return { directory, guard: new BoardGuard(directory, () => process.env.DSH_IPC_TEST_PYTHON!) };
}
function store() {
  const runs = new RunStore({ maxPendingRuns: 4, resultTtlMs: 3600000 });
  stores.push(runs);
  return runs;
}

describe('board ownership and uncertainty', () => {
  it('blocks a new task and a second confirmation while Windows holds the confirmation mutex', async () => {
    const { guard: board, directory } = await guard();
    const key = board.key('E:\\confirm-race.kicad_pcb');
    await board.markImporting(key);
    const script =
      "$p=[Console]::In.ReadLine(); $f=[IO.File]::Open($p,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Dispose()";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    const ready = new Promise<void>((done, fail) => {
      child.stdout.once('data', () => done());
      child.once('error', fail);
    });
    child.stdin.write(join(directory, `${key}.confirmation`) + '\n');
    await ready;
    try {
      await expect(board.acquire(key, 'new-run')).rejects.toMatchObject({ code: 'BOARD_CONFIRM_IN_PROGRESS' });
      await expect(board.acknowledge(key)).rejects.toMatchObject({ code: 'BOARD_CONFIRM_FAILED' });
      expect(JSON.parse(await readFile(join(directory, `${key}.uncertain`), 'utf8')).state).toBe('uncertain');
    } finally {
      child.stdin.end('release\n');
      await closed;
    }
    await board.acknowledge(key);
    await (
      await board.acquire(key, 'new-run')
    )();
    // Exercises several real Windows process and file-lock probes.
  }, 20000);
  it('arbitrates simultaneous requests atomically with a complete owning run id', async () => {
    const { guard: board } = await guard();
    const key = board.key('E:\\race.kicad_pcb');
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => board.acquire(key, `race-${n}`)));
    const accepted = results.filter((r) => r.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'BOARD_RUN_ACTIVE', message: expect.stringMatching(/race-\d/) });
      }
    }
    for (const result of accepted) {
      if (result.status === 'fulfilled') {
        await result.value();
      }
    }
  });
  it('refuses a second request with the existing run id', async () => {
    const { guard: board } = await guard();
    const key = board.key('E:\\board.kicad_pcb');
    const release = await board.acquire(key, 'existing-run');
    await expect(board.acquire(key, 'second-run')).rejects.toMatchObject({
      code: 'BOARD_RUN_ACTIVE',
      message: expect.stringContaining('existing-run'),
    });
    await release();
    await (
      await board.acquire(key, 'third-run')
    )();
  });
  it('keeps a minimal durable marker until explicit acknowledgement', async () => {
    const { guard: board, directory } = await guard();
    const key = board.key('E:\\board.kicad_pcb');
    const release = await board.acquire(key, 'run');
    await board.markImporting(key);
    await expect(board.acknowledge(key)).rejects.toMatchObject({ code: 'BOARD_RUN_ACTIVE' });
    await release();
    expect(JSON.parse(await readFile(join(directory, `${key}.uncertain`), 'utf8'))).toEqual({
      state: 'uncertain',
      version: 1,
    });
    const restarted = new BoardGuard(directory, () => process.env.DSH_IPC_TEST_PYTHON!);
    await expect(restarted.acquire(key, 'new')).rejects.toMatchObject({ code: 'IMPORT_UNCERTAIN' });
    await restarted.acknowledge(key);
    await (
      await restarted.acquire(key, 'new')
    )();
  });
  it('allows human acknowledgement when a stale lease PID has been reused', async () => {
    const { guard: board, directory } = await guard();
    const key = board.key('E:\\reused-pid.kicad_pcb');
    await writeFile(
      join(directory, `${key}.lease`),
      JSON.stringify({ runId: 'old-run', pid: process.pid, birth: '0' }),
    );
    await board.markImporting(key);
    await board.acknowledge(key);
    await (
      await board.acquire(key, 'new-run')
    )();
  });
});

function harness(importFailure?: string, fillFailure = false, cancelAtImport = false, resources?: ResourceGuard) {
  const runs = store();
  let done!: Promise<JobOutcome>;
  let cancel!: (reason: string) => void;
  const bound = {
    // Editor identity as reported by the IPC socket: `<pid>:<creation time>`.
    // The private-byte ceiling must never be applied to that pid.
    target: {
      boardPath: 'E:\\fixture.kicad_pcb',
      instance: '45016:1dd5bf0:7d8ca10f',
      socket: 'test',
      version: '10.0.6',
    },
    importStarted: false,
    exportDsn: vi.fn(async () => Buffer.from('(pcb (network (net GND (pins J1-1 J2-1)) (net VCC (pins J3-1 J4-1))))')),
    repairDsn: vi.fn(async () => Buffer.from('(pcb (network (net GND (pins J1-1 J2-1)) (net VCC (pins J3-1 J4-1))))')),
    reviewSession: vi.fn(async () => cleanReport),
    designReportArtifact: vi.fn(async () => Buffer.from('{"violations":[]}')),
    importSession: vi.fn(async (..._args: unknown[]) => {
      bound.importStarted = true;
      if (cancelAtImport) {
        cancel('user');
      }
      if (importFailure) {
        throw new UpstreamServiceError(importFailure, 409, importFailure);
      }
      return { outcome: 'committed', tracks: 3, vias: 1, designReport: cleanReport };
    }),
    fillZones: vi.fn(async () => {
      if (fillFailure) {
        throw new Error('fill');
      }
      return { zonesFilled: 0, skipped: true };
    }),
    close: vi.fn(async () => {}),
  };
  const ctx = {
    logger: { info: vi.fn() },
    jobs: {
      start: (job: { run: () => { done: Promise<JobOutcome>; cancel: (reason: string) => void } }) => {
        const execution = job.run();
        done = execution.done;
        cancel = execution.cancel;
        return 'job';
      },
    },
  } as unknown as Context;
  const freerouting = {
    route: vi.fn(async (..._args: unknown[]) => ({
      sesBase64: Buffer.from('(session fixture)').toString('base64'),
      state: 'COMPLETED',
    })),
  };
  const ipc = { open: vi.fn(async () => bound) };
  const service = new RunService(
    ctx,
    runs,
    freerouting as unknown as FreeroutingClient,
    ipc as unknown as KicadIpcClient,
    undefined,
    undefined,
    resources,
  );
  const run = runs.create('route', parameters, owner);
  return { runs, bound, freerouting, service, run, done: () => done };
}

describe('final import workflow', () => {
  it('samples only the compute a run owns, never the editor or the host process', async () => {
    const sampled: number[][] = [];
    const resources = {
      watch: vi.fn(async (ownedPids: () => number[], _stop: (reason: Error) => void) => {
        sampled.push(ownedPids());
        return () => {};
      }),
    };
    const h = harness(undefined, false, false, resources as unknown as ResourceGuard);
    // A loaded KiCad editor (3 GiB private, as measured on a live 10.0.7 editor with
    // the assistant open) must not be able to reach the JVM-heap ceiling.
    const editorPid = Number(h.bound.target.instance.split(':')[0]);
    const ownedHelperPid = 60_001;
    activeHelperPids.add(ownedHelperPid);
    try {
      await h.service.start(h.run);
      await h.done();
      expect(sampled).toHaveLength(1);
      const pids = sampled[0] ?? [];
      expect(pids).not.toContain(editorPid);
      expect(pids).not.toContain(process.pid);
      expect(pids).toContain(ownedHelperPid);
      expect(h.run.state).toBe('succeeded');
    } finally {
      activeHelperPids.delete(ownedHelperPid);
    }
  });

  it('fails and releases the bound session when resource monitoring cannot start', async () => {
    const resources = {
      watch: vi.fn(async () => {
        throw new Error('sampler startup failed');
      }),
    };
    const h = harness(undefined, false, false, resources as unknown as ResourceGuard);
    try {
      await h.service.start(h.run);
      expect(await h.done()).toMatchObject({ status: 'failed' });
      expect(h.run.state).toBe('failed');
      expect(h.bound.close).toHaveBeenCalledOnce();
      expect(h.bound.exportDsn).not.toHaveBeenCalled();
      expect(h.bound.importSession).not.toHaveBeenCalled();
      // The failed run must not retain a controller and block a later request.
      const next = h.runs.create('route', parameters, owner);
      await h.service.start(next);
      expect(await h.done()).toMatchObject({ status: 'failed' });
      expect(h.bound.close).toHaveBeenCalledTimes(2);
    } finally {
      await h.service.dispose();
    }
  });

  it('downloads the exact final SES used by a non-realtime repair', async () => {
    const h = harness();
    const first = Buffer.from('(session first)');
    const second = Buffer.from('(session repaired)');
    h.freerouting.route
      .mockResolvedValueOnce({ sesBase64: first.toString('base64'), state: 'COMPLETED' })
      .mockResolvedValueOnce({ sesBase64: second.toString('base64'), state: 'COMPLETED' });
    h.bound.reviewSession.mockResolvedValueOnce({ ...cleanReport, count: 1 });
    try {
      await h.service.start(h.run);
      await h.done();
      expect(h.run.state).toBe('repair_pending');
      await h.service.repair(h.run);
      await h.done();
      expect(h.bound.importSession.mock.calls[0]?.[0]).toEqual(second);
      const app = createRunHttpApp(h.runs, '/pcb');
      const download = await app.request(`/pcb/api/runs/${h.run.id}/output`, {
        headers: { authorization: `Bearer ${h.run.token}` },
      });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(second);
    } finally {
      await h.service.dispose();
    }
  });
  it('continues once with the authorized default when the agent does not respond', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      h.bound.reviewSession.mockResolvedValueOnce({
        count: 1,
        truncated: false,
        violations: [
          {
            type: 'clearance',
            severity: 'error',
            description: '间距不足',
            items: [{ uuid: 'new', description: '走线', x: 1, y: 2 }],
          },
        ],
      });
      await h.service.start(h.run);
      await h.done();
      expect(h.run.state).toBe('repair_pending');
      await vi.advanceTimersByTimeAsync(30001);
      await h.done();
      expect(h.run.state).toBe('succeeded');
      expect(h.bound.close).toHaveBeenCalledTimes(1);
      expect(h.bound.importSession).toHaveBeenCalledTimes(1);
      expect(h.freerouting.route).toHaveBeenCalledTimes(2);
      await expect(h.service.repair(h.run)).rejects.toMatchObject({ code: 'REPAIR_UNAVAILABLE' });
    } finally {
      await h.service.dispose();
      h.runs.dispose();
      vi.useRealTimers();
    }
  });
  it('hands conflicts to the agent, keeps the target locked and continues at most once with reported rule violations', async () => {
    const h = harness();
    const report = {
      count: 1,
      truncated: false,
      violations: [
        {
          type: 'track_width',
          severity: 'error',
          description: '线宽不足',
          items: [{ uuid: 'new-track', description: 'VCC 走线', x: 12, y: 34 }],
        },
      ],
    };
    h.bound.reviewSession.mockResolvedValue(report);
    h.bound.importSession.mockResolvedValue({ outcome: 'committed', tracks: 3, vias: 1, designReport: report });
    await h.service.start(h.run);
    const initial = await h.done();
    expect(h.run.state).toBe('repair_pending');
    expect(initial.result).toContain('pcb_repair_route');
    expect(initial.result).toContain('user_message');
    expect(h.bound.importSession).not.toHaveBeenCalled();
    expect(h.bound.close).not.toHaveBeenCalled();
    const first = h.service.repair(h.run);
    await expect(h.service.repair(h.run)).rejects.toMatchObject({ code: 'REPAIR_UNAVAILABLE' });
    await first;
    const completed = await h.done();
    expect(h.freerouting.route).toHaveBeenCalledTimes(2);
    expect(h.bound.exportDsn).toHaveBeenCalledTimes(1);
    expect(h.bound.repairDsn).toHaveBeenCalledTimes(1);
    expect(h.bound.importSession.mock.calls[0]?.[3]).toBe(true);
    expect(h.run.state).toBe('partial');
    expect(h.run.output?.routing).toMatchObject({ imported: true, repairAttempts: 1, designReport: report });
    expect(h.run.output?.routing.warning).toContain('未解决的布线规则问题');
    expect(completed.detail).toContain('文件未自动保存');
    expect(completed.result).toContain('走线宽度不符合板子的要求');
    expect(h.bound.close).toHaveBeenCalledTimes(1);
    const app = createRunHttpApp(h.runs, '/pcb');
    expect((await app.request(`/pcb/api/runs/${h.run.id}/report`)).status).toBe(401);
    const download = await app.request(`/pcb/api/runs/${h.run.id}/report`, {
      headers: { authorization: `Bearer ${h.run.token}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/json');
    await h.service.dispose();
  });
  it('stops on a changed board during repair and cancels an agent-pending task without touching the board', async () => {
    const report = {
      count: 1,
      truncated: false,
      violations: [
        {
          type: 'clearance',
          severity: 'error',
          description: '间距不足',
          items: [{ uuid: 'new-track', description: 'VCC 走线', x: 12, y: 34 }],
        },
      ],
    };
    for (const cancel of [false, true]) {
      const h = harness();
      h.bound.reviewSession.mockResolvedValue(report);
      await h.service.start(h.run);
      await h.done();
      if (cancel) {
        await h.service.cancel(h.run);
        expect(h.run.state).toBe('cancelled');
      } else {
        h.bound.repairDsn.mockRejectedValue(new UpstreamServiceError('BOARD_CHANGED', 409, '板子已改变'));
        await h.service.repair(h.run);
        await h.done();
        expect(h.run.error?.code).toBe('BOARD_CHANGED');
      }
      expect(h.bound.importSession).not.toHaveBeenCalled();
      expect(h.bound.close).toHaveBeenCalledTimes(1);
      await h.service.dispose();
    }
  });
  it('does not bypass a failed design check or discard a confirmed import when report retention fails', async () => {
    const h = harness();
    h.bound.reviewSession.mockRejectedValue(
      new UpstreamServiceError('DESIGN_CHECK_FAILED', 409, '原生 DRC HTTP helper SES'),
    );
    await h.service.start(h.run);
    const failed = await h.done();
    expect(h.run.state).toBe('failed');
    expect(h.bound.importSession).not.toHaveBeenCalled();
    expect(failed.detail).toContain('未能完成新走线的布线规则检查');
    expect(failed.result).not.toContain('HTTP helper');
    const status = statusResponse(h.run);
    expect(status.user_message).toBe(failed.detail);
    expect(status.error?.message).toContain('HTTP helper');
    const committed = harness();
    committed.bound.designReportArtifact
      .mockResolvedValueOnce(Buffer.from('{}'))
      .mockRejectedValueOnce(new Error('disk'));
    await committed.service.start(committed.run);
    await committed.done();
    expect(committed.run.output?.routing.imported).toBe(true);
    expect(committed.run.state).toBe('succeeded');
  });
  it('does not create a background job after cancellation during instance binding', async () => {
    const runs = store();
    const run = runs.create('route', parameters, owner);
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    let boundSignal!: AbortSignal;
    const open = vi.fn((_id: string, signal: AbortSignal) => {
      boundSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const start = vi.fn();
    const close = vi.fn(async () => {});
    const service = new RunService(
      { jobs: { start } } as unknown as Context,
      runs,
      {} as FreeroutingClient,
      { open } as unknown as KicadIpcClient,
    );
    const pending = service.start(run, controller.signal);
    controller.abort(new DOMException('User cancelled', 'AbortError'));
    expect(boundSignal.aborted).toBe(true);
    finish({ close });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('routes every net by default, imports once, reports no zones and unknown connectivity', async () => {
    const h = harness();
    await h.service.start(h.run);
    await h.done();
    expect(h.freerouting.route.mock.calls[0]?.[2]).toMatchObject({ routeOnlyNets: ['GND', 'VCC'], realtime: false });
    expect(h.bound.importSession).toHaveBeenCalledTimes(1);
    expect(h.run.output?.routing).toMatchObject({ imported: true, tracks: 3, vias: 1, zonesFilled: 0 });
    expect(h.run.output?.routing.routedNets).toBeUndefined();
    expect(h.run.output?.routing.warning).toContain('没有已设置的铺铜区域');
  });
  it('retains downloadable SES after a changed board or uncertain import', async () => {
    for (const code of ['BOARD_CHANGED', 'IMPORT_UNCERTAIN']) {
      const h = harness(code);
      await h.service.start(h.run);
      await h.done();
      expect(h.run.state).toBe('failed');
      expect(h.run.error?.code).toBe(code);
      const app = createRunHttpApp(h.runs, '/pcb');
      const output = await app.request(`/pcb/api/runs/${h.run.id}/output`, {
        headers: { authorization: `Bearer ${h.run.token}` },
      });
      expect(output.status).toBe(200);
      expect(await output.text()).toBe('(session fixture)');
    }
  });
  it('keeps committed copper on fill failure', async () => {
    const h = harness(undefined, true);
    await h.service.start(h.run);
    await h.done();
    expect(h.run.output?.routing.imported).toBe(true);
    expect(h.run.state).toBe('partial');
    expect(h.run.output?.routing.warning).toContain('新走线已添加到板子，但铺铜未完成');
  });
  it('defers cancellation during import and retains committed copper', async () => {
    const h = harness(undefined, false, true);
    await h.service.start(h.run);
    await h.done();
    expect(h.run.state).toBe('succeeded');
    expect(h.bound.fillZones).not.toHaveBeenCalled();
    expect(h.run.output?.routing.warning).toContain('取消时新走线已添加到板子，已保留');
  });
  it('does not label an uncertain commit as cancelled', async () => {
    const h = harness('IMPORT_UNCERTAIN', false, true);
    await h.service.start(h.run);
    await h.done();
    expect(h.run.state).toBe('failed');
    expect(h.run.error?.code).toBe('IMPORT_UNCERTAIN');
  });
});
