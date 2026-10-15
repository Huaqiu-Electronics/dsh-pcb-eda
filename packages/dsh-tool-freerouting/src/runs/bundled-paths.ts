import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Resolve paths for bundled JRE and JAR */
export function getBundledPaths(): { javaExe: string; jarPath: string } {
  // Current file is in lib/ or src/runs/, bundled/ is at package root
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Try multiple possible locations for the bundled directory
  const candidate1 = join(currentDir, '..', 'bundled');
  const candidate2 = join(currentDir, '..', '..', 'bundled');

  // Check first candidate
  const javaExe1 = join(candidate1, 'jre', 'bin', 'java.exe');
  const jarPath1 = join(candidate1, 'freerouting.jar');
  if (existsSync(javaExe1) && existsSync(jarPath1)) {
    return { javaExe: javaExe1, jarPath: jarPath1 };
  }

  // Check second candidate
  const javaExe2 = join(candidate2, 'jre', 'bin', 'java.exe');
  const jarPath2 = join(candidate2, 'freerouting.jar');
  if (existsSync(javaExe2) && existsSync(jarPath2)) {
    return { javaExe: javaExe2, jarPath: jarPath2 };
  }

  // Fallback to first candidate (will fail with clear error)
  return { javaExe: javaExe1, jarPath: jarPath1 };
}

/** Check if bundled resources exist */
export function hasBundledResources(): boolean {
  const { javaExe, jarPath } = getBundledPaths();
  return (
    existsSync(javaExe) &&
    existsSync(jarPath) &&
    existsSync(join(dirname(dirname(javaExe)), 'lib', 'jvm.cfg')) &&
    existsSync(join(dirname(dirname(javaExe)), 'lib', 'modules'))
  );
}
