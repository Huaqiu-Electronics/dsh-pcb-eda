import { spawnSync } from 'node:child_process';

const python = process.env.DSH_IPC_TEST_PYTHON;
if (!python) {
  throw new Error('Set DSH_IPC_TEST_PYTHON to the selected KiCad 10 bin/python.exe');
}
const result = spawnSync(python, ['-B', 'engine/tests/regression.py'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
const jdk = process.env.DSH_ENGINE_TEST_JDK;
if (!jdk) {
  throw new Error('Set DSH_ENGINE_TEST_JDK to a JDK 25 directory for the SES writer regression');
}
const precision = spawnSync(python, ['-B', 'engine/tests/precision.py', '--jdk', jdk], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  windowsHide: true,
});
if (precision.error) {
  throw precision.error;
}
if (precision.status !== 0) {
  process.exit(precision.status ?? 1);
}
const scheduler = spawnSync(python, ['-B', 'engine/tests/scheduler.py', '--jdk', jdk], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  windowsHide: true,
});
if (scheduler.error) {
  throw scheduler.error;
}
if (scheduler.status !== 0) {
  process.exit(scheduler.status ?? 1);
}
const finalOutput = spawnSync(python, ['-B', 'engine/tests/final_output.py', '--jdk', jdk], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  windowsHide: true,
});
if (finalOutput.error) {
  throw finalOutput.error;
}
process.exitCode = finalOutput.status ?? 1;
