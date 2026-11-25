/**
 * Path arithmetic for a document preview.
 *
 * Two jobs, both deliberately narrow:
 *
 * 1. Turn the tab's `dsh-resource://file/…` address back into the path the Host
 *    reads. Grammar transcribed from
 *    `@deepseek-ai/dsh-util-workspace-path/src/file-address.ts:42-116`; an
 *    address outside the two known scopes is a programming error, exactly as in
 *    the framework's own `hostFileOf`.
 * 2. Resolve a child schematic's `Sheet file` property against the owning
 *    document. KiCad writes those references with `/` separators on every
 *    platform, relative to the sheet that declares them, and allows `..`.
 *
 * Nothing here touches the filesystem: resolution is string arithmetic, and the
 * Host remains the only authority on whether a resolved path exists.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/paths
 */

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** A file address decomposed far enough to read it. */
export interface DocumentFilePath {
  readonly scope: 'session' | 'absolute'
  /** Session whose workspace resolves a relative path; absent for an absolute address. */
  readonly sessionId?: string
  /** Path handed to the Host. */
  readonly path: string
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * Read one document resource address.
 * @param address - a tab's `dsh-resource://file/…` address.
 * @returns its scope, session and path, or undefined when the address is not one this preview can read.
 */
export function documentFilePath(address: string): DocumentFilePath | undefined {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const end = address.search(/[?#]/)
  const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
  const segments = body.split('/')
  const scope = segments[0]
  const rest = segments.slice(1)
  if (scope === 'session') {
    const id = rest[0]
    if (id === undefined || id === '') return undefined
    const sessionId = decode(id)
    const path = rest.slice(1).map(decode)
    if (sessionId === undefined || path.length === 0 || path.some(part => part === undefined)) return undefined
    return { scope, sessionId, path: (path as string[]).join('/') }
  }
  if (scope === 'absolute') {
    const parts = rest.map(decode)
    if (parts.length === 0 || parts.some(part => part === undefined)) return undefined
    return { scope, path: `/${(parts as string[]).join('/')}` }
  }
  return undefined
}

/** Split a KiCad-style path into the directory part and the final name. */
export function splitPath(path: string): { readonly directory: string; readonly name: string } {
  const normalized = path.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1
    ? { directory: '', name: normalized }
    : { directory: normalized.slice(0, slash), name: normalized.slice(slash + 1) }
}

/**
 * Resolve a reference declared by a document against that document's path.
 *
 * Relative references are joined and then collapsed segment by segment, so
 * `../shared/power.kicad_sch` from `boards/a/main.kicad_sch` becomes
 * `boards/shared/power.kicad_sch`. A reference that escapes above the owning
 * directory is still returned as written — the Host, not this module, decides
 * whether that path is inside the authorized workspace.
 * @param ownerPath - path of the document that declares the reference.
 * @param reference - the declared reference, `/`- or `\`-separated.
 * @returns the resolved path, or undefined for an empty reference.
 */
export function resolveReference(ownerPath: string, reference: string): string | undefined {
  const trimmed = reference.trim().replaceAll('\\', '/')
  if (trimmed === '') return undefined
  // An absolute reference is already a complete path; only `..` needs collapsing.
  const absolute = trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)
  const base = absolute ? '' : splitPath(ownerPath).directory
  const joined = absolute ? trimmed : `${base}/${trimmed}`
  const segments: string[] = []
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Keep an unresolvable `..` instead of silently climbing above the workspace.
      if (segments.length === 0 || segments[segments.length - 1] === '..') segments.push('..')
      else segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) return undefined
  const resolved = segments.join('/')
  // A drive-qualified path keeps its own root marker; only a POSIX absolute
  // reference needs one added back.
  return absolute && trimmed.startsWith('/') ? `/${resolved}` : resolved
}

/**
 * Name a path for display inside a document body.
 * @param path - resolved or declared path.
 * @returns the final segment, or the whole path when it has none.
 */
export function displayName(path: string): string {
  const { name } = splitPath(path)
  return name === '' ? path : name
}
