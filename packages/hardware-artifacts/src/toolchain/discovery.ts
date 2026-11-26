/**
 * Bounded background discovery of already-installed toolchains.
 *
 * Discovery exists so a user who already has KiCad is never asked where it is,
 * and it must not cost anything if it finds nothing: the candidate set is a
 * short list of installation conventions (§5.1), each candidate is one `stat`
 * plus at most one version probe, and the whole run happens off the request
 * that started it (§4.2/§5.2). Nothing here recurses a drive.
 *
 * @module @huaqiu/hardware-artifacts/toolchain/discovery
 */
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { installRootFromExecutable, resolveToolchain, type ToolchainId } from './resolve.js'

/** Where one candidate came from; used for display and for the tie-break. */
export type CandidateOrigin = 'managed' | 'system' | 'user-local'

/** One installation directory discovery looked at. */
export interface DiscoveryCandidate {
  /** Installation root that was checked. */
  readonly path: string
  readonly origin: CandidateOrigin
  /** True only when the executable exists and answered a version probe. */
  readonly valid: boolean
  readonly version?: string
  /** Normalised CLI the candidate resolved to, when it produced one. */
  readonly cli?: string
  readonly error?: string
}

/** Discovery state for one tool, as the UI shows it. */
export interface ToolDiscovery {
  readonly tool: ToolchainId
  readonly state: 'idle' | 'running' | 'done' | 'failed'
  readonly candidates: readonly DiscoveryCandidate[]
  /** The candidate discovery would configure, by the documented policy. */
  readonly selected?: DiscoveryCandidate
  readonly error?: string
  readonly finishedAt?: number
}

/** One place discovery will look, with its provenance. */
export interface CandidateRoot {
  readonly path: string
  readonly origin: CandidateOrigin
}

/** Facts the candidate list is a pure function of. */
export interface DiscoveryEnvironment {
  readonly platform?: NodeJS.Platform
  /** Process environment (`ProgramFiles`, `LOCALAPPDATA`, …). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The per-user toolchain root the installer promotes into. */
  readonly managedRoot: string
  /** User home directory. */
  readonly home: string
}

/** Filesystem/probe injection so discovery is testable without a machine. */
export interface DiscoveryInternals {
  readonly readdir?: (path: string) => readonly string[]
  readonly exists?: (path: string) => boolean
  readonly probeVersion?: (executable: string, tool: ToolchainId) => string | undefined
}

/** How many version-suffixed subdirectories one install prefix may contribute. */
const MAX_VERSIONED_DIRECTORIES = 3

function isDirectory(path: string, internals: DiscoveryInternals): boolean {
  if (internals.exists !== undefined) return internals.exists(path)
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listDirectories(path: string, internals: DiscoveryInternals): string[] {
  if (internals.readdir !== undefined) return [...internals.readdir(path)]
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Version-ordered directory names, newest first, capped. */
function versionedDirectories(path: string, internals: DiscoveryInternals): string[] {
  const names = listDirectories(path, internals).filter(name => /^\d/u.test(name))
  names.sort((left, right) => compareVersions(right, left))
  return names.slice(0, MAX_VERSIONED_DIRECTORIES)
}

/**
 * Installation roots discovery should look at, most specific first.
 *
 * The managed root comes first because a distribution the product itself
 * installed is the one it can reason about; system and user-local conventions
 * follow, and only their version-suffixed children are considered (§5.1). This
 * is a fixed, documented list — not a scan (§5.2).
 * @param tool - which toolchain.
 * @param environment - platform/env/managed root/home.
 * @param internals - filesystem injection.
 * @returns candidate roots in precedence order, de-duplicated.
 */
export function candidateRoots(
  tool: ToolchainId,
  environment: DiscoveryEnvironment,
  internals: DiscoveryInternals = {},
): CandidateRoot[] {
  const platform = environment.platform ?? process.platform
  const env = environment.env ?? process.env
  const roots: CandidateRoot[] = []
  const push = (path: string, origin: CandidateOrigin): void => { roots.push({ path: resolve(path), origin }) }

  const managed = join(environment.managedRoot, tool)
  for (const version of versionedDirectories(managed, internals)) push(join(managed, version), 'managed')
  if (isDirectory(managed, internals)) push(managed, 'managed')

  const toolDirectory = tool === 'kicad' ? 'KiCad' : 'SolidCraft'
  if (platform === 'win32') {
    for (const prefix of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (prefix === undefined || prefix === '') continue
      const base = join(prefix, toolDirectory)
      for (const version of versionedDirectories(base, internals)) push(join(base, version), 'system')
      if (tool === 'solidcraft' && isDirectory(base, internals)) push(base, 'system')
    }
    const local = env.LOCALAPPDATA
    if (local !== undefined && local !== '') {
      const base = join(local, 'Programs', toolDirectory)
      for (const version of versionedDirectories(base, internals)) push(join(base, version), 'user-local')
      if (tool === 'solidcraft' && isDirectory(base, internals)) push(base, 'user-local')
    }
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', join(environment.home, 'Applications')]) {
      const origin: CandidateOrigin = base.startsWith('/Applications') ? 'system' : 'user-local'
      push(join(base, toolDirectory), origin)
      push(join(base, `${toolDirectory}.app`), origin)
    }
  } else {
    const bases: { readonly base: string; readonly origin: CandidateOrigin }[] = [
      { base: '/usr/local', origin: 'system' },
      { base: '/usr', origin: 'system' },
      { base: join(environment.home, '.local'), origin: 'user-local' },
    ]
    for (const { base, origin } of bases) {
      push(join(base, 'bin'), origin)
      push(join(base, tool === 'kicad' ? 'kicad' : 'solidcraft'), origin)
    }
  }

  const unique: CandidateRoot[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const key = root.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(root)
  }
  return unique
}

/**
 * Validate candidates and choose one deterministically.
 *
 * Policy (§5.4/§5.2): a managed installation outranks a system one, then the
 * highest reported version wins, then candidate order. A candidate is valid
 * only when its executable answered a version probe, so a stale directory that
 * merely exists never wins.
 * @param tool - which toolchain.
 * @param roots - candidate roots in precedence order.
 * @param internals - probe/fs injection.
 * @returns every candidate's verdict, plus the one discovery would configure.
 */
export function validateCandidates(
  tool: ToolchainId,
  roots: readonly CandidateRoot[],
  internals: DiscoveryInternals = {},
): { candidates: DiscoveryCandidate[]; selected?: DiscoveryCandidate } {
  const candidates: DiscoveryCandidate[] = []
  for (const root of roots) {
    const resolution = resolveToolchain(tool, root.path, {
      ...(internals.exists === undefined ? {} : { exists: internals.exists }),
      ...(internals.probeVersion === undefined ? {} : {
        probeVersion: (executable: string) => internals.probeVersion?.(executable, tool),
      }),
    })
    // Point the candidate at the root that actually owns the executable, so what
    // gets stored is the installation and not one of its subdirectories.
    const executable = resolution.cli ?? resolution.app
    const effective = executable === undefined ? root.path : installRootFromExecutable(executable)
    candidates.push({
      path: effective,
      origin: root.origin,
      valid: resolution.configured,
      ...(resolution.version === undefined ? {} : { version: resolution.version }),
      ...(resolution.cli === undefined ? {} : { cli: resolution.cli }),
      ...(resolution.error === undefined ? {} : { error: resolution.error }),
    })
  }

  const valid = candidates.filter(candidate => candidate.valid)
  const ranked = [...valid].sort((left, right) => {
    if (left.origin !== right.origin) {
      const weight = (origin: CandidateOrigin): number => (origin === 'managed' ? 0 : origin === 'system' ? 1 : 2)
      return weight(left.origin) - weight(right.origin)
    }
    const byVersion = compareVersions(right.version, left.version)
    return byVersion !== 0 ? byVersion : candidates.indexOf(left) - candidates.indexOf(right)
  })
  const selected = ranked[0]
  return { candidates, ...(selected === undefined ? {} : { selected }) }
}

/** Compare two version strings, tolerant of packaging suffixes. */
export function compareVersions(left: string | undefined, right: string | undefined): number {
  if (left === undefined || right === undefined) return left === right ? 0 : left === undefined ? -1 : 1
  const split = (value: string): (number | string)[] =>
    value.split(/[.+-]/u).map(part => (/^\d+$/u.test(part) ? Number(part) : part))
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index]
    const y = b[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
      continue
    }
    const sx = String(x)
    const sy = String(y)
    if (sx !== sy) return sx < sy ? -1 : 1
  }
  return 0
}

/**
 * Probe one directory the user named or a dialog returned.
 * @param tool - which toolchain.
 * @param root - installation root to probe.
 * @param internals - probe injection.
 * @returns validity with the reason, for the "Validate and save" error path.
 */
export function probeInstallation(
  tool: ToolchainId,
  root: string,
  internals: DiscoveryInternals = {},
): { ok: boolean; version?: string; error?: string; cli?: string; app?: string } {
  const resolution = resolveToolchain(tool, root, {
    ...(internals.exists === undefined ? {} : { exists: internals.exists }),
    ...(internals.probeVersion === undefined ? {} : {
      probeVersion: (executable: string) => internals.probeVersion?.(executable, tool),
    }),
  })
  return {
    ok: resolution.configured,
    ...(resolution.version === undefined ? {} : { version: resolution.version }),
    ...(resolution.cli === undefined ? {} : { cli: resolution.cli }),
    ...(resolution.app === undefined ? {} : { app: resolution.app }),
    ...(resolution.error === undefined ? {} : { error: resolution.error }),
  }
}
