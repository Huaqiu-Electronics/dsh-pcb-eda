import type * as Runner from '../src/ipc/runner.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IpcRun } from '../src/ipc/session.js';
import { KicadIpcClient } from '../src/ipc/client.js';
import type { BoardGuard } from '../src/ipc/board-guard.js';
import { runHelper } from '../src/ipc/runner.js';

vi.mock('../src/ipc/runner.js', async (original) => ({
  ...(await original<typeof Runner>()),
  runHelper: vi.fn(),
}));
vi.mock('../src/ipc/python-runtime.js', () => ({ pythonPath: vi.fn(() => process.env.DSH_IPC_TEST_PYTHON!) }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ipc-session-test-'));
  vi.mocked(runHelper).mockReset();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function session() {
  const guard = {
    markImporting: vi.fn(async () => {}),
    resolve: vi.fn(async () => {}),
    setHelper: vi.fn(async () => {}),
  };
  const release = vi.fn(async () => {});
  const run = new IpcRun(
    { pythonPath: 'test', socket: 'test', timeoutMs: 1000 },
    { socket: 'test', instance: 'test', boardPath: 'E:\\fixture.kicad_pcb', version: '10.0.6' },
    'session-test',
    'key',
    directory,
    guard as unknown as BoardGuard,
    release,
  );
  return { run, guard, release };
}

it('cancels immediately after marker preparation before launching a mutating helper', async () => {
  const { run, guard } = session();
  const controller = new AbortController();
  guard.markImporting.mockImplementation(async () => {
    controller.abort(new DOMException('Cancelled', 'AbortError'));
  });
  await expect(run.importSession(Buffer.from('ses'), ['GND'], controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(runHelper).not.toHaveBeenCalled();
  expect(run.importStarted).toBe(false);
  expect(guard.resolve).toHaveBeenCalledTimes(1);
  await run.close();
});

it('reports committed copper explicitly when clearing the durable marker fails', async () => {
  const { run, guard } = session();
  vi.mocked(runHelper).mockResolvedValue({ outcome: 'committed', tracks: 3, vias: 1 });
  guard.resolve.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(run.importSession(Buffer.from('ses'), ['GND'])).rejects.toMatchObject({
    code: 'IMPORT_UNCERTAIN',
    message: expect.stringContaining('布线已回导'),
  });
  expect(guard.resolve).toHaveBeenCalledTimes(1);
  await run.close();
});

it('does not finish normal close until the task lease has been released', async () => {
  const { run, release } = session();
  await run.close();
  expect(release).toHaveBeenCalledTimes(1);
});

it('keeps the durable marker throughout visible preview and clears it only after confirmed cleanup', async () => {
  const { run, guard } = session();
  vi.mocked(runHelper).mockResolvedValueOnce({ outcome: 'committed', tracks: 3, vias: 1 });
  await run.previewSession(Buffer.from('preview'), ['GND'], new AbortController().signal);
  expect(guard.markImporting).toHaveBeenCalledTimes(1);
  expect(guard.resolve).not.toHaveBeenCalled();
  expect(run.importStarted).toBe(false);
  expect(vi.mocked(runHelper).mock.calls[0]?.slice(4)).toEqual([undefined, true]);
  vi.mocked(runHelper).mockResolvedValueOnce({ cleared: true });
  await run.clearPreview();
  expect(guard.resolve).toHaveBeenCalledTimes(1);
  await run.clearPreview();
  expect(runHelper).toHaveBeenCalledTimes(2);
  await run.close();
});

it('does not retry or clear uncertain preview mutations and preserves the durable marker', async () => {
  const { run, guard } = session();
  vi.mocked(runHelper).mockRejectedValue(Object.assign(new Error('lost response'), { code: 'IMPORT_UNCERTAIN' }));
  // Use the public domain error, which is what the helper boundary produces.
  const { UpstreamServiceError } = await import('../src/proxy/upstream-errors.js');
  vi.mocked(runHelper).mockRejectedValue(new UpstreamServiceError('IMPORT_UNCERTAIN', 409, '检查板子'));
  await expect(run.previewSession(Buffer.from('preview'), ['GND'], new AbortController().signal)).rejects.toMatchObject(
    { code: 'IMPORT_UNCERTAIN' },
  );
  await run.clearPreview();
  expect(runHelper).toHaveBeenCalledTimes(1);
  expect(guard.resolve).not.toHaveBeenCalled();
  await run.close();
});

it('keeps the marker when preview cleanup fails instead of claiming unchanged copper', async () => {
  const { run, guard } = session();
  vi.mocked(runHelper).mockResolvedValueOnce({ outcome: 'committed', tracks: 3, vias: 1 });
  await run.previewSession(Buffer.from('preview'), ['GND'], new AbortController().signal);
  vi.mocked(runHelper).mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(run.clearPreview()).rejects.toMatchObject({ code: 'IMPORT_UNCERTAIN' });
  expect(guard.resolve).not.toHaveBeenCalled();
  await run.close();
});

it('logs export rule conflicts and continues with the original DSN', async () => {
  const { run, guard } = session();
  const warning = '网络 GND 的线宽为 0.2 mm，小于电路板要求的 0.3 mm；按当前网络设置继续布线';
  vi.mocked(runHelper).mockResolvedValue({ exported: true, warnings: [warning] });
  await writeFile(join(directory, 'board.dsn'), 'original-dsn');
  const record = vi.fn();
  const dsn = await run.exportDsn(new AbortController().signal, record);
  expect(dsn.toString()).toBe('original-dsn');
  expect(record).toHaveBeenCalledExactlyOnceWith(warning);
  expect(guard.markImporting).not.toHaveBeenCalled();
  await run.close();
});

it('shares one global task lease across clients targeting different boards', async () => {
  const options = {
    kicadPythonPath: 'test',
    kicadApiSocket: 'test',
    requestTimeoutMs: 1000,
    stateDirectory: join(directory, 'state'),
  };
  const firstClient = new KicadIpcClient(options);
  const secondClient = new KicadIpcClient(options);
  vi.mocked(runHelper).mockResolvedValueOnce({
    socket: 'test',
    instance: 'one',
    boardPath: 'E:/one.kicad_pcb',
    version: '10.0.6',
  });
  const first = await firstClient.open('first-task', new AbortController().signal);
  let second: IpcRun | undefined;
  try {
    const other = { socket: 'test', instance: 'two', boardPath: 'E:/two.kicad_pcb', version: '10.0.6' };
    vi.mocked(runHelper).mockResolvedValue(other);
    await expect(secondClient.open('second-task', new AbortController().signal)).rejects.toMatchObject({
      code: 'BOARD_RUN_ACTIVE',
      message: expect.stringContaining('first-task'),
    });
    await first.close();
    second = await secondClient.open('second-task', new AbortController().signal);
    expect(second.target.boardPath).toBe('E:/two.kicad_pcb');
  } finally {
    await first.close();
    await second?.close();
  }
});
