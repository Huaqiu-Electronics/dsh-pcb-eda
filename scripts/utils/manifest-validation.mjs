/**
 * Release-manifest validation for the Huaqiu DSH plugin monorepo.
 *
 * Pure, dependency-free functions shared by the pre-publish gate
 * (`scripts/check-publish.mjs`) and its tests. The manifest is the
 * machine-readable source of truth for HQ Edge's remote plugin discovery
 * (hq-edge docs/tasks/dsh-plugin-discovery-and-update-with-hq-edge-update-reporting.md
 * §4.1), so it must never drift from the actual publishable set, the lockstep
 * version, or the plugin patch contracts.
 */

/**
 * Lightweight SemVer range validator for the centralized release manifest.
 *
 * The repo deliberately has no runtime dependency on `semver`, and the
 * pre-publish gate must stay runnable with plain Node. Supported forms:
 *
 *   - exact:               "0.5.21"
 *   - caret / tilde:       "^0.5.21" / "~0.5.21"
 *   - comparator chains:   ">=0.2.0", ">=0.2.0 <0.4.0", ">=0.2.0 <0.4.0 || ^1.0.0"
 *   - wildcard / any:      "*", ">=0"
 *
 * A version component is `\d+` (optionally pre-release/build suffix).
 */
const SEMVER_PART = String.raw`\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`
const COMPARATOR = String.raw`(?:\^|~|>=|<=|>|<|=)?\s*(${SEMVER_PART}|x|X|\*)`
const RANGE_UNIT = new RegExp(String.raw`^${COMPARATOR}(?:\s+${COMPARATOR})*$`)
const ANY_RANGE = /^(x|X|\*|\s*)$/

/** True when `range` is a syntactically valid SemVer range. */
export function isValidSemverRange(range) {
  if (typeof range !== 'string' || range.length === 0) return false
  if (ANY_RANGE.test(range)) return true
  return range.split('||').every((alternative) => {
    const trimmed = alternative.trim()
    if (trimmed.length === 0) return false
    return RANGE_UNIT.test(trimmed)
  })
}

/** Valid host enum values for a plugin entry's `hosts` field. */
export const RELEASE_HOSTS = new Set(['hq-eda', 'kicad', 'generic', 'all'])

/**
 * Release channels allowed in a v2 top-level `release.channel`.
 */
export const RELEASE_CHANNELS = new Set(['stable', 'beta', 'rc'])

const SEMVER_LIKE = /^\d+\.\d+\.\d+/

/**
 * True when `value` is a parseable ISO-8601 timestamp (e.g. 2026-10-21T09:00:00Z).
 */
function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/**
 * Validate the v2 top-level `release` metadata block. All fields are optional
 * at the manifest level, but when present they must have the declared types.
 */
function validateReleaseBlock(release, failures, where) {
  if (release === null || release === undefined) return
  if (typeof release !== 'object' || Array.isArray(release)) {
    failures.push(`${where}: release must be an object when present`)
    return
  }
  if (release.publishedAt !== undefined && !isIsoTimestamp(release.publishedAt)) {
    failures.push(`${where}: release.publishedAt must be an ISO-8601 timestamp (got ${JSON.stringify(release.publishedAt)})`)
  }
  if (release.channel !== undefined && !RELEASE_CHANNELS.has(release.channel)) {
    failures.push(`${where}: release.channel must be one of ${[...RELEASE_CHANNELS].join(', ')} (got ${JSON.stringify(release.channel)})`)
  }
  if (release.requiresRestart !== undefined && typeof release.requiresRestart !== 'boolean') {
    failures.push(`${where}: release.requiresRestart must be a boolean`)
  }
  for (const key of ['summary', 'notesUrl']) {
    if (release[key] !== undefined && typeof release[key] !== 'string') {
      failures.push(`${where}: release.${key} must be a string`)
    }
  }
  for (const key of ['notes', 'breaking']) {
    if (release[key] === undefined) continue
    if (!Array.isArray(release[key]) || release[key].some((n) => typeof n !== 'string')) {
      failures.push(`${where}: release.${key} must be an array of strings`)
    }
  }
}

/**
 * Validate v2 per-entry display metadata (optional, but typed when present).
 */
function validateEntryDisplayMetadata(entry, failures, where) {
  for (const key of ['displayName', 'description']) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') {
      failures.push(`${where}: ${key} must be a string`)
    }
  }
  if (entry.sizeBytes !== undefined) {
    if (typeof entry.sizeBytes !== 'number' || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      failures.push(`${where}: sizeBytes must be a non-negative integer`)
    }
  }
  if (entry.changes !== undefined && (!Array.isArray(entry.changes) || entry.changes.some((c) => typeof c !== 'string'))) {
    failures.push(`${where}: changes must be an array of strings`)
  }
}

/**
 * Validate a parsed release manifest against the real workspace.
 *
 * @param {object} manifest parsed `plugins-release-manifest.json`
 * @param {object} ctx
 * @param {{name:string, version:string}[]} ctx.dshPlugins real DSH plugins
 *        (packages declaring a `dsh` config)
 * @param {(pkg: any) => string[]} ctx.pluginEntryInjects inject-list reader
 *        (returns service names injected by the package's cordis.patch.yml)
 * @returns {string[]} human-readable failure messages (empty = valid)
 */
export function validateReleaseManifest(manifest, ctx) {
  const failures = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['plugins-release-manifest.json: not an object']
  }
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    failures.push(`plugins-release-manifest.json: schemaVersion must be 1 or 2 (got ${JSON.stringify(manifest.schemaVersion)})`)
  }
  // v2 carries optional release-level display metadata; validate its shape.
  if (manifest.schemaVersion === 2) {
    validateReleaseBlock(manifest.release, failures, 'plugins-release-manifest.json')
  }

  const setVersion = manifest.pluginSetVersion
  if (typeof setVersion !== 'string' || !SEMVER_LIKE.test(setVersion)) {
    failures.push(`plugins-release-manifest.json: pluginSetVersion must be a semver string (got ${JSON.stringify(setVersion)})`)
  }

  const pluginSet = ctx.dshPlugins ?? []
  const pluginNames = new Set(pluginSet.map((p) => p.name))
  const manifestNames = new Set(Object.keys(manifest.plugins ?? {}))

  const notInManifest = [...pluginNames].filter((n) => !manifestNames.has(n)).sort()
  if (notInManifest.length > 0) {
    failures.push(`plugins-release-manifest.json: real DSH plugins missing from manifest: ${notInManifest.join(', ')}`)
  }

  for (const name of manifestNames) {
    const entry = manifest.plugins?.[name]
    const pkg = pluginSet.find((p) => p.name === name)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`plugins-release-manifest.json: ${name}: entry must be an object`)
      continue
    }
    if (pkg && entry.version !== pkg.version) {
      failures.push(`plugins-release-manifest.json: ${name}: version ${entry.version} does not match package version ${pkg.version}`)
    } else if (!pkg && typeof entry.version !== 'string') {
      failures.push(`plugins-release-manifest.json: ${name}: version must be a string`)
    }
    // if (setVersion && entry.version !== setVersion) {
    //   failures.push(`plugins-release-manifest.json: ${name}: version ${entry.version} must equal pluginSetVersion ${setVersion} while lockstep is in effect`)
    // }

    if (!Array.isArray(entry.hosts) || entry.hosts.length === 0) {
      failures.push(`plugins-release-manifest.json: ${name}: hosts must be a non-empty array`)
    } else {
      const badHost = entry.hosts.find((h) => !RELEASE_HOSTS.has(h))
      if (badHost) failures.push(`plugins-release-manifest.json: ${name}: invalid host ${JSON.stringify(badHost)} (expected one of ${[...RELEASE_HOSTS].join(', ')})`)
    }

    if (typeof entry.requiresHqEdge !== 'boolean') {
      failures.push(`plugins-release-manifest.json: ${name}: requiresHqEdge must be a boolean`)
    } else if (pkg) {
      const injectsHqEdge = ctx.pluginEntryInjects?.(pkg)?.includes('hqEdge') ?? false
      if (entry.requiresHqEdge !== injectsHqEdge) {
        failures.push(
          `plugins-release-manifest.json: ${name}: requiresHqEdge ${entry.requiresHqEdge} does not match cordis.patch.yml inject ${injectsHqEdge ? 'containing' : 'without'} hqEdge`,
        )
      }
    }

    if (manifest.schemaVersion === 2) {
      validateEntryDisplayMetadata(entry, failures, `plugins-release-manifest.json: ${name}`)
    }

    for (const key of ['minHqEdge', 'maxHqEdge', 'minDsh']) {
      const value = entry[key]
      if (value === null || value === undefined) continue
      if (!isValidSemverRange(value)) {
        failures.push(`plugins-release-manifest.json: ${name}: ${key} is not a valid semver range (${JSON.stringify(value)})`)
      }
    }
  }

  return failures
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/i

/** Validate the canonical HQ Edge headless release manifest. */
export function validateEdgeHeadlessManifest(manifest) {
  const failures = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['edge-headless-release-manifest.json: not an object']
  }
  if (manifest.schemaVersion !== 2) {
    failures.push(`edge-headless-release-manifest.json: schemaVersion must be 2 (got ${JSON.stringify(manifest.schemaVersion)})`)
  }
  if (!EXACT_SEMVER.test(String(manifest.manifestPackageVersion ?? ''))) {
    failures.push('edge-headless-release-manifest.json: manifestPackageVersion must be an exact semver string')
  }
  if (!Array.isArray(manifest.releases)) {
    return [...failures, 'edge-headless-release-manifest.json: releases must be an array']
  }
  const seen = new Set()
  manifest.releases.forEach((entry, i) => {
    const where = `edge-headless-release-manifest.json: releases[${i}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`${where}: entry must be an object`)
      return
    }
    if (!EXACT_SEMVER.test(String(entry.version ?? ''))) failures.push(`${where}: invalid version`)
    if (!SHA256.test(String(entry.sha256 ?? ''))) failures.push(`${where}: sha256 must be 64 hex characters`)
    if (!['win', 'darwin', 'linux', 'all'].includes(entry.platform)) failures.push(`${where}: invalid platform`)
    if (entry.arch !== undefined && !['x64', 'arm64'].includes(entry.arch)) failures.push(`${where}: invalid arch`)
    if (typeof entry.url !== 'string' || !/^https:\/\//i.test(entry.url)) failures.push(`${where}: url must be HTTPS`)
    const key = JSON.stringify([entry.version, entry.platform, entry.arch ?? null])
    if (seen.has(key)) failures.push(`${where}: duplicate version/platform/arch entry`)
    seen.add(key)
  })
  return failures
}

/** Validate the canonical HQ Edge build-pin manifest. */
export function validateHqEdgeBuildManifest(manifest) {
  const failures = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['hq-edge-build-manifest.json: not an object']
  }
  if (manifest.schema !== 2) {
    failures.push(`hq-edge-build-manifest.json: schema must be 2 (got ${JSON.stringify(manifest.schema)})`)
  }
  if (!EXACT_SEMVER.test(String(manifest.manifestPackageVersion ?? ''))) {
    failures.push('hq-edge-build-manifest.json: manifestPackageVersion must be an exact semver string')
  }
  if (!manifest.plugins || typeof manifest.plugins !== 'object' || Array.isArray(manifest.plugins)) {
    return [...failures, 'hq-edge-build-manifest.json: plugins must be an object']
  }
  for (const [name, entry] of Object.entries(manifest.plugins)) {
    const version = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.version : undefined
    if (!EXACT_SEMVER.test(String(version ?? ''))) {
      failures.push(`hq-edge-build-manifest.json: ${name} must be an exact version string`)
    }
  }
  if (manifest.deps !== undefined && (typeof manifest.deps !== 'object' || Array.isArray(manifest.deps))) {
    failures.push('hq-edge-build-manifest.json: deps must be an object')
  } else {
    for (const [name, version] of Object.entries(manifest.deps ?? {})) {
      if (!EXACT_SEMVER.test(String(version ?? ''))) {
        failures.push(`hq-edge-build-manifest.json: deps.${name} must be an exact version string`)
      }
    }
  }
  return failures
}
