#!/usr/bin/env node
/**
 * Manually invoked release command for the canonical DSH plugin catalog.
 *
 * This script is NOT a CI step. An operator runs it after publishing plugin
 * artifacts, and publishes the resulting manifest package as the final step
 * of the release. It:
 *
 *   1. reads the current canonical catalog from npm (or --bootstrap),
 *   2. preserves every published entry (including standalone plugins),
 *   3. resolves standalone versions independently from npm,
 *   4. verifies each newly published artifact (tarball + sha512 integrity),
 *   5. re-checks dist-tags to guard against a concurrent manual release,
 *   6. writes the plugin, edge-headless and HQ Edge build manifests, and
 *   7. publishes the immutable manifest version only with --publish.
 *
 * Dry-run is the default. Nothing is published unless --publish is given.
 *
 * Usage:
 *   node scripts/release-manifest.mjs [--bootstrap] [--candidates-file F]
 *       [--candidate name@version] [--set-version X.Y.Z]
 *       [--registry URL] [--mirror URL] [--publish]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dshPlugins, pluginEntryInjects, repoRoot } from './utils/packages.mjs'
import {
  validateEdgeHeadlessManifest,
  validateHqEdgeBuildManifest,
  validateReleaseManifest,
} from './utils/manifest-validation.mjs'

export const MANIFEST_PACKAGE = '@huaqiu/dsh-plugin-release-manifest'
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_MIRROR = 'https://registry.npmmirror.com'
export const DEFAULT_JSDELIVR = 'https://cdn.jsdelivr.net/npm'
export const DEFAULT_FASTLY_JSDELIVR = 'https://fastly.jsdelivr.net/npm'
export const CATALOG_FILE = 'plugins-release-manifest.json'
export const EDGE_HEADLESS_FILE = 'edge-headless-release-manifest.json'
export const BUILD_MANIFEST_FILE = 'hq-edge-build-manifest.json'
export const CANONICAL_FILES = [CATALOG_FILE, EDGE_HEADLESS_FILE, BUILD_MANIFEST_FILE]
export const MANIFEST_DIR = join(repoRoot, 'release-manifest')

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// ── Small network helpers (injectable for tests) ────────────────────────────

export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value)
}

export async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-release-manifest/1' },
  })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.json()
}

function encoded(name) {
  return encodeURIComponent(name).replace(/%40/i, '@')
}

/** Resolve the canonical catalog version from authoritative metadata. */
export async function resolveCanonicalVersion({
  fetchImpl = fetch,
  packageName = MANIFEST_PACKAGE,
  registry = DEFAULT_REGISTRY,
  mirror = DEFAULT_MIRROR,
  bootstrapVersion = undefined,
} = {}) {
  const endpoints = [
    `${registry.replace(/\/$/, '')}/-/package/${encoded(packageName)}/dist-tags`,
    `${mirror.replace(/\/$/, '')}/-/package/${encoded(packageName)}/dist-tags`,
  ]
  const errors = []
  for (const url of endpoints) {
    try {
      const tags = await fetchJson(fetchImpl, url)
      const version = tags?.latest
      if (!isSemver(version)) throw new Error(`invalid dist-tags.latest: ${JSON.stringify(version)}`)
      return { version, source: url }
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (bootstrapVersion !== undefined) {
    if (!isSemver(bootstrapVersion)) throw new Error(`invalid --bootstrap version: ${bootstrapVersion}`)
    return { version: bootstrapVersion, source: 'bootstrap' }
  }
  throw new Error(`cannot resolve canonical manifest version (${errors.join('; ')})`)
}

/**
 * Fetch exact-version catalog JSON from a CDN endpoint. The version is never
 * resolved here — callers pass the already resolved version so mirrors cannot
 * mix release states.
 */
export async function fetchCatalogFromCdn({
  fetchImpl = fetch,
  base,
  version,
  packageName = MANIFEST_PACKAGE,
  file = CATALOG_FILE,
} = {}) {
  if (!isSemver(version)) throw new Error(`invalid manifest version: ${version}`)
  const url = `${base.replace(/\/$/, '')}/${packageName}@${version}/${file}`
  const catalog = await fetchJson(fetchImpl, url)
  return { catalog, url }
}

/** Default npm-tarball delivery fallback (no npm package dependency). */
export async function loadCatalogFromNpmTarball({
  version,
  packageName = MANIFEST_PACKAGE,
  registry = DEFAULT_REGISTRY,
  cwd = repoRoot,
  file = CATALOG_FILE,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-manifest-'))
  try {
    const tarballName = `${packageName.split('/').pop()}-${version}.tgz`
    execFileSync('npm', ['pack', `${packageName}@${version}`, '--pack-destination', dir, '--silent'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_registry: registry },
    })
    const tarballPath = join(dir, tarballName)
    if (!existsSync(tarballPath)) throw new Error(`npm pack did not produce ${tarballName}`)
    const raw = execFileSync('tar', ['-xzOf', tarballPath, `package/${file}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(raw)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Load the published catalog for an exact version. Every endpoint must serve
 * a JSON document whose `manifestPackageVersion` equals that version; a
 * mirror serving an older catalog is rejected, never silently accepted.
 */
export async function loadPublishedCatalog({
  fetchImpl = fetch,
  version,
  packageName = MANIFEST_PACKAGE,
  registry = DEFAULT_REGISTRY,
  mirror = DEFAULT_MIRROR,
  jsdelivr = DEFAULT_JSDELIVR,
  fastlyJsdelivr = DEFAULT_FASTLY_JSDELIVR,
  loadFromTarball = loadCatalogFromNpmTarball,
  file = CATALOG_FILE,
} = {}) {
  const errors = []
  const tryCandidate = async (label, load) => {
    try {
      const catalog = await load()
      if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
        throw new Error('catalog is not an object')
      }
      if (catalog.manifestPackageVersion !== version) {
        throw new Error(
          `version mismatch: endpoint served manifestPackageVersion=${JSON.stringify(catalog.manifestPackageVersion)}, expected ${version}`,
        )
      }
      return { catalog, source: label }
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  for (const [label, base] of [
    ['jsdelivr', jsdelivr],
    ['fastly-jsdelivr', fastlyJsdelivr],
  ]) {
    const result = await tryCandidate(label, () =>
      fetchCatalogFromCdn({ fetchImpl, base, version, packageName, file }).then((r) => r.catalog),
    )
    if (result) return result
  }
  const tarball = await tryCandidate('npm-tarball', () =>
    loadFromTarball({ version, packageName, registry, file }),
  )
  if (tarball) return tarball
  throw new Error(`cannot load canonical manifest@${version} (${errors.join('; ')})`)
}

/** Resolve one package's published version; primary registry wins. */
async function publishedVersion(fetchImpl, name, registry, mirror) {
  const errors = []
  for (const base of [registry, mirror]) {
    const url = `${base.replace(/\/$/, '')}/-/package/${encoded(name)}/dist-tags`
    try {
      const tags = await fetchJson(fetchImpl, url)
      if (!isSemver(tags?.latest)) throw new Error(`invalid dist-tags.latest: ${JSON.stringify(tags?.latest)}`)
      return tags.latest
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`cannot resolve ${name} from npm (${errors.join('; ')})`)
}

/**
 * Standalone plugin versions come from their own npm publications, never from
 * this monorepo's version bump.
 */
export async function resolveStandaloneVersions({
  fetchImpl = fetch,
  names = [],
  registry = DEFAULT_REGISTRY,
  mirror = DEFAULT_MIRROR,
} = {}) {
  const result = {}
  for (const name of names) {
    result[name] = await publishedVersion(fetchImpl, name, registry, mirror)
  }
  return result
}

/** Verify a published artifact: HTTPS tarball + sha512 integrity match. */
export async function verifyArtifact({
  fetchImpl = fetch,
  registry = DEFAULT_REGISTRY,
  mirror = DEFAULT_MIRROR,
  name,
  version,
} = {}) {
  if (!isSemver(version)) return { ok: false, error: `invalid version: ${version}` }
  const errors = []
  for (const base of [registry, mirror]) {
    try {
      const metaUrl = `${base.replace(/\/$/, '')}/${name}/${version}`
      const meta = await fetchJson(fetchImpl, metaUrl)
      const tarball = meta?.dist?.tarball
      const integrity = meta?.dist?.integrity
      if (typeof tarball !== 'string' || !/^https:\/\//i.test(tarball)) {
        throw new Error(`missing HTTPS dist.tarball for ${name}@${version}`)
      }
      if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) {
        throw new Error(`missing sha512 dist.integrity for ${name}@${version}`)
      }
      const res = await fetchImpl(tarball)
      if (!res.ok) throw new Error(`GET ${tarball} → HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
      if (actual !== integrity) throw new Error(`sha512 mismatch for ${name}@${version}`)
      return { ok: true, tarball }
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { ok: false, error: errors.join('; ') }
}

// ── Pure catalog merge/versioning ───────────────────────────────────────────

export function nextManifestVersion(current) {
  if (!isSemver(current)) throw new Error(`invalid current manifest version: ${current}`)
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(current)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4]}`
}

function upsertRelease(releases, incoming) {
  const key = (r) => JSON.stringify([r.version, r.platform, r.arch ?? null])
  const index = releases.findIndex((r) => key(r) === key(incoming))
  if (index >= 0) releases[index] = incoming
  else releases.push(incoming)
}

/**
 * Merge the operator-supplied HQ Edge headless release input. An explicit
 * `releases` array replaces the published list; `edgeHeadlessRelease` upserts
 * one entry. With neither, the published list is preserved exactly.
 */
export function buildEdgeHeadlessCatalog({
  previous,
  catalogInput = undefined,
  releaseInput = undefined,
  manifestVersion,
} = {}) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new Error('previous edge-headless catalog must be an object')
  }
  if (!isSemver(manifestVersion)) throw new Error(`invalid manifestVersion: ${manifestVersion}`)
  const catalog = structuredClone(previous)
  catalog.schemaVersion = 2
  catalog.manifestPackageVersion = manifestVersion
  catalog.releases = Array.isArray(catalog.releases) ? catalog.releases : []

  if (catalogInput !== undefined) {
    if (!catalogInput || typeof catalogInput !== 'object' || Array.isArray(catalogInput)) {
      throw new Error('edgeHeadless must be an object')
    }
    if (!Array.isArray(catalogInput.releases)) {
      throw new Error('edgeHeadless.releases must be an array')
    }
    catalog.releases = structuredClone(catalogInput.releases)
  }
  if (releaseInput !== undefined) {
    if (!releaseInput || typeof releaseInput !== 'object' || Array.isArray(releaseInput)) {
      throw new Error('edgeHeadlessRelease must be an object')
    }
    upsertRelease(catalog.releases, structuredClone(releaseInput))
  }
  catalog.releases.sort(
    (a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }) ||
      String(a.platform).localeCompare(String(b.platform)) ||
      String(a.arch ?? '').localeCompare(String(b.arch ?? '')),
  )
  const failures = validateEdgeHeadlessManifest(catalog)
  if (failures.length > 0) {
    throw new Error(`edge-headless catalog failed validation:\n- ${failures.join('\n- ')}`)
  }
  return catalog
}

/**
 * Stamp the build-pin manifest with the canonical package version and keep
 * plugin pins aligned with verified/standalone plugin versions.
 */
export function buildHqEdgeBuildCatalog({ previous, versions = {}, manifestVersion } = {}) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new Error('previous build manifest must be an object')
  }
  if (!isSemver(manifestVersion)) throw new Error(`invalid manifestVersion: ${manifestVersion}`)
  const catalog = structuredClone(previous)
  catalog.schema = 2
  catalog.manifestPackageVersion = manifestVersion
  catalog.plugins = catalog.plugins && typeof catalog.plugins === 'object' ? catalog.plugins : {}
  for (const [name, version] of Object.entries(versions)) {
    if (!catalog.plugins[name]) continue
    if (typeof catalog.plugins[name] === 'string') catalog.plugins[name] = version
    else catalog.plugins[name] = { ...catalog.plugins[name], version }
  }
  const failures = validateHqEdgeBuildManifest(catalog)
  if (failures.length > 0) {
    throw new Error(`HQ Edge build manifest failed validation:\n- ${failures.join('\n- ')}`)
  }
  return catalog
}

/**
 * Build the complete next catalog: preserve everything already published,
 * apply verified candidates, refresh standalone versions from npm, and stamp
 * the manifest-package version so consumers can verify exact-version delivery.
 */
export function buildCandidateCatalog({
  previous,
  candidates = {},
  standaloneVersions = {},
  setVersion = undefined,
  manifestVersion,
  publishedAt = new Date().toISOString(),
} = {}) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    throw new Error('previous catalog must be an object')
  }
  if (!isSemver(manifestVersion)) throw new Error(`invalid manifestVersion: ${manifestVersion}`)
  const catalog = structuredClone(previous)
  catalog.manifestPackageVersion = manifestVersion
  catalog.plugins = catalog.plugins && typeof catalog.plugins === 'object' ? catalog.plugins : {}
  catalog.release = catalog.release && typeof catalog.release === 'object' ? catalog.release : {}
  catalog.release.publishedAt = publishedAt

  const names = [...Object.keys(candidates), ...Object.keys(standaloneVersions)]
  for (const name of names) {
    const candidateVersion = candidates[name]
    const standaloneVersion = standaloneVersions[name]
    const version = candidateVersion ?? standaloneVersion
    if (version === undefined) continue
    catalog.plugins[name] = {
      ...(catalog.plugins[name] ?? { hosts: ['all'], requiresHqEdge: false }),
      version,
    }
  }

  if (setVersion !== undefined) {
    if (!isSemver(setVersion)) throw new Error(`invalid setVersion: ${setVersion}`)
    catalog.pluginSetVersion = setVersion
  } else {
    const versions = Object.values(candidates)
    if (versions.length > 0 && versions.every((v) => v === versions[0])) {
      catalog.pluginSetVersion = versions[0]
    }
  }
  return catalog
}

/** Validate a candidate catalog against the real workspace plugin contracts. */
export function validateCandidateCatalog(catalog, candidateVersions = {}) {
  const plugins = dshPlugins().map((pkg) => ({
    ...pkg,
    version: candidateVersions[pkg.name] ?? pkg.version,
  }))
  return validateReleaseManifest(catalog, {
    dshPlugins: plugins,
    pluginEntryInjects,
  })
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    dryRun: true,
    publish: false,
    bootstrap: false,
    candidates: {},
    candidatesFile: undefined,
    edgeHeadlessFile: undefined,
    setVersion: undefined,
    registry: process.env.npm_config_registry || DEFAULT_REGISTRY,
    mirror: DEFAULT_MIRROR,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--publish') {
      opts.publish = true
      opts.dryRun = false
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--bootstrap') {
      opts.bootstrap = true
    } else if (arg === '--candidates-file') {
      opts.candidatesFile = argv[++i]
    } else if (arg === '--edge-headless-file') {
      opts.edgeHeadlessFile = argv[++i]
    } else if (arg === '--candidate') {
      const value = argv[++i] ?? ''
      const at = value.lastIndexOf('@')
      if (at <= 0) throw new Error(`--candidate must be name@version, got ${JSON.stringify(value)}`)
      opts.candidates[value.slice(0, at)] = value.slice(at + 1)
    } else if (arg === '--set-version') {
      opts.setVersion = argv[++i]
    } else if (arg === '--registry') {
      opts.registry = argv[++i]
    } else if (arg === '--mirror') {
      opts.mirror = argv[++i]
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function readCandidatesFile(file, into) {
  if (!file) return into
  const parsed = JSON.parse(readFileSync(resolve(file), 'utf8'))
  const plugins = parsed?.plugins ?? parsed?.candidates ?? {}
  if (typeof plugins !== 'object' || Array.isArray(plugins)) {
    throw new Error('candidates file must contain a plugins object')
  }
  for (const [name, version] of Object.entries(plugins)) {
    if (typeof version !== 'string' || !isSemver(version)) {
      throw new Error(`invalid candidate version for ${name}: ${JSON.stringify(version)}`)
    }
    into[name] = version
  }
  return {
    candidates: into,
    setVersion: parsed?.setVersion,
    edgeHeadlessCatalog: parsed?.edgeHeadless,
    edgeHeadlessRelease: parsed?.edgeHeadlessRelease,
  }
}

/** Default standalone entry set: catalog entries whose source is not here. */
function standaloneNames(previous) {
  const local = new Set(dshPlugins().map((p) => p.name))
  return Object.keys(previous?.plugins ?? {}).filter((name) => !local.has(name))
}

export async function run(argv = process.argv.slice(2), deps = {}) {
  const opts = parseArgs(argv)
  const fetchImpl = deps.fetchImpl ?? fetch
  const fromFile = readCandidatesFile(opts.candidatesFile, { ...opts.candidates })
  const candidates = fromFile.candidates
  const setVersion = opts.setVersion ?? fromFile.setVersion
  const edgeHeadlessFile = opts.edgeHeadlessFile
    ? JSON.parse(readFileSync(resolve(opts.edgeHeadlessFile), 'utf8'))
    : undefined
  const edgeHeadlessCatalog = edgeHeadlessFile ?? fromFile.edgeHeadlessCatalog
  const edgeHeadlessRelease = fromFile.edgeHeadlessRelease

  for (const [name, version] of Object.entries(candidates)) {
    if (!isSemver(version)) throw new Error(`invalid candidate version for ${name}: ${version}`)
  }
  const hasCandidates =
    Object.keys(candidates).length > 0 ||
    edgeHeadlessCatalog !== undefined ||
    edgeHeadlessRelease !== undefined
  if (!hasCandidates) {
    throw new Error(
      'no release candidates supplied (use --candidate, --candidates-file or --edge-headless-file)',
    )
  }

  const localPackageVersion = JSON.parse(
    readFileSync(join(MANIFEST_DIR, 'package.json'), 'utf8'),
  ).version
  const resolved = await resolveCanonicalVersion({
    fetchImpl,
    registry: opts.registry,
    mirror: opts.mirror,
    bootstrapVersion: opts.bootstrap ? localPackageVersion : undefined,
  })
  console.log(`canonical catalog version: ${resolved.version} (${resolved.source})`)

  const readLocal = (file) => {
    const fullPath = join(MANIFEST_DIR, file)
    const value = JSON.parse(readFileSync(fullPath, 'utf8'))
    console.log(`bootstrap: using local seed catalog from ${fullPath}`)
    return value
  }
  const readPublished = async (file) => {
    const loaded = await loadPublishedCatalog({
      fetchImpl,
      version: resolved.version,
      registry: opts.registry,
      mirror: opts.mirror,
      loadFromTarball: deps.loadFromTarball,
      file,
    })
    console.log(`previous ${file} loaded from ${loaded.source}`)
    return loaded.catalog
  }

  let previous
  let previousEdgeHeadless
  let previousBuild
  if (opts.bootstrap) {
    previous = readLocal(CATALOG_FILE)
    previousEdgeHeadless = readLocal(EDGE_HEADLESS_FILE)
    previousBuild = readLocal(BUILD_MANIFEST_FILE)
  } else {
    previous = await readPublished(CATALOG_FILE)
    previousEdgeHeadless = await readPublished(EDGE_HEADLESS_FILE)
    previousBuild = await readPublished(BUILD_MANIFEST_FILE)
  }

  // 1. Resolve standalone versions from npm, independently of this monorepo.
  const standalone = await resolveStandaloneVersions({
    fetchImpl,
    names: standaloneNames(previous),
    registry: opts.registry,
    mirror: opts.mirror,
  })
  console.log(`standalone versions: ${JSON.stringify(standalone)}`)

  // 2. Verify every newly published plugin artifact before advertising it.
  const verified = {}
  for (const [name, version] of Object.entries(candidates)) {
    const result = await verifyArtifact({ fetchImpl, registry: opts.registry, mirror: opts.mirror, name, version })
    if (!result.ok) {
      console.warn(`skip unverified candidate ${name}@${version}: ${result.error}`)
      continue
    }
    verified[name] = version
    console.log(`verified ${name}@${version}`)
  }
  if (Object.keys(candidates).length > 0 && Object.keys(verified).length === 0) {
    throw new Error('no candidate artifact could be verified; previous canonical catalog is unchanged')
  }

  const manifestVersion = opts.bootstrap ? resolved.version : nextManifestVersion(resolved.version)
  const catalog = buildCandidateCatalog({
    previous,
    candidates: verified,
    standaloneVersions: standalone,
    setVersion,
    manifestVersion,
  })
  const failures = validateCandidateCatalog(catalog, verified)
  if (failures.length > 0) {
    throw new Error(`candidate catalog failed validation:\n- ${failures.join('\n- ')}`)
  }
  const edgeCatalog = buildEdgeHeadlessCatalog({
    previous: previousEdgeHeadless,
    catalogInput: edgeHeadlessCatalog,
    releaseInput: edgeHeadlessRelease,
    manifestVersion,
  })
  const buildCatalog = buildHqEdgeBuildCatalog({
    previous: previousBuild,
    versions: { ...standalone, ...verified },
    manifestVersion,
  })

  // 3. Stale-catalog guard: a concurrent manual release must not be lost.
  if (!opts.bootstrap) {
    const recheck = await resolveCanonicalVersion({
      fetchImpl,
      registry: opts.registry,
      mirror: opts.mirror,
    })
    if (recheck.version !== resolved.version) {
      throw new Error(
        `canonical manifest changed during release (${resolved.version} → ${recheck.version}); re-run with the refreshed catalog`,
      )
    }
  }

  const outputs = {
    [CATALOG_FILE]: catalog,
    [EDGE_HEADLESS_FILE]: edgeCatalog,
    [BUILD_MANIFEST_FILE]: buildCatalog,
  }
  const pkgPath = join(MANIFEST_DIR, 'package.json')
  if (opts.dryRun) {
    console.log(
      `\n[dry-run] would write ${CANONICAL_FILES.map((f) => join(MANIFEST_DIR, f)).join(', ')} ` +
        `(manifest ${manifestVersion}, ${Object.keys(catalog.plugins).length} plugin entries, ` +
        `${edgeCatalog.releases.length} runtime releases)`,
    )
    console.log('[dry-run] manifest package NOT published')
    return { catalog, edgeCatalog, buildCatalog, manifestVersion, published: false }
  }

  for (const [file, value] of Object.entries(outputs)) {
    writeFileSync(join(MANIFEST_DIR, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = manifestVersion
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`wrote ${CANONICAL_FILES.join(', ')} and package version ${manifestVersion}`)

  if (!opts.publish) {
    console.log('prepared only; pass --publish to publish the manifest package')
    return { catalog, edgeCatalog, buildCatalog, manifestVersion, published: false }
  }

  const publishArgs = ['publish', '--no-git-checks', '--access', 'public']
  const registry = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
  if (registry) publishArgs.push('--registry', registry)
  if (process.platform === 'win32') {
    execFileSync('npm.cmd', publishArgs, { cwd: MANIFEST_DIR, stdio: 'inherit', shell: true })
  } else {
    execFileSync('npm', publishArgs, { cwd: MANIFEST_DIR, stdio: 'inherit' })
  }
  console.log(`published @huaqiu/dsh-plugin-release-manifest@${manifestVersion}`)
  return { catalog, edgeCatalog, buildCatalog, manifestVersion, published: true }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  run().catch((err) => {
    console.error(`release-manifest: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
