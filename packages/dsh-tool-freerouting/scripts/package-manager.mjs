import { execa } from 'execa';
import { basename, extname } from 'node:path';
import process from 'node:process';

// Both the workspace's pnpm lifecycle and an isolated npm lifecycle are supported.
// npm_execpath can name a compiled pnpm.exe, which must not be passed to Node as JS.
export function usesPnpm() {
  return basename(packageManagerEntry()).toLowerCase().includes('pnpm');
}

function packageManagerEntry() {
  const entry = process.env.npm_execpath;
  if (!entry) {
    throw new Error('Run this packaging check through pnpm run or npm run');
  }
  return entry;
}

export function runPackageManager(args, options) {
  const entry = packageManagerEntry();
  const native = extname(entry).toLowerCase() === '.exe';
  return execa(native ? entry : process.execPath, native ? args : [entry, ...args], {
    ...options,
    windowsHide: true,
  });
}
