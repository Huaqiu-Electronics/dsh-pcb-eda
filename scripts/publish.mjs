#!/usr/bin/env node
/**
 * Publish the Huaqiu DSH package set to npm.
 *
 * Follows the community release patterns (dsh-openpencil `publish-release.mjs`
 * + DSH-better-sidebar `release.yml`): validate the shared version, run the
 * full gate, then publish every package in dependency order with idempotency —
 * a version already on npm is skipped, never re-published.
 *
 * The workspace packages are discovered from `packages/*`. The canonical data
 * package in `release-manifest/` is appended LAST: its catalogs describe the
 * exact versions of the packages that were just published. Both must be on
 * the same lockstep version.
 *
 * Usage:
 *   node scripts/publish.mjs [--dry-run] [--provenance] [--tag vX.Y.Z]
 *
 *   --dry-run     build + pack + check only; never touches npm
 *   --provenance  pnpm publish --provenance (npm Trusted Publishing / OIDC)
 *   --tag vX.Y.Z  require every package version to equal X.Y.Z
 *
 * Auth: npmjs OIDC (set registry-url + id-token in CI) or NODE_AUTH_TOKEN.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publishablePackages, releaseManifestPackage, repoRoot } from './utils/packages.mjs'

export function parsePublishArgs(argv = process.argv.slice(2)) {
  const tagIndex = argv.indexOf('--tag')
  const tagArg = argv.find((a) => a.startsWith('--tag='))?.split('=')[1]
    ?? (tagIndex >= 0 ? argv[tagIndex + 1] : undefined)
  return {
    dryRun: argv.includes('--dry-run'),
    provenance: argv.includes('--provenance'),
    tagArg,
  }
}

// On Windows, npm/pnpm are installed as `.cmd`/`.ps1` shims (no `.exe`), which
// `execFileSync` cannot launch without a shell — it throws `spawnSync ... ENOENT`.
// Running through the shell fixes that; Node quotes any args containing spaces.
const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? repoRoot, shell: process.platform === 'win32', ...opts })
}

/**
 * Order the discovered packages so that `dependencies` (in-workspace siblings)
 * are published before their consumers. Leaves-first topological sort; falls
 * back to alphabetical order when a dependency cycle exists among
 * `dependencies` (should not happen — peer/dev cycles are ignored by design).
 */
export function topoOrder(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]))
  const names = new Set(byName.keys())
  const order = []
  const state = new Map() // name -> 'visiting' | 'done'
  const visit = (name, chain) => {
    const st = state.get(name)
    if (st === 'done') return
    if (st === 'visiting') throw new Error(`dependency cycle among publishable packages: ${[...chain, name].join(' → ')}`)
    state.set(name, 'visiting')
    const pkg = byName.get(name)
    if (pkg) {
      const deps = pkg.manifest.dependencies ?? {}
      for (const dep of Object.keys(deps)) {
        if (names.has(dep)) visit(dep, [...chain, name])
      }
    }
    state.set(name, 'done')
    order.push(name)
  }
  for (const name of names) {
    try {
      visit(name, [])
    } catch (err) {
      console.warn(`warn: ${err.message} — falling back to alphabetical order`)
      return pkgs.slice().sort((a, b) => a.name.localeCompare(b.name))
    }
  }
  return order.map((name) => byName.get(name))
}

/**
 * Build the ordered publication set. The canonical data package is always
 * last so it can only ever describe already-published plugin versions.
 */
export function buildPublicationPlan(argv = process.argv.slice(2), deps = {}) {
  const opts = parsePublishArgs(argv)
  const pkgs = deps.publishablePackages ? deps.publishablePackages() : publishablePackages()
  if (pkgs.length === 0) {
    throw new Error('no publishable packages discovered under packages/')
  }
  const canonical = deps.releaseManifestPackage ? deps.releaseManifestPackage() : releaseManifestPackage()
  const versions = new Set([...pkgs.map((p) => p.version), canonical.version])
  if (versions.size !== 1) {
    throw new Error(`package versions out of sync: ${[...versions].join(', ')}`)
  }
  const version = canonical.version
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`invalid canonical package version: ${version}`)
  }
  return {
    ...opts,
    version,
    workspaceCount: pkgs.length,
    plan: [...topoOrder(pkgs), canonical],
  }
}

export function publishPlan({ plan, version, dryRun, provenance, tagArg }) {
  // ── 1. Version validation ────────────────────────────────────────────────
  if (tagArg) {
    run('node', ['scripts/check-release-version.mjs', version, '--tag', tagArg])
  } else {
    run('node', ['scripts/check-release-version.mjs', version])
  }
  console.log(`\nPublishing ${plan.map((p) => p.name).join(', ')} @${version} (${dryRun ? 'DRY-RUN' : 'LIVE'})`)

  // ── 2. Gate: build + integrity ───────────────────────────────────────────
  run('pnpm', ['-r', 'build'])
  run('node', ['scripts/check-publish.mjs'])

  // ── 3. Publish (dependency order, idempotent) ────────────────────────────
  for (const pkg of plan) {
    // Skip if this exact version is already on the registry (idempotent).
    if (!dryRun) {
      try {
        const existing = execFileSync('npm', ['view', `${pkg.name}@${version}`, 'version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: process.platform === 'win32',
        }).trim()
        if (existing.length > 0) {
          console.log(`\nskip ${pkg.name}@${version} — already published`)
          continue
        }
      } catch {
        /* not found → publish */
      }
    }

    run('pnpm', ['--dir', pkg.dir, 'pack', '--pack-destination', join(repoRoot, 'dist')])
    if (dryRun) {
      console.log(`\n[dry-run] would publish ${pkg.name}@${version}`)
      continue
    }

    const args = ['--dir', pkg.dir, 'publish', '--no-git-checks', '--access', 'public']
    if (provenance) args.push('--provenance')
    const registry = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
    if (registry) args.push('--registry', registry)
    run('pnpm', args)
    console.log(`✓ published ${pkg.name}@${version}`)
  }

  console.log(`\nDone. ${plan.length} package(s) @${version} ${dryRun ? 'validated (nothing published)' : 'published'}.`)
}

export function main(argv = process.argv.slice(2)) {
  const publish = buildPublicationPlan(argv)
  publishPlan(publish)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main()
}
