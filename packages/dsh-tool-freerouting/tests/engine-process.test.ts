import { afterEach, expect, it, vi } from 'vitest';
import { EngineProcess } from '../src/runs/engine-process.js';
const { command, rm } = vi.hoisted(() => ({ command: vi.fn(), rm: vi.fn(async () => {}) }));
vi.mock('../src/runs/compute-client.js', () => ({ computeCommand: command, computeRecordSchema: {} }));
vi.mock('node:fs/promises', () => ({ rm }));
const record = { pid: 999, birth: '1', owner: { pid: 100, birth: '2' }, job: 'owned-job', remote: '123' };
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('targets only the owned job and waits for confirmed exit and directory cleanup', async () => {
  command.mockImplementation(async (_python, request) =>
    request.command === 'launch' ? record : request.command === 'stop' ? { state: 'closed' } : { released: true },
  );
  let clean!: () => void;
  rm.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        clean = resolve;
      }),
  );
  const exited = vi.fn();
  const engine = await EngineProcess.launch('kicad-python', ['owned-java'], 'isolated-directory', exited);
  let done = false;
  const stopped = engine.stop().then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(rm).toHaveBeenCalled());
  expect(command).toHaveBeenCalledWith('kicad-python', { command: 'stop', record }, expect.anything());
  expect(done).toBe(false);
  expect(exited).not.toHaveBeenCalled();
  clean();
  await stopped;
  expect(exited).toHaveBeenCalledOnce();
});

it('retains ownership when stop fails and verifies a later retry', async () => {
  let fail = true;
  command.mockImplementation(async (_python, request) => {
    if (request.command === 'launch') {
      return record;
    }
    if (request.command === 'stop' && fail) {
      throw new Error('denied');
    }
    return request.command === 'stop' ? { state: 'closed' } : { released: true };
  });
  const engine = await EngineProcess.launch('python', ['java'], 'isolated', vi.fn());
  await expect(engine.stop()).rejects.toThrow('denied');
  expect(rm).not.toHaveBeenCalled();
  fail = false;
  await engine.stop();
  expect(rm).toHaveBeenCalledOnce();
});

it('does not blindly retry remote handle consumption on release failure', async () => {
  command.mockImplementation(async (_python, request) => {
    if (request.command === 'launch') {
      return record;
    }
    if (request.command === 'release') {
      throw new Error('unconfirmed handle release');
    }
    return { state: 'closed' };
  });
  const engine = await EngineProcess.launch('python', ['java'], 'isolated', vi.fn());
  await expect(engine.stop()).rejects.toThrow('unconfirmed');
  await expect(engine.stop()).rejects.toThrow('unconfirmed');
  expect(command.mock.calls.filter((args) => args[1].command === 'release')).toHaveLength(1);
});

it('shares concurrent stop and cleanup work without creating duplicate commands', async () => {
  let finish!: (value: unknown) => void;
  command.mockImplementation(async (_python, request) => {
    if (request.command === 'launch') {
      return record;
    }
    if (request.command === 'stop') {
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return { released: true };
  });
  const engine = await EngineProcess.launch('python', ['java'], 'isolated', vi.fn());
  const first = engine.stop(),
    second = engine.stop();
  expect(first).toBe(second);
  expect(command.mock.calls.filter((args) => args[1].command === 'stop')).toHaveLength(1);
  finish({ state: 'closed' });
  await Promise.all([first, second]);
  expect(command.mock.calls.filter((args) => args[1].command === 'release')).toHaveLength(1);
  expect(rm).toHaveBeenCalledOnce();
});
