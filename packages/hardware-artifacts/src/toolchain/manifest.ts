/**
 * Typed reader for the HuaQiu toolchain manifest.
 *
 * The manifest at `https://kicad.eda.cn/agent-toolchains.json` is the only
 * authority on downloadable versions, checksums and URLs — the UI and the
 * installer never hardcode them (§7.1). Everything that reaches an archive
 * download passes through here first, so this module is where an unsupported
 * schema version, a wrong platform entry or a malformed checksum is refused
 * (§7.3) rather than two steps later inside a half-written file.
 *
 * @module @huaqiu/hardware-artifacts/toolchain/manifest
 */
import type { ToolchainId } from './resolve.js'

/** The manifest the installer trusts today. */
export const MANIFEST_URL = 'https://kicad.eda.cn/agent-toolchains.json'

/** Schema version this reader understands. */
export const MANIFEST_SCHEMA_VERSION = 1

/** One downloadable distribution. */
export interface ManifestEntry {
  /** Distributor version string, e.g. `10.0.7-2`. */
  readonly version: string
  /** Lower-case hex SHA-256 of the archive the URL serves. */
  readonly sha256: string
  /** Platform the archive targets (`win` | `darwin` | `linux`). */
  readonly platform: string
  /** Architecture the archive targets (`x64` | `arm64`). */
  readonly arch: string
  /** HTTPS URL of the archive. */
  readonly url: string
}

/** A manifest that passed validation, with the per-tool selections. */
export interface ToolchainManifest {
  readonly schemaVersion: number
  /** Every validated entry, per tool, in manifest order. */
  readonly entries: Readonly<Record<ToolchainId, readonly ManifestEntry[]>>
  /** The entry this host may install, per tool (absent when none matches). */
  readonly selected: Readonly<Partial<Record<ToolchainId, ManifestEntry>>>
  /** Platform/architecture the selection was made for. */
  readonly target: { readonly platform: string; readonly arch: string }
}

/** Why the manifest could not be used. */
export type ManifestFailureCode =
  | 'network'
  | 'http'
  | 'invalid-json'
  | 'unsupported-schema'
  | 'invalid-entry'
  | 'unsupported-platform'
  | 'no-entry'

/** A manifest this host cannot install from, with an operator-facing reason. */
export interface ManifestFailure {
  readonly ok: false
  readonly code: ManifestFailureCode
  readonly message: string
}

/** A manifest this host may install from. */
export interface ManifestSuccess {
  readonly ok: true
  readonly manifest: ToolchainManifest
}

/** Outcome of reading the manifest. */
export type ManifestResult = ManifestSuccess | ManifestFailure

/** Manifest platform token for the host platform, or undefined when unsupported. */
export function manifestPlatformOf(platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'darwin'
  if (platform === 'linux') return 'linux'
  return undefined
}

/** Manifest architecture token for the host architecture. */
export function manifestArchOf(arch: string): string {
  if (arch === 'arm64') return 'arm64'
  if (arch === 'ia32' || arch === 'x64') return 'x64'
  return arch
}

const TOOLCHAIN_IDS: readonly ToolchainId[] = ['kicad', 'solidcraft']
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

function failure(code: ManifestFailureCode, message: string): ManifestFailure {
  return { ok: false, code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one entry against the manifest contract; the reason on refusal. */
function readEntry(tool: ToolchainId, value: unknown): ManifestEntry | string {
  if (!isRecord(value)) return `${tool}: entry is not an object`
  const { version, sha256, platform, arch, url } = value
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) return `${tool}: invalid version`
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) return `${tool}: invalid sha256`
  if (typeof platform !== 'string' || platform === '') return `${tool}: invalid platform`
  if (typeof arch !== 'string' || arch === '') return `${tool}: invalid arch`
  if (typeof url !== 'string' || !url.startsWith('https://')) return `${tool}: download url must be https`
  return { version, sha256, platform, arch, url }
}

/** Version ordering used to pick the newest entry deterministically. */
function compareVersions(left: string, right: string): number {
  const segments = (value: string): (number | string)[] =>
    value.split(/[.+-]/u).map(part => (/^\d+$/u.test(part) ? Number(part) : part))
  const a = segments(left)
  const b = segments(right)
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
 * Parse and validate one manifest document for this host.
 *
 * Malformed or unsupported entries are rejected as a whole entry (§7.3): an
 * entry with a bad checksum is not "probably fine", because a download it
 * authorised could never be verified. Entries for other platforms/architectures
 * are kept in `entries` (so the UI can explain the mismatch) but never selected.
 * @param text - raw manifest body.
 * @param options - host platform/architecture to select for.
 * @returns the validated manifest, or the reason it cannot be used.
 */
export function parseManifest(
  text: string,
  options: { readonly platform?: NodeJS.Platform; readonly arch?: string } = {},
): ManifestResult {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return failure('invalid-json', 'the toolchain manifest is not valid JSON')
  }
  if (!isRecord(document)) return failure('invalid-json', 'the toolchain manifest is not an object')
  if (document.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return failure('unsupported-schema', `unsupported toolchain manifest schemaVersion ${String(document.schemaVersion)}`)
  }

  const platform = manifestPlatformOf(options.platform ?? process.platform)
  if (platform === undefined) {
    return failure('unsupported-platform', `toolchain downloads are not available on ${options.platform ?? process.platform}`)
  }
  const arch = manifestArchOf(options.arch ?? process.arch)

  const entries: Record<ToolchainId, readonly ManifestEntry[]> = { kicad: [], solidcraft: [] }
  const selected: Partial<Record<ToolchainId, ManifestEntry>> = {}
  for (const tool of TOOLCHAIN_IDS) {
    const list = document[tool]
    if (list === undefined) continue
    if (!Array.isArray(list)) return failure('invalid-entry', `${tool}: entries are not an array`)
    const validated: ManifestEntry[] = []
    for (const raw of list) {
      const entry = readEntry(tool, raw)
      if (typeof entry === 'string') return failure('invalid-entry', entry)
      validated.push(entry)
    }
    entries[tool] = validated
    const matching = validated
      .filter(entry => entry.platform === platform && entry.arch === arch)
      .sort((left, right) => compareVersions(right.version, left.version))
    const newest = matching[0]
    // `sort` above is descending, so the first match is the newest release; ties
    // keep manifest order, which is the documented deterministic policy.
    if (newest !== undefined) selected[tool] = newest
  }

  if (selected.kicad === undefined && selected.solidcraft === undefined) {
    return failure('no-entry', `the toolchain manifest offers no ${platform}-${arch} distribution`)
  }
  return { ok: true, manifest: { schemaVersion: MANIFEST_SCHEMA_VERSION, entries, selected, target: { platform, arch } } }
}

/** Injectable HTTP so the manifest reader is testable without a network. */
export interface ManifestFetchOptions {
  readonly url?: string
  readonly fetchImpl?: typeof fetch
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

/**
 * Fetch and validate the manifest.
 *
 * A network or HTTP failure is a *download-unavailable* state, not a setup
 * error: manual configuration and browsing stay available (§14.2), so the
 * failure is reported as data rather than thrown.
 * @param options - URL/transport/timeout and the target platform.
 * @returns the validated manifest or the reason it is unavailable.
 */
export async function fetchManifest(options: ManifestFetchOptions = {}): Promise<ManifestResult> {
  const url = options.url ?? MANIFEST_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, options.timeoutMs ?? 20_000)
  const abort = (): void => { controller.abort() }
  options.signal?.addEventListener('abort', abort)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) return failure('http', `the toolchain manifest answered HTTP ${String(response.status)}`)
    const text = await response.text()
    return parseManifest(text, {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.arch === undefined ? {} : { arch: options.arch }),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return failure('network', `the toolchain manifest could not be fetched: ${reason}`)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
