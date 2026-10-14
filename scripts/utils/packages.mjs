/**
 * Workspace package discovery for the Huaqiu DSH repo.
 *
 * Single source of truth for "which packages exist here" — every script in
 * `scripts/` should derive its package set from this module instead of keeping
 * its own hardcoded list. A new package dropped into `packages/` is picked up
 * automatically by bump / publish / checks / launch.
 *
 * Discovery is driven by the actual filesystem — each subdirectory of
 * `packages/` that carries a package.json — not by the root manifest or any
 * in-repo enumeration. Subsets are derived from each package's own manifest:
 *
 *   - `publishablePackages()` — everything under `packages/` that is meant for
 *     npm (has a name/version and is not marked `private: true`). The whole
 *     repo is released as one unit, so this is the release set.
 *   - `dshPlugins()` — packages that declare a `dsh` config (i.e. they are
 *     real DSH plugins and can be registered with `dsh plugin add`). The
 *     app/server/utility packages (`component-gen-*`, `dsh-tool-uncollapse`)
 *     ship to npm but are not plugins, so they are excluded here.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to the repository root (two levels up from scripts/lib). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * A discovered package: its path, npm identity and full manifest.
 * @typedef {{
 *   rel: string,
 *   dir: string,
 *   name: string,
 *   version: string,
 *   manifest: Record<string, any>,
 * }} WorkspacePackage
 */

/**
 * Scan `packages/` and return every directory that carries a package.json with
 * a real npm identity. Sorted by directory name for deterministic output.
 * @returns {WorkspacePackage[]}
 */
export function discoverPackages() {
  const packagesDir = join(repoRoot, 'packages')
  let entries
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const rel = entry.name
    const dir = join(packagesDir, rel)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      // Not a package (no parseable package.json) — skip.
      continue
    }
    if (typeof manifest?.name !== 'string' || manifest.name.length === 0) continue
    found.push({
      rel,
      dir,
      name: manifest.name,
      version: String(manifest.version ?? ''),
      manifest,
    })
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** Packages intended for npm — anything under `packages/` that is not private. */
export function publishablePackages() {
  return discoverPackages().filter((p) => p.manifest.private !== true)
}

/** Packages that are real DSH plugins (declare a `dsh` config). */
export function dshPlugins() {
  return discoverPackages().filter((p) => p.manifest.dsh != null)
}

/**
 * Names of the cordis services one plugin entry waits for.
 *
 * Read from the plugin's own `cordis.patch.yml` (every plugin here ships one),
 * which is the manifest DSH actually consumes when it inserts the entry. Both
 * YAML spellings are accepted:
 *
 *   inject: ['hqEdge', 'tools']     ← flow sequence (what the repo uses)
 *   inject:\n  - hqEdge             ← block sequence
 *
 * A tiny targeted scan rather than a YAML dependency: the only thing any
 * caller needs is "is service X in this entry's inject list", and pulling in a
 * parser for one line of config would be a heavier dependency than the answer.
 *
 * @param {WorkspacePackage} pkg
 * @returns {string[]} service names (deduplicated, order preserved)
 */
export function pluginEntryInjects(pkg) {
  let raw
  try {
    raw = readFileSync(join(pkg.dir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return []
  }

  const found = new Set()
  const add = (token) => {
    const name = String(token).trim().replace(/^['"]+|['"]+$/g, '').trim()
    if (name.length > 0) found.add(name)
  }

  for (const match of raw.matchAll(/inject:\s*\[([^\]]*)\]/g)) {
    for (const token of match[1].split(',')) add(token)
  }
  for (const match of raw.matchAll(/inject:[ \t]*\r?\n((?:[ \t]*-[^\r\n]*(?:\r?\n|$))+)/g)) {
    for (const line of match[1].split(/\r?\n/)) add(line.replace(/^\s*-\s*/, ''))
  }

  return [...found]
}

/** Absolute path to the root (private marker) package.json. */
export function rootManifestPath() {
  return join(repoRoot, 'package.json')
}
