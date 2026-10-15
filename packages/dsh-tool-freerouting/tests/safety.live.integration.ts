import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FreeroutingClient } from '../src/proxy/freerouting-client.js';
import { z } from 'zod';
import { computeCommand } from '../src/runs/compute-client.js';
import { FreeroutingLauncher } from '../src/runs/launcher.js';

it('routes with the same client after real bundled Java shutdown and restart', async () => {
  const python = process.env.DSH_IPC_TEST_PYTHON;
  if (!python) {
    throw new Error('Explicit selected KiCad Python required');
  }
  const baseUrl = 'http://127.0.0.1:37869';
  const router = new FreeroutingClient({
    baseUrl,
    environmentHost: 'safety-live/1',
    profileId: '3d3f8948-79c8-4b5e-a7a7-6e3f77f9d98c',
    profileEmail: 'ipc-test@example.com',
    pollIntervalMs: 250,
    pollTimeoutMs: 60000,
    requestTimeoutMs: 5000,
  });
  if (await router.checkStatus()) {
    throw new Error('Dedicated test port is occupied');
  }
  const launcher = new FreeroutingLauncher({
    autoLaunch: true,
    kicadPythonPath: python,
    baseUrl,
    launchTimeoutMs: 30000,
    pollIntervalMs: 250,
    probe: (signal) => router.checkStatus(signal),
    verifyIdle: (signal) => router.verifyEngineIdle(signal),
  });
  const directory = await mkdtemp(join(tmpdir(), 'engine-restart-fixture-'));
  await writeFile(join(directory, 'input.kicad_pro'), '{}');
  execFileSync(python, ['-B', resolve('python/tests/make_fixture.py'), directory, join(directory, 'input.kicad_pro')], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4096,
  });
  execFileSync(
    python,
    [
      '-B',
      '-c',
      'import pcbnew,sys; b=pcbnew.LoadBoard(sys.argv[1]); assert pcbnew.ExportSpecctraDSN(b,sys.argv[2])',
      join(directory, 'fixture.kicad_pcb'),
      join(directory, 'fixture.dsn'),
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 4096 },
  );
  const dsn = await readFile(join(directory, 'fixture.dsn'));
  try {
    for (let round = 1; round <= 2; round++) {
      await launcher.ensureUp(() => {});
      expect(launcher.pid).toBeGreaterThan(0);
      const memory = await computeCommand(
        python,
        { command: 'sample', pids: [process.pid, launcher.pid] },
        z.object({ processes: z.array(z.object({ pid: z.number(), private: z.number(), working: z.number() })) }),
      );
      console.info(`real Java memory round ${round}: ${JSON.stringify(memory.processes)}`);
      const result = await router.route(
        'fixture.dsn',
        dsn.toString('base64'),
        { fast: true, realtime: false, drawtimeSec: 1, routeOnlyNets: [] },
        {},
      );
      expect(result.state).toBe('COMPLETED');
      expect(Buffer.from(result.sesBase64, 'base64').toString()).toContain('(session');
      // Real session job-list check before reuse.
      await launcher.ensureUp(() => {});
      await launcher.shutdown();
      expect(await router.checkStatus()).toBe(false);
      console.info(`PASS real Java round ${round}: routed and confirmed process exit`);
    }
  } finally {
    await launcher.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 150000);
