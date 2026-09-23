/**
 * Resolve the DSH version bundled with the running harness.
 *
 * The community `dsh-market` plugin resolves the host version by walking up
 * from the CLI entry for `node_modules/@deepseek-ai/dsh/package.json`. We do
 * the same, plus:
 *   - a workspace checkout whose own `package.json` carries the
 *     `@deepseek-ai/dsh` name (local harness development);
 *   - a `require.resolve` probe;
 *   - environment fallbacks (`DSH_CLIENT_VERSION` / `DSH_VERSION`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const DSH_PACKAGE_REL = join('node_modules', '@deepseek-ai', 'dsh', 'package.json')

function readVersionAt(packageJsonPath: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : null
  } catch {
    return null
  }
}

/** Read `package.json` and return its version when it IS the DSH package. */
function readDshManifestVersionAt(packageJsonPath: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (manifest.name !== '@deepseek-ai/dsh') return null
    return typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : null
  } catch {
    return null
  }
}

/**
 * Walk up from `start` (a directory) looking for the DSH package manifest —
 * either an installed `node_modules/@deepseek-ai/dsh` or a workspace checkout
 * whose own `package.json` carries the `@deepseek-ai/dsh` name. Returns the
 * declared version, or null when no manifest is found.
 */
export function findDshVersionFrom(start: string): string | null {
  let directory = start
  for (let depth = 0; depth < 12; depth += 1) {
    const installed = readVersionAt(join(directory, DSH_PACKAGE_REL))
    if (installed !== null) return installed
    const workspace = readDshManifestVersionAt(join(directory, 'package.json'))
    if (workspace !== null) return workspace
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/**
 * Resolve the DSH version for the current process: walk up from the CLI entry
 * (`process.argv[1]`), then probe `require.resolve('@deepseek-ai/dsh/package.json')`,
 * then environment fallbacks. Returns null when nothing is resolvable.
 */
export function resolveDshVersion(): string | null {
  const entry = typeof process.argv[1] === 'string' ? process.argv[1] : null
  if (entry) {
    const fromEntry = findDshVersionFrom(dirname(resolve(entry)))
    if (fromEntry !== null) return fromEntry
  }
  try {
    const manifestPath = createRequire(import.meta.url).resolve(
      '@deepseek-ai/dsh/package.json',
    )
    if (existsSync(manifestPath)) {
      const version = readVersionAt(manifestPath)
      if (version !== null) return version
    }
  } catch {
    // fall through to environment fallbacks
  }
  const fromEnv = process.env.DSH_CLIENT_VERSION ?? process.env.DSH_VERSION
  return fromEnv && fromEnv.length > 0 ? fromEnv : null
}
