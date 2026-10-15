import { expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { editorProcessState } from '../src/ipc/editor-process.js';
import { EditorLifecycle } from '../src/runs/editor-lifecycle.js';
import { FreeroutingLauncher } from '../src/runs/launcher.js';
import { FreeroutingClient } from '../src/proxy/freerouting-client.js';

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => Promise<boolean>, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(200);
  }
  throw new Error('Isolated editor lifecycle condition timed out');
}
async function closeFixture(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  // The exact process spawned by this test, never a user's existing editor.
  const exited = new Promise<void>((done) => child.once('close', () => done()));
  child.kill();
  await exited;
}

it.each([false, true])(
  'closes owned real Java when the real fixture PCB editor exits (finished=%s)',
  async (finished) => {
    const python = process.env.DSH_IPC_TEST_PYTHON;
    if (!python) {
      throw new Error('An explicit KiCad Python is required');
    }
    const directory = await mkdtemp(join(tmpdir(), 'editor-close-live-'));
    const project = join(directory, 'input.kicad_pro');
    await writeFile(project, '{}');
    execFileSync(python, ['-B', resolve('python/tests/make_fixture.py'), directory, project], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4096,
    });
    const configSource = process.env.DSH_IPC_TEST_CONFIG;
    if (!configSource) {
      throw new Error('An explicit already-initialized KiCad test config is required');
    }
    await mkdir(join(directory, 'config/10.0'), { recursive: true });
    for (const name of [
      'kicad_common.json',
      'pcbnew.json',
      'fp-lib-table',
      'sym-lib-table',
      'design-block-lib-table',
      'kicad.json',
    ]) {
      await copyFile(join(configSource, name), join(directory, 'config/10.0', name));
    }
    const commonPath = join(directory, 'config/10.0/kicad_common.json');
    const common = JSON.parse(await readFile(commonPath, 'utf8'));
    common.api = { ...common.api, enable_server: true };
    common.auto_backup = { ...common.auto_backup, enabled: false };
    await writeFile(commonPath, JSON.stringify(common));
    const temporary = join(directory, 'tmp');
    await mkdir(temporary);
    const editor = spawn(join(dirname(python), 'pcbnew.exe'), [join(directory, 'fixture.kicad_pcb')], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, KICAD_CONFIG_HOME: join(directory, 'config'), TEMP: temporary, TMP: temporary },
    });
    const baseUrl = 'http://127.0.0.1:37868';
    const router = new FreeroutingClient({
      baseUrl,
      environmentHost: 'editor-close-live/1',
      pollIntervalMs: 250,
      pollTimeoutMs: 30000,
      requestTimeoutMs: 1000,
      profileEmail: 'ipc-test@example.com',
      profileId: '3d3f8948-79c8-4b5e-a7a7-6e3f77f9d98c',
    });
    const launcher = new FreeroutingLauncher({
      autoLaunch: true,
      kicadPythonPath: python,
      baseUrl,
      pollIntervalMs: 250,
      launchTimeoutMs: 30000,
      probe: (signal) => router.checkStatus(signal),
    });
    let watch: EditorLifecycle | undefined;
    try {
      expect(await router.checkStatus()).toBe(false);
      let instance = '';
      // Resolve the actual named-pipe server identity and ping this fixture only.
      const probe = `import os,sys,json\nsys.path[:0]=[sys.argv[1],sys.argv[2]]\nfrom instance_identity import identity\nfrom kipy import KiCad\nfor p in os.listdir(chr(92)*2+'.'+chr(92)+'pipe'+chr(92)):\n if 'kicad' not in p.lower(): continue\n try:\n  s='ipc://'+p; i=identity(s)\n  if i.split(':')[0]!=sys.argv[3]: continue\n  a=KiCad(socket_path=s,kicad_token='',timeout_ms=1000); a.ping()\n  assert a.get_board().name=='fixture.kicad_pcb'\n  print(i); break\n except Exception as e:\n  if sys.argv[4] in p: print(type(e).__name__+':'+str(e)[:200],file=sys.stderr)`;
      await until(async () => {
        instance = execFileSync(
          python,
          ['-B', '-c', probe, resolve('python'), resolve('python/vendor'), String(editor.pid), directory],
          {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 4096,
          },
        ).trim();
        return !!instance;
      });
      expect(await editorProcessState(instance, python)).toBe('alive');
      expect(await editorProcessState(`${editor.pid}:0:1`, python)).toBe('closed');
      const controller = new AbortController();
      const cancelled: string[] = [],
        errors: string[] = [];
      let shutdowns = 0;
      watch = new EditorLifecycle({
        probe: (value) => editorProcessState(value, python),
        intervalMs: 200,
        onClosed: async (ids) => {
          cancelled.push(...ids);
          controller.abort();
        },
        shutdown: async () => {
          await launcher.shutdown();
          shutdowns++;
        },
        onError: (message) => errors.push(message),
      });
      watch.bind(instance, 'live-fixture-run');
      await launcher.ensureUp(() => {});
      expect(await router.checkStatus()).toBe(true);
      if (finished) {
        await watch.release('live-fixture-run');
      }
      const closedAt = Date.now();
      await closeFixture(editor);
      await until(async () => shutdowns === 1);
      expect(await editorProcessState(instance, python)).toBe('closed');
      expect(await router.checkStatus()).toBe(false);
      expect(cancelled).toEqual(finished ? [] : ['live-fixture-run']);
      expect(controller.signal.aborted).toBe(true);
      expect(errors).toEqual([]);
      console.info(
        `real editor ${editor.pid}: finished=${finished}, Java exit confirmed in ${Date.now() - closedAt} ms`,
      );
    } finally {
      await watch?.dispose();
      await launcher.shutdown();
      await closeFixture(editor);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
