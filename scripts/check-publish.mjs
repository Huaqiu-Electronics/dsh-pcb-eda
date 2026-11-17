#!/usr/bin/env node
/**
 * Pre-publish integrity gate for the Huaqiu DSH package set (workspace-wide).
 *
 * Adapted from the community pattern (dsh-git-worktree `check-publish.mjs`):
 * validates every publishable package under `packages/` — the built entry +
 * client bundle exist, exports resolve, no `@hqedge/*` reference survives
 * anywhere, and, for real DSH plugins (packages declaring a `dsh` config), that
 * the Host mount patch is declared and actually shipped in `files`.
 * `--require-clean` additionally demands a clean git tree (used by release CI
 * so the tarball is built from exactly what was reviewed).
 *
 * Usage:
 *   node scripts/check-publish.mjs [--require-clean]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  publishablePackages,
  dshPlugins,
  pluginEntryInjects,
  repoRoot,
  canonicalManifestPath,
  releaseManifestPackage,
} from './utils/packages.mjs'
import {
  validateEdgeHeadlessManifest,
  validateReleaseManifest,
} from './utils/manifest-validation.mjs'

const requireClean = process.argv.includes('--require-clean')

let failures = 0
const fail = (msg) => { console.error(`check-publish: FAIL: ${msg}`); failures += 1 }
const ok = (msg) => console.log(`check-publish: ok: ${msg}`)

function includedByFiles(manifest, target) {
  const normalized = String(target).replace(/^\.\//, '').replaceAll('\\', '/')
  if (normalized === 'package.json') return true
  return (manifest.files ?? []).some((entry) => {
    const e = String(entry).replace(/^\.\//, '').replaceAll('\\', '/').replace(/\/$/, '')
    return normalized === e || normalized.startsWith(`${e}/`)
  })
}

// 1. Clean-tree guard (release lane only).
if (requireClean) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    if (status.length > 0) fail(`git tree is not clean — release must be built from a tagged, committed state:\n${status}`)
    else ok('git tree is clean')
  } catch (e) {
    fail(`could not read git status: ${String(e?.message || e)}`)
  }
}

// 2. Per-package integrity (discovered set).
const pkgs = publishablePackages()
if (pkgs.length === 0) {
  fail('no publishable packages discovered under packages/')
} else {
  ok(`discovered ${pkgs.length} publishable package(s): ${pkgs.map((p) => p.rel).join(', ')}`)
}
for (const pkg of pkgs) {
  const { rel, dir, name, version, manifest } = pkg
  const pj = join(dir, 'package.json')

  if (name !== `@huaqiu/${rel}`) {
    fail(`${rel}: name must be "@huaqiu/${rel}" (got "${name}")`)
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    fail(`${rel}: invalid version ${version}`)
  }

  // Host mount patch — only real DSH plugins declare dsh.bundle.patch.
  const isPlugin = manifest.dsh != null
  if (isPlugin) {
    const patchRel = manifest.dsh?.bundle?.patch
    if (typeof patchRel !== 'string' || patchRel.length === 0) {
      fail(`${rel}: dsh.bundle.patch is missing`)
    } else {
      if (!existsSync(join(dir, patchRel))) fail(`${rel}: dsh.bundle.patch file missing (${patchRel})`)
      if (!includedByFiles(manifest, patchRel)) fail(`${rel}: ${patchRel} is not covered by files[] (it must ship in the tarball)`)
    }
  } else {
    ok(`${rel}: not a dsh plugin — skipping Host patch checks`)
  }

  // Built entry (node half).
  const mainRel = manifest.main || 'lib/index.mjs'
  if (!existsSync(join(dir, mainRel))) fail(`${rel}: built entry missing (${mainRel}) — run pnpm -r build first`)
  const typesRel = manifest.types || 'lib/index.d.mts'
  if (!existsSync(join(dir, typesRel))) fail(`${rel}: built types missing (${typesRel})`)

  // Client bundle (dual-face packages).
  if (manifest.dsh?.client && !existsSync(join(dir, 'lib/client.js'))) {
    fail(`${rel}: dsh.client is declared but lib/client.js is missing`)
  }

  // Exports resolve to shipped files.
  if (manifest.exports && typeof manifest.exports === 'object') {
    const seen = new Set()
    const targets = []
    const collect = (o) => {
      for (const [cond, v] of Object.entries(o)) {
        if (typeof v === 'string') { targets.push([cond, v]); continue }
        if (v && typeof v === 'object') collect(v)
        else fail(`${rel}: malformed exports.${cond}`)
      }
    }
    collect(manifest.exports)
    for (const [cond, target] of targets) {
      if (seen.has(target)) continue
      seen.add(target)
      if (target === 'package.json') continue
      if (!includedByFiles(manifest, target)) fail(`${rel}: exports.${cond} → ${target} is not covered by files[]`)
      // Glob subpath exports (e.g. `./dist/*`) resolve to any file under the
      // base dir — verify the base dir ships rather than the literal pattern.
      const globIdx = target.indexOf('*')
      if (globIdx >= 0) {
        const base = target.slice(0, globIdx).replace(/\/+$/, '')
        if (!existsSync(join(dir, base))) fail(`${rel}: exports.${cond} → ${target}: base dir ${base} does not exist`)
      } else if (!existsSync(join(dir, target))) {
        fail(`${rel}: exports.${cond} → ${target} does not exist`)
      }
    }
  }

  ok(`@huaqiu/${rel} v${version} — entry/types/exports/patch/clean`)
}

// The canonical data package is published by `publish:local` in the same
// release, so it must carry the same lockstep version and stamp every catalog
// with it. `pnpm bump` is responsible for keeping these aligned.
let canonicalPackage = null
try {
  canonicalPackage = releaseManifestPackage()
  ok(`${canonicalPackage.name} v${canonicalPackage.version} discovered`)
} catch (e) {
  fail(`release-manifest/package.json is missing or invalid: ${String(e?.message || e)}`)
}
if (canonicalPackage && pkgs.length > 0) {
  const workspaceVersions = new Set(pkgs.map((p) => p.version))
  if (workspaceVersions.size === 1) {
    const workspaceVersion = [...workspaceVersions][0]
    if (canonicalPackage.version !== workspaceVersion) {
      fail(
        `${canonicalPackage.name} version ${canonicalPackage.version} does not match workspace version ${workspaceVersion} — run pnpm bump`,
      )
    }
  } else {
    fail(`workspace versions are out of sync (${[...workspaceVersions].join(', ')})`)
  }
}

// 3. Canonical release manifests in @huaqiu/dsh-plugin-release-manifest —
//    the machine-readable source of truth for plugin discovery and HQ Edge
//    headless versions. They must never drift from the actual publishable
//    set, the lockstep version, or the plugin patch contracts
//    (`requiresHqEdge` == inject contains `hqEdge`). HQ Edge build pins are
//    owned by the hq-edge repo and are not published here.
const readCanonical = (file, validator, ctx) => {
  let value = null
  try {
    value = JSON.parse(readFileSync(canonicalManifestPath(file), 'utf8'))
    ok(`${file} parsed`)
  } catch (e) {
    fail(`${file} is missing or not valid JSON: ${String(e?.message || e)}`)
    return
  }
  const failures = validator(value, ctx)
  if (canonicalPackage && value.manifestPackageVersion !== canonicalPackage.version) {
    failures.push(
      `${file}: manifestPackageVersion ${JSON.stringify(value.manifestPackageVersion)} does not match ` +
        `${canonicalPackage.name}@${canonicalPackage.version}`,
    )
  }
  for (const message of failures) fail(message)
  if (failures.length === 0) ok(`${file}: validated`)
  return value
}

const canonicalPlugins = readCanonical('plugins-release-manifest.json', validateReleaseManifest, {
  dshPlugins: dshPlugins(),
  pluginEntryInjects,
})
readCanonical('edge-headless-release-manifest.json', validateEdgeHeadlessManifest)
if (canonicalPlugins) {
  ok(`plugins-release-manifest.json: ${Object.keys(canonicalPlugins.plugins ?? {}).length} plugin entrie(s)`)
}

if (failures > 0) {
  console.error(`\ncheck-publish: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-publish: all packages OK')
