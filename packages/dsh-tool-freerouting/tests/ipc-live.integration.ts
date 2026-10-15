import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { KicadIpcClient } from '../src/ipc/client.js';
import { FreeroutingClient } from '../src/proxy/freerouting-client.js';
import { FreeroutingLauncher } from '../src/runs/launcher.js';

it('starts the bundled HTTP engine on the configured loopback port', async () => {
  const router = new FreeroutingClient({
    baseUrl: 'http://127.0.0.1:37866',
    environmentHost: 'ipc-test/1.0.0',
    pollIntervalMs: 250,
    pollTimeoutMs: 60000,
    requestTimeoutMs: 5000,
    profileEmail: 'ipc-test@example.com',
    profileId: '3d3f8948-79c8-4b5e-a7a7-6e3f77f9d98c',
  });
  if (await router.checkStatus()) {
    throw new Error('Isolated launcher test port is already occupied');
  }
  const launcher = new FreeroutingLauncher({
    autoLaunch: true,
    baseUrl: 'http://127.0.0.1:37866',
    pollIntervalMs: 250,
    launchTimeoutMs: 30000,
    probe: (signal) => router.checkStatus(signal),
  });
  try {
    await launcher.ensureUp(() => {});
    expect(await router.checkStatus()).toBe(true);
  } finally {
    await launcher.shutdown();
  }
});

it('uses shipped Python dependencies and the bundled HTTP JAR for one final IPC import', async () => {
  const python = process.env.DSH_IPC_TEST_PYTHON;
  const socket = process.env.DSH_IPC_TEST_SOCKET;
  if (!python || !socket) {
    throw new Error('Explicit isolated fixture Python and socket are required');
  }
  const directory = await mkdtemp(join(tmpdir(), 'ipc-live-state-'));
  const ipc = new KicadIpcClient({
    kicadPythonPath: python,
    kicadApiSocket: socket,
    requestTimeoutMs: 120000,
    stateDirectory: directory,
  });
  const session = await ipc.open('isolated-live-test', new AbortController().signal);
  if (!session.target.boardPath.endsWith('fixture.kicad_pcb')) {
    throw new Error('Refusing a non-fixture board');
  }
  const inspect = (undo = false): string => {
    const code = `import sys,hashlib,json\nsys.path[:0]=[${JSON.stringify(resolve('python'))},${JSON.stringify(resolve('python/vendor'))}]\nfrom ipc_context import connect\na,b,p=connect(json.loads(sys.stdin.read()))\nassert b.name=='fixture.kicad_pcb'\n${undo ? "a.run_action('common.Interactive.undo')\n" : ''}print(hashlib.sha256(b.get_as_string().encode()).hexdigest())`;
    return execFileSync(python, ['-B', '-c', code], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 65536,
      input: JSON.stringify({ socket }),
    }).trim();
  };
  const baseline = inspect();
  const diskBaseline = await readFile(session.target.boardPath);
  let committed = false;
  let launcher: FreeroutingLauncher | undefined;
  try {
    const dsn = await session.exportDsn(new AbortController().signal);
    expect(dsn.length).toBeGreaterThan(500);
    const router = new FreeroutingClient({
      baseUrl: process.env.DSH_IPC_TEST_ROUTER ?? 'http://127.0.0.1:37865',
      environmentHost: 'ipc-live-test/1.0.0',
      pollIntervalMs: 250,
      pollTimeoutMs: 60000,
      requestTimeoutMs: 10000,
      profileEmail: 'ipc-test@example.com',
      profileId: '3d3f8948-79c8-4b5e-a7a7-6e3f77f9d98c',
    });
    const progress: string[] = [];
    launcher = new FreeroutingLauncher({
      autoLaunch: true,
      baseUrl: process.env.DSH_IPC_TEST_ROUTER ?? 'http://127.0.0.1:37865',
      pollIntervalMs: 250,
      launchTimeoutMs: 30000,
      probe: (signal) => router.checkStatus(signal),
    });
    await launcher.ensureUp(() => {});
    const routed = await router.route(
      'board.dsn',
      dsn.toString('base64'),
      {
        drawtimeSec: 5,
        fast: false,
        realtime: false,
        routeOnlyNets: ['GND'],
      },
      { onProgress: (event) => progress.push(event.state) },
    );
    expect(progress.length).toBeGreaterThan(0);
    const ses = Buffer.from(routed.sesBase64, 'base64');
    // Exercise the real duplicate-SES seam through native conversion and IPC,
    // retaining the engine's complete syntax and all original copper. Add a
    // point track covered by the wire endpoint to exercise native + IPC geometry
    // preservation and one-step undo without introducing a DRC violation.
    const duplicateCode = `import sys\nsys.path.insert(0,sys.argv[1])\nfrom specctra import copper_spans,parse,one\ntext=sys.stdin.read()\n_,_,items=copper_spans(text)\nstart,end,net,raw=next(i for i in items if i[3].lstrip().startswith('(wire'))\npath=one(parse(raw),'path')\npoint='(wire (path '+path[1]+' '+' '.join(path[2:5]+path[3:5])+'))'\nprint(text[:end]+raw+point+text[end:],end='')`;
    const repeated = execFileSync(python, ['-B', '-c', duplicateCode, resolve('python')], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      input: ses,
    });
    expect(repeated.length).toBeGreaterThan(ses.length);
    const imported = await session.importSession(repeated, ['GND']);
    expect(imported).toMatchObject({ outcome: 'committed', tracks: 2, vias: 0, designReport: { count: 0 } });
    committed = true;
    expect(await session.fillZones()).toEqual({ zonesFilled: 0, skipped: true });
    expect(inspect(true)).toBe(baseline);
    committed = false;
    // A real width violation must first be reported without mutation. After one
    // actual reroute, the explicitly approved policy permits it in one undo step.
    const freshDsn = await session.exportDsn(new AbortController().signal);
    const narrow = (value: Buffer) =>
      Buffer.from(
        value
          .toString('utf8')
          .replace(/(\(path\s+[^\s()]+\s+)\d+(?:\.\d+)?/g, (_match, prefix: string) => prefix + '10'),
      );
    const firstNarrow = narrow(ses);
    const firstReport = await session.reviewSession(firstNarrow, ['GND'], new AbortController().signal);
    expect(firstReport.count).toBeGreaterThan(0);
    expect(firstReport.violations.some((issue) => issue.type === 'track_width')).toBe(true);
    expect(inspect()).toBe(baseline);
    await expect(session.importSession(firstNarrow, ['GND'], undefined, true)).rejects.toMatchObject({
      code: 'DESIGN_REPAIR_REQUIRED',
    });
    expect(inspect()).toBe(baseline);
    const repairedDsn = await session.repairDsn([], new AbortController().signal);
    expect(repairedDsn.length).toBe(freshDsn.length);
    const second = await router.route(
      'board.dsn',
      repairedDsn.toString('base64'),
      { drawtimeSec: 5, fast: false, realtime: false, routeOnlyNets: ['GND'] },
      {},
    );
    const remaining = narrow(Buffer.from(second.sesBase64, 'base64'));
    const allowed = await session.importSession(remaining, ['GND'], undefined, true);
    committed = true;
    expect(allowed.outcome).toBe('committed');
    expect(allowed.designReport.count).toBeGreaterThan(0);
    expect(inspect(true)).toBe(baseline);
    committed = false;
    expect(await readFile(session.target.boardPath)).toEqual(diskBaseline);
  } finally {
    if (committed) {
      inspect(true);
    }
    await session.close();
    await rm(directory, { recursive: true, force: true });
    await launcher?.shutdown();
  }
});
