import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.DSH_IPC_TEST_PYTHON;
const jdk = process.env.DSH_ENGINE_TEST_JDK;
if (!python || !jdk) {
  throw new Error('Set DSH_IPC_TEST_PYTHON to KiCad Python 3.11 and DSH_ENGINE_TEST_JDK to a full JDK 25');
}
await execa(
  python,
  [
    '-B',
    join(root, 'scripts/prepare_dependencies.py'),
    '--python',
    python,
    '--jdk',
    jdk,
    '--cache',
    process.env.DSH_BUILD_CACHE || join(root, '.build-cache'),
  ],
  {
    cwd: root,
    windowsHide: true,
    timeout: 30 * 60 * 1000,
    stdio: 'inherit',
    env: { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
  },
);
