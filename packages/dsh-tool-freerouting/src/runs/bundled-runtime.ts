import { cp, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';

/** The bundled Java 17 launcher cannot locate java.dll from long Windows paths,
 * even when java.exe is spawned with an extended path prefix. Keep the complete
 * shipped runtime in the launcher's owned, short-lived directory in that case. */
export async function prepareBundledRuntime(
  bundled: { javaExe: string; jarPath: string },
  directory: string,
): Promise<{ javaExe: string; jarPath: string; copied: boolean }> {
  if (process.platform !== 'win32' || Math.max(bundled.javaExe.length, bundled.jarPath.length) <= 230) {
    return { ...bundled, copied: false };
  }
  const jre = join(directory, 'jre');
  const javaExe = join(jre, 'bin', 'java.exe');
  const jarPath = join(directory, 'freerouting.jar');
  if (Math.max(javaExe.length, jarPath.length) > 230) {
    throw new UpstreamServiceError(
      'FREEROUTING_RUNTIME_PATH',
      503,
      '布线引擎安装目录和临时目录都过长，请使用较短的临时目录后重试',
    );
  }
  // Copy all JRE files rather than selecting DLLs: its modules, configuration
  // and native libraries must remain the same as the validated package.
  await cp(dirname(dirname(bundled.javaExe)), jre, { recursive: true, errorOnExist: true });
  await copyFile(bundled.jarPath, jarPath);
  return { javaExe, jarPath, copied: true };
}
