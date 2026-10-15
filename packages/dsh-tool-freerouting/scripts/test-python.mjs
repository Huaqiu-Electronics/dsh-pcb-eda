import { spawnSync } from 'node:child_process';
const python = process.env.DSH_IPC_TEST_PYTHON;
if (!python) {
  throw new Error('Set DSH_IPC_TEST_PYTHON to the selected KiCad 10 bin/python.exe');
}
const result = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_*.py'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, DSH_COMPUTE_OWNER: JSON.stringify({ pid: process.pid }) },
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
