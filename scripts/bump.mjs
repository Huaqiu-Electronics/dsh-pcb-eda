#!/usr/bin/env node
/**
 * Workspace-wide version bump for the Huaqiu DSH plugin set.
 *
 * Every package under `packages/` is released as one unit (the repo is public
 * on GitHub), so this script keeps every package.json — plus the private root
 * package.json as a release marker — on the same version, and rewrites the
 * in-workspace `@huaqiu/*` peer/dep references (which are hardcoded like
 * `^0.0.0` / `>=0.3.3` and would otherwise be stale at publish time) to
 * `^<newVersion>`. The canonical data package in `release-manifest/` follows
 * the same version: its package.json and the `manifestPackageVersion` stamp
 * in both published catalogs are bumped here, while plugin-set data is
 * updated separately by `scripts/release-manifest.mjs`. The package set is
 * discovered from `packages/*`, so new packages are picked up automatically
 * for versioning/publishing. That does NOT make them end-user plugins: catalog
 * membership is the explicit allowlist in `scripts/utils/packages.mjs`.
 *
 * Usage:
 *   node scripts/bump.mjs [major|minor|patch]   # semver bump
 *   node scripts/bump.mjs 0.3.1                 # explicit version
 *
 * Always applies: prints every change, writes the files, refreshes the
 * lockfile, and prints the git commands for tagging the release.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalManifestPath,
  discoverPackages,
  releaseManifestDir,
  repoRoot,
  rootManifestPath,
} from './utils/packages.mjs'

export const RELEASE_MANIFEST_PATH = canonicalManifestPath('plugins-release-manifest.json')
export const EDGE_HEADLESS_MANIFEST_PATH = canonicalManifestPath('edge-headless-release-manifest.json')
export const RELEASE_MANIFEST_PACKAGE_PATH = join(releaseManifestDir(), 'package.json')

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2) + '\n')

/**
 * Apply a workspace version bump to the canonical plugin release catalog.
 *
 * The release-manifest npm package follows the lockstep workspace version, so
 * `manifestPackageVersion` is stamped with the same target. This also moves
 * the plugin-set identity and the versions of plugins actually released from
 * this workspace. Standalone plugin data is untouched; edge-headless releases
 * are stamped by {@link applyManifestVersionStamp} without changing versions.
 */
export function applyReleaseManifestBump(
  catalog,
  next,
  siblingNames,
  now = new Date().toISOString(),
  manifestVersion = next,
) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('canonical plugin release manifest must be an object')
  }
  const changes = applyManifestVersionStamp(catalog, manifestVersion)
  if (catalog.pluginSetVersion && catalog.pluginSetVersion !== next) {
    changes.pluginSetVersion = [catalog.pluginSetVersion, next]
    catalog.pluginSetVersion = next
  }
  if (catalog.release && typeof catalog.release === 'object' && catalog.release.publishedAt !== undefined) {
    changes['release.publishedAt'] = [catalog.release.publishedAt, now]
    catalog.release.publishedAt = now
  }
  const plugins = catalog.plugins && typeof catalog.plugins === 'object' ? catalog.plugins : {}
  catalog.plugins = plugins
  for (const name of siblingNames) {
    const entry = plugins[name]
    if (typeof entry === 'string') {
      if (entry !== next) {
        changes[`plugins.${name}`] = [entry, next]
        plugins[name] = next
      }
    } else if (entry && typeof entry === 'object' && typeof entry.version === 'string' && entry.version !== next) {
      changes[`plugins.${name}.version`] = [entry.version, next]
      entry.version = next
    }
  }
  return changes
}

/** Stamp a published catalog with the canonical package version. */
export function applyManifestVersionStamp(catalog, manifestVersion) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('canonical manifest must be an object')
  }
  if (typeof manifestVersion !== 'string' || manifestVersion.length === 0) {
    throw new Error('manifestVersion must be a version string')
  }
  if (catalog.manifestPackageVersion === manifestVersion) return {}
  const previous = catalog.manifestPackageVersion
  catalog.manifestPackageVersion = manifestVersion
  return { manifestPackageVersion: [previous, manifestVersion] }
}

function semverBump(current, kind) {
  const parts = String(current).split('.').map((n) => parseInt(n, 10) || 0)
  if (kind === 'major') { parts[0] += 1; parts[1] = 0; parts[2] = 0 }
  else if (kind === 'minor') { parts[1] += 1; parts[2] = 0 }
  else if (kind === 'patch') { parts[2] += 1 }
  else throw new Error(`unknown bump kind: ${kind} (expected major|minor|patch)`)
  return parts.join('.')
}

function main() {
  const argv = process.argv.slice(2)
  const positional = argv.filter((a) => !a.startsWith('-'))
  if (positional.length !== 1) {
    console.error('usage: node scripts/bump.mjs [major|minor|patch|<version>]')
    process.exit(1)
  }
  const target = positional[0]

  // Discovered package set — every publishable package under packages/.
  const pkgs = discoverPackages().filter((p) => p.manifest.private !== true)
  if (pkgs.length === 0) {
    console.error('FATAL: no packages discovered under packages/')
    process.exit(1)
  }
  // Sibling @huaqiu packages that must be rewritten when the version moves.
  const SIBLING_NAMES = pkgs.map((p) => p.name)
  // Manifests to bump: root marker + every discovered package. The canonical
  // data package and both published catalogs follow this lockstep bump too;
  // they are handled separately because they live outside packages/*.
  const manifestPaths = [rootManifestPath(), ...pkgs.map((p) => join(p.dir, 'package.json'))]

  // Current versions — normally all manifests agree.
  const manifests = manifestPaths.map((path) => ({ path, data: readJson(path) }))
  const versions = new Set(manifests.map((m) => m.data.version).filter(Boolean))
  const explicit = /^\d+\.\d+\.\d+/.test(target)
  let current
  if (versions.size === 1) {
    current = [...versions][0]
  } else if (explicit) {
    // Out-of-sync workspace (e.g. part-search already published at 0.1.0
    // while the others are at 0.0.0): an explicit version force-resyncs all.
    current = `out-of-sync (${[...versions].join(', ')})`
    console.warn(`warn: workspace versions out of sync (${[...versions].join(', ')}) — resyncing all to ${target}`)
  } else {
    console.error(`FATAL: workspace versions are out of sync (${[...versions].join(', ')}).`)
    console.error('Pass an explicit version to force-resync, e.g.  node scripts/bump.mjs 0.1.0')
    process.exit(1)
  }
  const next = explicit ? target : semverBump(current, target)
  console.log(`bump: ${current} → ${next}\n`)

  // Canonical data package: its npm version and both manifest stamps move
  // with the lockstep workspace version; plugin-set data follows below.
  const canonicalPackage = readJson(RELEASE_MANIFEST_PACKAGE_PATH)
  const releaseManifest = readJson(RELEASE_MANIFEST_PATH)
  const edgeHeadlessManifest = readJson(EDGE_HEADLESS_MANIFEST_PATH)
  const releaseChanges = applyReleaseManifestBump(releaseManifest, next, SIBLING_NAMES)
  const edgeHeadlessChanges = applyManifestVersionStamp(edgeHeadlessManifest, next)
  const releaseRel = RELEASE_MANIFEST_PATH.slice(repoRoot.length + 1)
  const edgeHeadlessRel = EDGE_HEADLESS_MANIFEST_PATH.slice(repoRoot.length + 1)
  const canonicalPackageRel = RELEASE_MANIFEST_PACKAGE_PATH.slice(repoRoot.length + 1)

  const plan = []
  for (const { path, data } of manifests) {
    const rel = path.slice(repoRoot.length + 1)
    const changes = { version: [data.version, next] }
    // Rewrite in-workspace @huaqiu/* references in dep maps (keep workspace:).
    for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const map = data[depKey]
      if (!map || typeof map !== 'object') continue
      for (const name of Object.keys(map)) {
        if (!SIBLING_NAMES.includes(name)) continue
        if (map[name] === 'workspace:*') continue
        const oldRange = map[name]
        if (oldRange !== `^${next}`) changes[`${depKey}.${name}`] = [oldRange, `^${next}`]
      }
    }
    if (Object.keys(changes).length > 0) plan.push({ rel, changes })
  }
  const canonicalPackageChanges =
    canonicalPackage.version === next ? {} : { version: [canonicalPackage.version, next] }
  if (Object.keys(canonicalPackageChanges).length > 0) {
    plan.push({ rel: canonicalPackageRel, changes: canonicalPackageChanges })
  }
  if (Object.keys(releaseChanges).length > 0) plan.push({ rel: releaseRel, changes: releaseChanges })
  if (Object.keys(edgeHeadlessChanges).length > 0) {
    plan.push({ rel: edgeHeadlessRel, changes: edgeHeadlessChanges })
  }

  if (plan.length === 0) {
    console.log('  (no changes — every manifest is already on the target version)')
  }
  for (const { rel, changes } of plan) {
    console.log(`  ${rel}`)
    for (const [key, [oldV, newV]] of Object.entries(changes)) {
      console.log(`    ${key}: ${oldV} → ${newV}`)
    }
  }
  console.log('')

  for (const { path, data } of manifests) {
    if (data.version) data.version = next
    for (const depKey of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const map = data[depKey]
      if (!map || typeof map !== 'object') continue
      for (const name of Object.keys(map)) {
        if (!SIBLING_NAMES.includes(name) || map[name] === 'workspace:*') continue
        map[name] = `^${next}`
      }
    }
    writeJson(path, data)
  }
  if (Object.keys(canonicalPackageChanges).length > 0) {
    canonicalPackage.version = next
    writeJson(RELEASE_MANIFEST_PACKAGE_PATH, canonicalPackage)
  }
  if (Object.keys(releaseChanges).length > 0) writeJson(RELEASE_MANIFEST_PATH, releaseManifest)
  if (Object.keys(edgeHeadlessChanges).length > 0) writeJson(EDGE_HEADLESS_MANIFEST_PATH, edgeHeadlessManifest)

  // Refresh pnpm-lock.yaml so `--frozen-lockfile` CI stays green.
  console.log('\nrefreshing lockfile (pnpm install --no-frozen-lockfile)…')
  execFileSync('pnpm', ['install', '--no-frozen-lockfile'], { cwd: repoRoot, stdio: 'inherit' })

  console.log(`\nNext steps (tag MUST match package.json version):`)
  console.log(`  git add -A`)
  console.log(`  git commit -m "chore: release v${next}"`)
  console.log(`  git tag v${next}`)
  console.log(`  git push origin main --tags`)
  console.log(`\nThe push of tag v${next} triggers .github/workflows/release.yml.`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
