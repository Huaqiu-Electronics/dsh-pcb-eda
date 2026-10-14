import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function validateEngineBuild(provenance, sourceLock, actualDigest) {
  if (
    !isDeepStrictEqual(provenance.source, sourceLock) ||
    provenance.upstream_tests_passed !== true ||
    provenance.output_sha256 !== actualDigest
  ) {
    throw new Error('Engine build is missing, stale or corrupt; run prepare:dependencies');
  }
}

export async function verifyBuildInputs(root) {
  const sourceLock = JSON.parse(await readFile(join(root, 'engine/source.lock.json'), 'utf8'));
  const provenance = JSON.parse(await readFile(join(root, 'bundled/freerouting.build.json'), 'utf8'));
  validateEngineBuild(provenance, sourceLock, await sha256(join(root, 'bundled/freerouting.jar')));
  const sourceFiles = {
    ['engine/' + sourceLock.source_archive]: sourceLock.source_sha256,
    ...Object.fromEntries(Object.entries(sourceLock.patch_sources).map(([name, hash]) => ['engine/src/' + name, hash])),
  };
  const runtimeLock = JSON.parse(await readFile(join(root, 'bundled/runtime.lock.json'), 'utf8'));
  sourceFiles['bundled/jre/bin/java.exe'] = runtimeLock.java_exe_sha256;
  sourceFiles['bundled/jre/release'] = runtimeLock.release_sha256;
  for (const [name, expected] of Object.entries(sourceFiles)) {
    if ((await sha256(join(root, name))) !== expected) {
      throw new Error(`Build input SHA-256 mismatch: ${name}`);
    }
  }
  await Promise.all(
    ['python/vendor/win32/lib/pywintypes.py', 'bundled/jre/lib/modules', 'bundled/jre/legal'].map((name) =>
      access(join(root, name)),
    ),
  );
}
