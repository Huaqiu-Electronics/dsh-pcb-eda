import { spawnSync } from 'node:child_process';

// Developer tooling only; never install Ruff into the selected KiCad runtime.
const executable = process.env.DSH_RUFF_BIN || 'ruff';
for (const args of [
  ['check', 'python', 'scripts'],
  ['format', '--check', 'python', 'scripts'],
]) {
  const result = spawnSync(executable, args, {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error('Install the pinned developer Ruff tool or set DSH_RUFF_BIN to ruff.exe', { cause: result.error });
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
