#!/usr/bin/env node
/**
 * Workspace-wide version bump for the Huaqiu DSH plugin set.
 *
 * Every package under `packages/` is released as one unit (the repo is public
 * on GitHub), so this script keeps every package.json — plus the private root
 * package.json as a release marker — on the same version, and rewrites the
 * in-workspace `@huaqiu/*` peer/dep references (which are hardcoded like
 * `^0.0.0` / `>=0.3.3` and would otherwise be stale at publish time) to
 * `^<newVersion>`. The package set is discovered from `packages/*`, so new
 * packages are picked up automatically.
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
import { discoverPackages, repoRoot, rootManifestPath } from './utils/packages.mjs'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2) + '\n')

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
  // Manifests to bump: root marker + every discovered package.
  const manifestPaths = [rootManifestPath(), ...pkgs.map((p) => join(p.dir, 'package.json'))]
  // Optional plugin-set release manifest (kept in sync for OTA updates).
  const releaseManifestPath = join(repoRoot, 'plugins-release-manifest.json')

  // Current versions — normally all manifests agree.
  const manifests = manifestPaths.map((path) => ({ path, data: readJson(path) }))
  let releaseManifest
  try {
    releaseManifest = readJson(releaseManifestPath)
  } catch {
    // File missing (e.g. shallow clone / local playground): skip silently.
    releaseManifest = null
  }
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

  // plugins-release-manifest.json — bump pluginSetVersion + every plugin entry.
  if (releaseManifest) {
    const rel = releaseManifestPath.slice(repoRoot.length + 1)
    const changes = {}
    if (releaseManifest.pluginSetVersion && releaseManifest.pluginSetVersion !== next) {
      changes.pluginSetVersion = [releaseManifest.pluginSetVersion, next]
      releaseManifest.pluginSetVersion = next
    }
    const plugins = releaseManifest.plugins || {}
    for (const [name, entry] of Object.entries(plugins)) {
      if (entry && typeof entry === 'object' && entry.version && entry.version !== next) {
        changes[`plugins.${name}.version`] = [entry.version, next]
        entry.version = next
      }
    }
    if (Object.keys(changes).length > 0) plan.push({ rel, changes })
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

  if (releaseManifest) {
    writeJson(releaseManifestPath, releaseManifest)
  }

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

main()
