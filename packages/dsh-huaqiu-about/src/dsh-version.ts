/**
 * DSH version discovery for the About section.
 *
 * The running harness bundles one DSH installation; the About row wants to
 * display that exact version. We locate it the same way the community
 * `dsh-market` plugin does (`dshHostInfo`): walk up from the CLI entry and
 * read `node_modules/@deepseek-ai/dsh/package.json`. A `require.resolve`
 * probe and the client-build environment variables are the fallbacks.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const DSH_PACKAGE_REL = join('node_modules', '@deepseek-ai', 'dsh', 'package.json')

const require = createRequire(import.meta.url)

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
 * Resolve the DSH version bundled with the running harness.
 *
 * Order: filesystem walk from the CLI entry, then a `require.resolve` probe
 * from this package, then environment fallbacks (`DSH_CLIENT_VERSION` is the
 * client-build metadata variable; `DSH_VERSION` is the hq-edge supervisor
 * convention). Returns null when nothing is locatable.
 */
export function resolveDshVersion(): string | null {
  const entry = process.argv[1]
  const start = entry !== undefined ? dirname(entry) : process.cwd()
  const fromEntry = findDshVersionFrom(start)
  if (fromEntry !== null) return fromEntry

  try {
    const resolved = require.resolve('@deepseek-ai/dsh/package.json')
    const fromRequire = readVersionAt(resolved)
    if (fromRequire !== null) return fromRequire
  } catch {
    // not resolvable from this package — fall through
  }

  return process.env.DSH_CLIENT_VERSION ?? process.env.DSH_VERSION ?? null
}
