import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execPath, platform } from 'node:process';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';

/** Select once; cleanup keeps this executable after the editor exits. */
export function pythonPath(configured: string): string {
  if (platform !== 'win32') {
    throw new UpstreamServiceError('PLATFORM_UNSUPPORTED', 400, '首期仅支持 Windows');
  }
  if (configured) {
    if (!existsSync(configured)) {
      throw new UpstreamServiceError('KICAD_PYTHON_MISSING', 503, '配置的 KiCad Python 不存在');
    }
    return configured;
  }

  // Bundled DSH runs below KiCad's bin directory. Search only its own ancestry;
  // never guess another installation from PATH, the current folder or processes.
  let directory = dirname(execPath);
  for (let depth = 0; depth < 4; depth += 1) {
    const python = join(directory, 'python.exe');
    if (existsSync(join(directory, 'pcbnew.exe')) && existsSync(join(directory, 'kicad.exe')) && existsSync(python)) {
      return python;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new UpstreamServiceError(
    'KICAD_PYTHON_SELECTION_REQUIRED',
    503,
    '未找到此 DSH 所属的 KiCad Python；请将 kicadPythonPath 设置为所用 KiCad 10 的 bin/python.exe',
  );
}
