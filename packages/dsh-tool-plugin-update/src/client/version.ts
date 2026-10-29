/**
 * SemVer direction gate for plugin-update items (browser half).
 *
 * The rule this module exists to enforce, for EVERY plugin in the report:
 * an item is only "update available" — and only gets an install control —
 * when the version offered by the release manifest is strictly GREATER than
 * the version installed in the active bundle. A manifest entry that merely
 * differs from the installed version offers nothing: equality is the
 * already-installed case, and a manifest that LAGS behind the installed
 * build (a stale mirror or a rollback channel publishing 0.6.2 against an
 * installed 0.6.4) must never surface as a downgrade "update".
 *
 * Why this lives on the client even though hq-edge owns the decision: the
 * report crosses a process boundary, and an older hq-edge still carries the
 * old "differs ⇒ update" rule — which rendered `analytics 可更新
 * 0.6.4 → 0.6.2` with a live 安装 button for the whole plugin set. This is
 * the same defensive second pass the badge already applies to the ignored
 * offer: one authoritative decision upstream, one guard where it is shown.
 *
 * The comparator is a strict SemVer 2.0.0 implementation (no dependency —
 * this package ships no runtime dependencies beyond the workspace log +
 * sidebar helpers). Anything that is not clean SemVer on either side makes
 * the comparison `null`, and an unprovable direction fails CLOSED: the item
 * reads as current, never as an update.
 *
 * @module
 */
import type { PluginUpdateItem, PluginUpdateReport } from './api.js'

/** Strict SemVer 2.0.0: MAJOR.MINOR.PATCH[-prerelease][+build]. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers (empty = a release, which outranks any prerelease). */
  prerelease: string[]
}

/** Parse a strict SemVer string, or null when it is not one. */
function parseSemver(version: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(version.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** True when one prerelease identifier is purely numeric. */
function isNumericIdentifier(id: string): boolean {
  return /^\d+$/.test(id)
}

/**
 * Compare two prerelease identifier lists per SemVer §11:
 * numeric identifiers compare numerically and rank below alphanumeric ones;
 * a larger set of identifiers ranks higher when all shared ones are equal.
 */
function comparePrerelease(a: string[], b: string[]): number {
  // No prerelease outranks any prerelease.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined || right === undefined) continue
    if (left === right) continue
    const leftNumeric = isNumericIdentifier(left)
    const rightNumeric = isNumericIdentifier(right)
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return leftNumeric ? -1 : 1
    }
    return left < right ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Compare two strict SemVer strings: negative when `a < b`, positive when
 * `a > b`, 0 when equal, and null when either side is not SemVer (build
 * metadata is ignored in precedence, per spec).
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === null || right === null) return null
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Whether the offered release is an actionable upgrade over the installed
 * version: an absent plugin (nothing installed) is always installable, and
 * an installed one only when the offered SemVer is strictly greater. An
 * unprovable direction (non-SemVer on either side) is NOT an upgrade.
 */
export function isVersionUpgrade(currentVersion: string | null, availableVersion: string): boolean {
  if (currentVersion === null) return true
  const order = compareSemver(availableVersion, currentVersion)
  return order !== null && order > 0
}

/**
 * Re-evaluate one report item against the direction rule.
 *
 * A server-reported `update` that is not a strict SemVer upgrade is demoted
 * to `current`: the plugin is at (or ahead of) the offered release, there is
 * nothing to install, and no install control may be offered for it. Every
 * other state passes through untouched — `install` (plugin absent locally)
 * has no local version to compare, and `ignored`/`current` are already
 * non-actionable. Unknown server fields are preserved verbatim: the
 * client stays a thin reader of the hq-edge report shape.
 */
export function normalizePluginUpdateItem<T extends PluginUpdateItem>(item: T): T {
  if (item.state !== 'update') return item
  if (isVersionUpgrade(item.currentVersion, item.availableVersion)) return item
  return { ...item, state: 'current' }
}

/** States that carry an install action (the badge/actionable definition). */
function isActionableState(item: PluginUpdateItem): boolean {
  return item.state === 'update' || item.state === 'install'
}

/**
 * Apply {@link normalizePluginUpdateItem} to a whole report and recompute
 * `actionableCount` from the corrected states, so the server's count can
 * never disagree with what the panel and the sidebar badge render.
 */
export function normalizePluginUpdateReport<T extends PluginUpdateReport>(report: T): T {
  if (!Array.isArray(report.items)) return report
  const items = report.items.map(normalizePluginUpdateItem)
  return {
    ...report,
    items,
    actionableCount: items.filter(isActionableState).length,
  }
}
