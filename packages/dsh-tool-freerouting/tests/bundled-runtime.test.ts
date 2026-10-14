import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareBundledRuntime } from '../src/runs/bundled-runtime.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
it('preserves the complete bundled runtime when staging it from a long installation path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fr-runtime-source-'));
  const launch = await mkdtemp(join(tmpdir(), 'fr-runtime-launch-'));
  directories.push(root, launch);
  const source = join(root, ...Array(5).fill('long-pnpm-install-directory'.padEnd(48, 'x')));
  const jre = join(source, 'jre');
  const contents = new Map([
    ['bin/java.exe', 'test executable'],
    ['bin/java.dll', 'test library'],
    ['bin/server/jvm.dll', 'test VM'],
    ['lib/modules', 'test modules'],
    ['lib/jvm.cfg', 'test config'],
    ['extra/resource', 'keep arbitrary runtime files'],
  ]);
  for (const [name, data] of contents) {
    const path = join(jre, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, data);
  }
  const javaExe = join(jre, 'bin/java.exe');
  const jarPath = join(source, 'freerouting.jar');
  await writeFile(jarPath, 'test engine');
  const runtime = await prepareBundledRuntime({ javaExe, jarPath }, launch);
  expect(runtime.copied).toBe(true);
  expect(runtime.javaExe.length).toBeLessThan(230);
  for (const [name, data] of contents) {
    expect(await readFile(join(launch, 'jre', name), 'utf8')).toBe(data);
    expect(await readFile(join(jre, name), 'utf8')).toBe(data);
  }
  expect(await readFile(runtime.jarPath, 'utf8')).toBe('test engine');
  expect(await readFile(jarPath, 'utf8')).toBe('test engine');
});
it('uses the existing bundled files directly when their paths are already short', async () => {
  const bundled = { javaExe: 'E:/plugin/jre/bin/java.exe', jarPath: 'E:/plugin/freerouting.jar' };
  expect(await prepareBundledRuntime(bundled, 'E:/tmp/launch')).toEqual({ ...bundled, copied: false });
});
