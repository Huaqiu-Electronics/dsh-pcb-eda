/**
 * Small, dependency-free filesystem primitives shared by identity, ownership,
 * rotation and historical recovery.
 *
 * The DSH log tree is written by several DSH processes that may share one HQ
 * Edge installation, so every mutation here follows the same rules as the HQ
 * Edge logging subsystem (docs/tasks/dsh-plugin-log-isolation.md §5):
 *
 *   - publication is ATOMIC and NEVER overwrites an existing destination;
 *   - temporary files are unique and live on the same filesystem as the
 *     destination, so a rename can never cross volumes;
 *   - Windows sharing violations get bounded, classified retries;
 *   - every helper is safe to call from an error path: it never throws past a
 *     guarded boundary and never buffers without a bound.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** RFC 4122 / RFC 9562 UUID (versions 1–5) — used to validate identity values. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Filesystem errors that a Windows file lock / transient sharing violation can produce. */
const TRANSIENT_FS_CODES = new Set([
  'EPERM',
  'EBUSY',
  'EACCES',
  'EAGAIN',
  'UNKNOWN',
  'ESTALE',
  'ETIMEDOUT',
  'ELOCKED',
])

/** Errors that must NOT be retried (permanent permission / invalid path / disk full). */
const PERMANENT_FS_CODES = new Set([
  'ENOENT',
  'ENOSPC',
  'EISDIR',
  'ENOTDIR',
  'EINVAL',
  'ENAMETOOLONG',
  'EROFS',
  'EMFILE',
  'ENFILE',
])

export function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? ''
  if (PERMANENT_FS_CODES.has(code)) return false
  return TRANSIENT_FS_CODES.has(code)
}

export function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN'
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Bounded async delay used by filesystem retry backoff. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  totalTimeoutMs?: number
  /** Defaults to {@link isTransientFsError}. */
  isRetryable?: (err: unknown) => boolean
}

/**
 * Runs `operation` with a bounded exponential backoff for transient Windows
 * file-lock failures. Permanent failures are rethrown immediately. A total
 * time budget keeps a rotation from stalling plugin shutdown indefinitely.
 */
export async function withFsRetries<T>(
  operation: () => T | Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5
  const baseDelayMs = options.baseDelayMs ?? 25
  const maxDelayMs = options.maxDelayMs ?? 400
  const totalTimeoutMs = options.totalTimeoutMs ?? 5_000
  const isRetryable = options.isRetryable ?? isTransientFsError
  const deadline = Date.now() + totalTimeoutMs

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (err) {
      lastError = err
      if (!isRetryable(err) || attempt === attempts - 1 || Date.now() >= deadline) throw err
      const wait = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs, Math.max(0, deadline - Date.now()))
      if (wait > 0) await delay(wait)
    }
  }
  throw lastError
}

/**
 * Publishes `src` as `dst` without ever overwriting an existing file.
 *
 * Hard-link creation is the primary mechanism: it is atomic on NTFS and POSIX
 * and fails with EEXIST when the destination already exists. Where hard links
 * are unavailable (some network/virtual filesystems), a guarded rename is used
 * inside the caller's exclusively-owned directory.
 *
 * Returns true when this call created `dst`, false when `dst` already existed.
 */
export function atomicPublish(src: string, dst: string): boolean {
  if (existsSync(dst)) return false
  try {
    linkSync(src, dst)
    try {
      unlinkSync(src)
    } catch {
      // The hard link is published; leaving the source name is harmless and
      // will be swept by maintenance. Never fail a successful publication.
    }
    return true
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false
    if (!isLinkUnsupported(err)) throw err
    if (existsSync(dst)) return false
    renameSync(src, dst)
    return true
  }
}

function isLinkUnsupported(err: unknown): boolean {
  const code = errorCode(err)
  return code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOSYS' || code === 'EXDEV' || code === 'ENOTSUP'
}

/**
 * Atomically writes `data` to `path` ONLY if that path does not exist, so a
 * partially-written temp file can never be observed at the destination.
 */
export function atomicCreateNewFile(path: string, data: string | Buffer, tmpPrefix = '.tmp-'): boolean {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `${tmpPrefix}${randomUUID()}`)
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'wx', 0o600)
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
    writeSync(fd, buf, 0, buf.length, 0)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    return atomicPublish(tmp, path)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Reads a JSON file. Returns `null` on any error (missing, unreadable, NUL
 * corruption, invalid JSON). Callers MUST treat `null` as "preserve, never
 * delete" — a corrupt `instance.json` is evidence, not garbage.
 */
export function readJsonSafe<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    if (raw.includes('\u0000')) return null
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as T) : null
  } catch {
    return null
  }
}

/** Best-effort synchronous append that can never throw. Used by error paths. */
export function appendDiagnostic(path: string, record: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const line =
      typeof record === 'string'
        ? record
        : JSON.stringify({
            time: new Date().toISOString(),
            ...(record !== null && typeof record === 'object'
              ? (record as Record<string, unknown>)
              : { value: String(record) }),
          })
    const fd = openSync(path, 'a', 0o600)
    try {
      writeSync(fd, Buffer.from(`${line}\n`, 'utf-8'))
    } finally {
      closeSync(fd)
    }
  } catch {
    // A diagnostic must never become the cause of a recursive failure.
  }
}

/** Size of a file, or 0 when it cannot be stat'ed. */
export function sizeOrZero(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** True when a file exists and is a regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
