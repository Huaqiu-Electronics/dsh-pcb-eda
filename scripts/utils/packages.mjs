/**
 * Workspace package + plugin-catalog helpers for the Huaqiu DSH repo.
 *
 * Two different questions are answered here, and they deliberately use
 * different mechanisms:
 *
 *   1. "What is in this workspace?" — filesystem discovery. Every
 *      subdirectory of `packages/` carrying a package.json is a package.
 *      Version bumps, npm publishing and per-package integrity checks must
 *      cover *all* of them, including internal implementation packages, so
 *      `discoverPackages()` / `publishablePackages()` stay automatic.
 *
 *   2. "Which plugins may end users discover/install?" — an explicit,
 *      hardcoded allowlist (`CATALOG_PLUGIN_NAMES`). This list is what feeds
 *      `plugins-release-manifest.json`, which HQ Edge turns into the entries
 *      offered in the plugin-update panel. Auto-discovering it is wrong: most
 *      packages shipped from this repo are implementation details of a
 *      product profile and must never be offered as standalone plugins.
 *      A newly added `dsh` package is NOT catalogued until a human adds its
 *      name here; `unclassifiedDshPlugins()` makes forgetting that a hard
 *      failure in the publish gate.
 *
 *   - `workspaceDshPlugins()` — every DSH plugin package physically present
 *     (filesystem-driven; used by local dev launch and source scanning).
 *   - `dshPlugins()` — the hardcoded catalog allowlist, resolved against the
 *     filesystem for paths/versions (used by the release catalog).
 *   - `internalDshPlugins()` — DSH packages shipped but never user-visible.
 *
 * `dsh.bundle.listedByDefault` remains a real DSH profile signal in the
 * affected package.json files; it is no longer used to derive catalog
 * membership.
 *
 * @typedef {{
 *   rel: string,
 *   dir: string,
 *   name: string,
 *   version: string,
 *   manifest: Record<string, any>,
 * }} WorkspacePackage
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path to the repository root (two levels up from scripts/lib). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The end-user plugin catalog: the ONLY packages offered for install/update
 * through `plugins-release-manifest.json`.
 *
 * HARDCODED ON PURPOSE. HQ Edge iterates `manifest.plugins` to build the
 * plugin-update panel (`computePluginUpdates()`), so every name here is a
 * user-visible, independently installable plugin. Adding a package under
 * `packages/` must never implicitly make it user-discoverable — add the name
 * here explicitly when (and only when) it is a real end-user plugin.
 *
 * Keep in the same alphabetical order as the catalog. Standalone plugins
 * published from other repos (`@huaqiu/dsh-kicad-drc`,
 * `@huaqiu/dsh-tool-freerouting`) are catalog entries too, but have no
 * workspace package, so they are intentionally absent here and resolved from
 * npm by `scripts/release-manifest.mjs`.
 */
export const CATALOG_PLUGIN_NAMES = Object.freeze([
  '@huaqiu/dsh-analytics',
  '@huaqiu/dsh-artifacts',
  '@huaqiu/dsh-auth',
  '@huaqiu/dsh-eda-host',
  '@huaqiu/dsh-eda-selection',
  '@huaqiu/dsh-hqsch',
  '@huaqiu/dsh-huaqiu-about',
  '@huaqiu/dsh-kicad',
  '@huaqiu/dsh-tool-kicad-schematic-gen',
  '@huaqiu/dsh-tool-part-search',
  '@huaqiu/dsh-tool-pcb-viewer',
  '@huaqiu/dsh-tool-plugin-update',
  '@huaqiu/dsh-tool-quote',
  '@huaqiu/dsh-tool-symbol-footprint',
  '@huaqiu/dsh-ui-theme-huaqiu',
])

/**
 * DSH packages shipped from this workspace that must NEVER be offered to end
 * users directly. They are implementation/composition pieces installed as
 * dependencies of a product profile (HQ Edge's Hardware Engineering bundle),
 * not standalone plugins. They are still published and version-bumped like
 * every other package here.
 *
 *   - `@huaqiu/hardware-engineering` — the product bundle itself (also marked
 *     `dsh.bundle.listedByDefault: false`);
 *   - `@huaqiu/hardware-artifacts`  — host-side artifact capability;
 *   - `@huaqiu/dsh-hardware-ui`     — the product's UI shell.
 *
 * Listing them in the catalog would advertise zero-value duplicates / internal
 * surfaces in the plugin-update panel. Classifying them here is what keeps
 * `unclassifiedDshPlugins()` quiet.
 */
export const INTERNAL_DSH_PLUGIN_NAMES = Object.freeze([
  '@huaqiu/hardware-engineering',
  '@huaqiu/hardware-artifacts',
  '@huaqiu/dsh-hardware-ui',
])

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

/**
 * Resolve an explicit name list to workspace package descriptors.
 *
 * Versions, paths and manifests still come from the packages themselves, so
 * the hardcoded lists only decide *membership*, never duplicate package data.
 * A missing name is a hard error: silently dropping a catalog entry would
 * break the release manifest validation in a confusing way.
 */
function resolveNames(names, label) {
  const byName = new Map(discoverPackages().map((p) => [p.name, p]))
  const missing = names.filter((name) => !byName.has(name))
  if (missing.length > 0) {
    throw new Error(
      `${label} lists package(s) not found under packages/: ${missing.join(', ')}. ` +
        'Update the list in scripts/utils/packages.mjs.',
    )
  }
  return names.map((name) => byName.get(name))
}

/** Every DSH plugin package physically present in the workspace (filesystem). */
export function workspaceDshPlugins() {
  return discoverPackages().filter((p) => p.manifest.dsh != null && p.manifest.private !== true)
}

/**
 * The user-visible plugin catalog set — the hardcoded allowlist only.
 * Consumed by the release manifest gate and catalog validation.
 * @returns {WorkspacePackage[]}
 */
export function dshPlugins() {
  return resolveNames(CATALOG_PLUGIN_NAMES, 'CATALOG_PLUGIN_NAMES')
}

/** DSH packages that ship but must never appear in the user-visible catalog. */
export function internalDshPlugins() {
  return resolveNames(INTERNAL_DSH_PLUGIN_NAMES, 'INTERNAL_DSH_PLUGIN_NAMES')
}

/**
 * Newly added DSH packages that nobody has classified yet. The publish gate
 * fails on a non-empty result: every `dsh` package must be explicitly marked
 * as end-user-visible or internal before it can be released.
 */
export function unclassifiedDshPlugins() {
  const classified = new Set([...CATALOG_PLUGIN_NAMES, ...INTERNAL_DSH_PLUGIN_NAMES])
  return workspaceDshPlugins().filter((p) => !classified.has(p.name))
}

/** Backwards-compatible name for the profile-selected product bundle set. */
export function productBundles() {
  return internalDshPlugins().filter(
    (p) => p.manifest.dsh?.bundle?.listedByDefault === false,
  )
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

/** Directory holding the published @huaqiu/dsh-plugin-release-manifest data package. */
export function releaseManifestDir() {
  return join(repoRoot, 'release-manifest')
}

/** Absolute path to one canonical manifest file inside the data package. */
export function canonicalManifestPath(fileName) {
  return join(releaseManifestDir(), fileName)
}

/** npm identity of the canonical release-manifest data package. */
export const RELEASE_MANIFEST_PACKAGE_NAME = '@huaqiu/dsh-plugin-release-manifest'

/**
 * The canonical data package as a publishable package descriptor.
 *
 * It lives outside `packages/*` because it has no build step, but it follows
 * the same lockstep version and is published by `publish:local` after the
 * workspace packages it describes.
 */
export function releaseManifestPackage() {
  const dir = releaseManifestDir()
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (manifest?.name !== RELEASE_MANIFEST_PACKAGE_NAME) {
    throw new Error(`release-manifest/package.json name must be ${RELEASE_MANIFEST_PACKAGE_NAME}`)
  }
  return {
    rel: 'release-manifest',
    dir,
    name: manifest.name,
    version: String(manifest.version ?? ''),
    manifest,
  }
}
