import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { pythonPath } from '../src/ipc/python-runtime.js';

const host = vi.hoisted(() => ({ platform: 'win32', execPath: 'C:/KiCad 10/bin/edge-headless/bin/node.exe' }));
vi.mock('node:process', () => ({
  get platform() {
    return host.platform;
  },
  get execPath() {
    return host.execPath;
  },
}));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
const files = new Set<string>();
beforeEach(() => {
  files.clear();
  host.platform = 'win32';
  host.execPath = 'C:/KiCad 10/bin/edge-headless/bin/node.exe';
  vi.mocked(existsSync).mockImplementation((path) => files.has(String(path)));
});
function install(directory: string) {
  for (const file of ['python.exe', 'pcbnew.exe', 'kicad.exe']) {
    files.add(join(directory, file));
  }
}

it('selects an explicit Python path before any host discovery', () => {
  const configured = 'D:/Selected KiCad/bin/python.exe';
  files.add(configured);
  expect(pythonPath(configured)).toBe(configured);
});

it('does not fall back from an invalid explicit path to another installation', () => {
  install('C:/KiCad 10/bin');
  expect(() => pythonPath('D:/missing/python.exe')).toThrow(expect.objectContaining({ code: 'KICAD_PYTHON_MISSING' }));
});

it('finds the KiCad Python belonging to this bundled DSH host', () => {
  install('C:/KiCad 10/bin');
  expect(pythonPath('')).toBe(join('C:/KiCad 10/bin', 'python.exe'));
});

it('requires explicit selection for a standalone DSH and does not guess another KiCad', () => {
  install('C:/KiCad 10/bin');
  host.execPath = 'D:/Node/node.exe';
  expect(() => pythonPath('')).toThrow(expect.objectContaining({ code: 'KICAD_PYTHON_SELECTION_REQUIRED' }));
});

it('does not adopt an unrelated Python adjacent to the DSH executable', () => {
  files.add(join('C:/KiCad 10/bin/edge-headless/bin', 'python.exe'));
  expect(() => pythonPath('')).toThrow(expect.objectContaining({ code: 'KICAD_PYTHON_SELECTION_REQUIRED' }));
});

it('rejects unsupported host platforms', () => {
  host.platform = 'linux';
  expect(() => pythonPath('')).toThrow(expect.objectContaining({ code: 'PLATFORM_UNSUPPORTED' }));
});
