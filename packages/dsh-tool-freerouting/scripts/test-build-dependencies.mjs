import { execa } from 'execa';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.DSH_IPC_TEST_PYTHON;
if (!python) {
  throw new Error('Set DSH_IPC_TEST_PYTHON to the selected KiCad Python');
}
await execa(process.execPath, ['--test', 'scripts/tests/build-inputs.test.mjs'], {
  cwd: root,
  windowsHide: true,
  timeout: 30_000,
  stdio: 'inherit',
});
await execa(python, ['-B', '-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_*.py'], {
  cwd: root,
  windowsHide: true,
  timeout: 30_000,
  stdio: 'inherit',
  env: { PYTHONUTF8: '1' },
});
