/**
 * Asynchronous, fault-tolerant rotation + retention for ONE DSH process's log
 * file inside the directory that process exclusively owns.
 *
 * The previous `@huaqiu/dsh-plugin-log` rotation was a synchronous
 * `rename`-shift chain that (a) assumed the process could rename files another
 * DSH process might hold open and (b) produced `.1 .2 .3` siblings with no
 * ownership metadata. Both are wrong once several DSH processes share an
 * installation, so this implementation follows the same rules as the HQ Edge
 * logging subsystem (docs/tasks/dsh-plugin-log-isolation.md §5):
 *
 *   - compression is streamed and asynchronous: no whole-file sync gzip;
 *   - the closing file is SEALED under a unique name first, so a crash leaves
 *     a recoverable artifact rather than a half-renamed member of a chain;
 *   - the archive is VERIFIED (gzip trailer included) before publication;
 *   - publication is atomic and NEVER overwrites an existing archive;
 *   - the sealed source is deleted only after successful publication;
 *   - unresolved artifacts are capped, so a filesystem that keeps rejecting
 *     publication cannot accumulate temp files without bound.
 *
 * Lifecycle:
 *   ACTIVE → ROTATION_REQUESTED → SEALING → ARCHIVING → VERIFYING
 *          → PUBLISHING → COMPLETED
 * Every failure state preserves the original data for historical recovery.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  promises as fsPromises,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import type { WriteStream } from 'node:fs'
import { createGunzip, createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

import { appendDiagnostic, atomicPublish, errorCode, errorMessage, sizeOrZero, withFsRetries } from './fs-utils.js'

/** Rotation + retention policy for the DSH log stream. */
export interface DshRotationConfig {
  /** Rotation frequency. Only "daily" is supported. */
  frequency: 'daily'
  /** Max size of a single log file before rotation, e.g. "10m". */
  maxSize: string
  /** Days to keep rotated (compressed) files. */
  retentionDays: number
  /** Maximum total bytes this DSH instance directory may consume. */
  maxStorageBytes: number
  /** Gzip rotated files. */
  compress: boolean
}

/**
 * Defaults for DSH plugin logs: plugin diagnostics are low volume, so 10 MiB
 * per file with 14 days of history is plenty, and 256 MiB caps a pathological
 * plugin without competing with the parent Edge instance's own budget.
 */
export const DSH_ROTATION: DshRotationConfig = {
  frequency: 'daily',
  maxSize: '10m',
  retentionDays: 14,
  maxStorageBytes: 256 * 1024 * 1024,
  compress: true,
}

/** Parses a human size string ("10m", "1g", "500k", or "1024") into bytes. */
export function parseSize(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?b?)?$/i.exec(input.trim())
  if (!match) return 10 * 1024 * 1024
  const value = Number.parseFloat(match[1] ?? '')
  if (!Number.isFinite(value)) return 10 * 1024 * 1024
  const unit = (match[2] || 'm').toLowerCase()
  switch (unit[0]) {
    case 'k':
      return Math.floor(value * 1024)
    case 'g':
      return Math.floor(value * 1024 * 1024 * 1024)
    default:
      return Math.floor(value * 1024 * 1024)
  }
}

/** Current UTC date as `yyyy-MM-dd`. UTC keeps multi-timezone installs stable. */
export function todayString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export const SEALED_MARKER = '.log.sealed-'
export const TEMP_MARKER = '.gz.tmp-'
export const QUARANTINE_MARKER = '.quarantine-'
export const ARCHIVE_SUFFIX = '.log.gz'

/** Canonical name for an in-progress gzip archive, e.g. `dsh.<date>.log.gz.tmp-<uuid>`. */
export function tempArchivePathFor(archivePath: string): string {
  return `${archivePath.slice(0, -'.gz'.length)}${TEMP_MARKER}${randomUUID()}`
}

/** Inverse of {@link tempArchivePathFor}, for a TEMP_MARKER-bearing name. */
export function archivePathFromTempName(dir: string, name: string): string {
  return join(dir, `${name.slice(0, name.indexOf(TEMP_MARKER))}.gz`)
}

/** True for names that are published or legacy archives. */
export function isArchiveName(name: string): boolean {
  return name.endsWith('.gz') || /\.gz\.\d+$/.test(name)
}

/** True for names that are incomplete rotation artifacts. */
export function isRecoveryArtifactName(name: string): boolean {
  return name.includes(SEALED_MARKER) || name.includes(TEMP_MARKER)
}

export type LoggingHealthState = 'initializing' | 'healthy' | 'degraded' | 'unavailable'

export interface LoggingHealth {
  state: LoggingHealthState
  reason: string
  droppedRecords: number
  rotationCount: number
  lastError: string | null
}

/** Injected faults — production never sets these; tests do. */
export interface DshRotationFaults {
  gzip?: boolean
  publish?: boolean
  seal?: boolean
  unlink?: boolean
  streamOpen?: boolean
  /** Delay BEFORE compression — lets a test kill the process mid-compression. */
  gzipDelayMs?: number
  /** Delay BEFORE publication — lets a test kill the process mid-publication. */
  publishDelayMs?: number
  /** Simulate ENOSPC on the active write stream. */
  diskFull?: boolean
}

export interface DshLogWriterOptions {
  /** The exclusively-owned instance directory. */
  dir: string
  /** Active file stem. Default `dsh`. */
  baseName?: string
  cfg?: DshRotationConfig
  faults?: DshRotationFaults
  now?: () => Date
  /** Diagnostic sink; defaults to `logging-health.log` in the same directory. */
  onDiagnostic?: (record: Record<string, unknown>) => void
}

const MAX_PENDING_BYTES = 4 * 1024 * 1024
const MAX_PENDING_RECORDS = 20_000
const MAX_DIAGNOSTICS = 40
const MAX_DELETES_PER_SWEEP = 64
const MAX_OPEN_ATTEMPTS = 3
const MAX_UNRESOLVED_ARTIFACTS = 6
const UNRESOLVED_COOLDOWN_MS = 5_000
const STREAM_CLOSE_TIMEOUT_MS = 2_000
const DRAIN_TIMEOUT_MS = 2_000
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Streams `src` into a gzip temp file. Never loads the whole log into memory. */
export async function compressFileToArchive(
  src: string,
  tmp: string,
  faults?: DshRotationFaults,
): Promise<void> {
  if (faults?.gzipDelayMs) await new Promise((resolve) => setTimeout(resolve, faults.gzipDelayMs))
  if (faults?.gzip) throw new Error('injected gzip failure')
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(tmp, { flags: 'wx' }))
}

/** Verifies a gzip archive is complete and readable (trailer included). */
export async function verifyGzipArchive(path: string): Promise<number> {
  let bytes = 0
  const counter = new Writable({
    write(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void): void {
      bytes += chunk.length
      callback()
    },
  })
  await pipeline(createReadStream(path), createGunzip(), counter)
  return bytes
}

/**
 * Serialized writer for one DSH log stream.
 *
 * Every mutation — append, seal, compress, publish, sweep — runs on ONE promise
 * chain, so two plugins logging concurrently can never interleave a rotation
 * with a write, and `flush()` has a single, exact meaning: "everything enqueued
 * so far, including any rotation it triggered, has finished".
 */
export class DshLogWriter {
  private readonly dir: string
  private readonly baseName: string
  private readonly cfg: DshRotationConfig
  private readonly maxSizeBytes: number
  private readonly now: () => Date
  private readonly faults: DshRotationFaults
  private readonly onDiagnostic?: (record: Record<string, unknown>) => void

  private stream: WriteStream | null = null
  private currentDate: string
  private currentPath: string
  private bytesWritten = 0

  private queue: Promise<void> = Promise.resolve()
  private pendingBytes = 0
  private pendingRecords = 0
  private droppedRecords = 0
  private openAttempts = 0
  private rotationCount = 0
  private deletions = 0
  private protectedFiles = new Set<string>()
  private diagnosticsEmitted = 0
  private closing = false
  private opened = false

  private health: LoggingHealthState = 'initializing'
  private healthReason = 'awaiting instance ownership'
  private lastError: string | null = null

  constructor(options: DshLogWriterOptions) {
    this.dir = options.dir
    this.baseName = options.baseName ?? 'dsh'
    this.cfg = options.cfg ?? DSH_ROTATION
    this.maxSizeBytes = parseSize(this.cfg.maxSize)
    this.now = options.now ?? (() => new Date())
    this.faults = options.faults ?? {}
    this.onDiagnostic = options.onDiagnostic
    this.currentDate = todayString(this.now())
    this.currentPath = this.pathForDate(this.currentDate)
  }

  /** Absolute path of the active file (whether or not it is open yet). */
  get path(): string {
    return this.currentPath
  }

  getHealth(): LoggingHealth {
    return {
      state: this.health,
      reason: this.healthReason,
      droppedRecords: this.droppedRecords,
      rotationCount: this.rotationCount,
      lastError: this.lastError,
    }
  }

  /** Opens the active file. Called only after the directory is owned. */
  open(): void {
    if (this.closing || this.opened) return
    this.opened = true
    this.openStream()
    // Sweep on the same serialized chain as writes: retention must never race
    // a rotation that is currently publishing an archive.
    this.queue = this.queue.then(() => this.runSweepSafely())
  }

  private pathForDate(date: string): string {
    return join(this.dir, `${this.baseName}.${date}.log`)
  }

  private diagnose(event: string, err?: unknown, extra: Record<string, unknown> = {}): void {
    if (this.diagnosticsEmitted >= MAX_DIAGNOSTICS) return
    this.diagnosticsEmitted += 1
    const record: Record<string, unknown> = { event: `dsh-logging-${event}`, instanceDir: this.dir, ...extra }
    if (err !== undefined) {
      record.code = errorCode(err)
      record.message = errorMessage(err).slice(0, 500)
      this.lastError = errorMessage(err).slice(0, 500)
    }
    if (this.onDiagnostic) {
      try {
        this.onDiagnostic(record)
        return
      } catch {
        /* a diagnostic sink must never re-enter the logging failure */
      }
    }
    appendDiagnostic(join(this.dir, 'logging-health.log'), record)
  }

  private setHealth(state: LoggingHealthState, reason: string, err?: unknown): void {
    this.health = state
    this.healthReason = reason
    if (err !== undefined) this.lastError = errorMessage(err).slice(0, 500)
  }

  private openStream(): void {
    if (this.closing) return
    if (this.faults.streamOpen) {
      this.setHealth('unavailable', 'injected stream-open failure')
      this.diagnose('open-failed', new Error('injected stream-open failure'))
      return
    }
    try {
      const stream = createWriteStream(this.currentPath, { flags: 'a' })
      stream.on('error', (err: unknown) => {
        this.diagnose('write-stream-error', err)
        this.setHealth('degraded', 'active write stream error', err)
        if (this.stream !== stream) return
        this.stream = null
        stream.destroy()
      })
      this.stream = stream
      this.bytesWritten = sizeOrZero(this.currentPath)
      this.setHealth('healthy', 'active log stream open')
      if (this.faults.diskFull) {
        const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        setImmediate(() => stream.emit('error', err))
      }
    } catch (err) {
      this.setHealth('degraded', 'cannot open active log file', err)
      this.diagnose('open-failed', err)
    }
  }

  /** Total in-memory queue pressure, used to reject unbounded buffering. */
  private canEnqueue(bytes: number): boolean {
    if (this.pendingBytes + bytes <= MAX_PENDING_BYTES && this.pendingRecords < MAX_PENDING_RECORDS) return true
    this.droppedRecords += 1
    this.diagnose('pending-overflow', undefined, { droppedTotal: this.droppedRecords })
    return false
  }

  /**
   * Enqueues one already-serialized JSONL record. Never throws and never
   * blocks the caller: a plugin's business call returns immediately.
   */
  write(line: string): void {
    if (this.closing) {
      this.droppedRecords += 1
      return
    }
    const bytes = Buffer.byteLength(line, 'utf8')
    if (!this.canEnqueue(bytes)) return
    this.pendingBytes += bytes
    this.pendingRecords += 1
    this.queue = this.queue
      .then(async () => {
        this.pendingBytes -= bytes
        this.pendingRecords -= 1
        await this.append(line)
      })
      .catch((err: unknown) => {
        // A logging failure must never surface as a plugin failure.
        this.diagnose('append-failed', err)
        this.setHealth('degraded', 'append failed', err)
      })
  }

  private async append(line: string): Promise<void> {
    if (this.closing || this.health === 'unavailable') {
      this.droppedRecords += 1
      return
    }
    const today = todayString(this.now())
    if (today !== this.currentDate) {
      await this.rotate('date')
    }
    if (!this.stream) {
      if (this.openAttempts >= MAX_OPEN_ATTEMPTS) {
        this.droppedRecords += 1
        return
      }
      this.openAttempts += 1
      this.openStream()
      if (!this.stream) {
        this.droppedRecords += 1
        return
      }
    }
    const stream = this.stream
    try {
      await this.writeChunk(stream, line)
      this.bytesWritten += Buffer.byteLength(line, 'utf8')
      // Only a WRITE that actually reached the file proves the destination is
      // healthy again. Resetting on open would let a persistently broken
      // stream reopen once per record forever.
      this.openAttempts = 0
    } catch (err) {
      this.diagnose('write-failed', err)
      this.setHealth('degraded', 'write failed', err)
      this.droppedRecords += 1
      return
    }
    if (this.bytesWritten >= this.maxSizeBytes) {
      await this.rotate('size')
    }
  }

  /**
   * Writes one chunk and resolves only once the stream has flushed it, so
   * `flush()` is a real durability boundary (not just "handed to the stream").
   * A bounded timeout keeps a wedged stream from stalling shutdown forever.
   */
  private writeChunk(stream: WriteStream, chunk: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        stream.removeListener('error', onError)
      }
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else resolve()
      }
      const onError = (err: Error) => finish(err)
      stream.once('error', onError)
      try {
        const accepted = stream.write(chunk, (err?: Error | null) => {
          if (err) finish(err)
          else finish()
        })
        if (!accepted) {
          timer = setTimeout(() => finish(), DRAIN_TIMEOUT_MS)
          timer.unref()
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private sealedPathFor(date: string, reason: 'date' | 'size', sequence: number): string {
    const stem = reason === 'date' ? `${this.baseName}.${date}` : `${this.baseName}.${date}.${sequence}`
    // SEALED_MARKER already begins with ".log.", so no extra ".log" here.
    return join(this.dir, `${stem}${SEALED_MARKER}${randomUUID()}`)
  }

  private archivePathFor(sealedPath: string): string {
    const name = basename(sealedPath)
    const marker = name.indexOf(SEALED_MARKER)
    const stem = marker > 0 ? name.slice(0, marker) : name
    return join(this.dir, `${stem}${ARCHIVE_SUFFIX}`)
  }

  /** Never overwrite: pick the first free sequence, never append `.gz.N`. */
  private chooseArchivePath(preferred: string, startSeq = 1): string {
    if (startSeq === 1 && !existsSync(preferred)) return preferred
    const bare = preferred.endsWith(ARCHIVE_SUFFIX) ? preferred.slice(0, -ARCHIVE_SUFFIX.length) : preferred
    const stem = bare.replace(/\.\d+$/, '')
    for (let seq = startSeq; seq < 10_000; seq += 1) {
      const candidate = `${stem}.${seq}${ARCHIVE_SUFFIX}`
      if (!existsSync(candidate)) return candidate
    }
    return `${stem}.${randomUUID()}${ARCHIVE_SUFFIX}`
  }

  private unresolvedArtifactCount(): number {
    try {
      // Synchronous by design: this runs on the serialized rotation path and
      // must see the directory as it is at this exact point.
      return readdirSync(this.dir).filter((name) => isRecoveryArtifactName(name)).length
    } catch {
      return 0
    }
  }

  private closeStream(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (!stream) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      stream.once('finish', done)
      stream.once('error', done)
      stream.once('close', done)
      try {
        stream.end()
      } catch {
        done()
      }
      const timer = setTimeout(done, STREAM_CLOSE_TIMEOUT_MS)
      timer.unref()
    })
  }

  private async rotate(reason: 'date' | 'size'): Promise<void> {
    if (this.closing || this.health === 'unavailable') return

    // A date rollover must still seal yesterday's file, but a size rotation
    // must not add yet another artifact while recovery is already backlogged.
    const unresolved = this.unresolvedArtifactCount()
    if (reason === 'size' && unresolved >= MAX_UNRESOLVED_ARTIFACTS) {
      this.diagnose('rotation-deferred', undefined, { unresolved, cap: MAX_UNRESOLVED_ARTIFACTS })
      this.setHealth('degraded', 'unresolved rotation artifacts at cap; continuing on active file')
      return
    }

    this.rotationCount += 1
    const closingDate = this.currentDate
    const closingPath = this.currentPath

    // ---- SEALING ---------------------------------------------------------
    await this.closeStream()
    this.currentDate = todayString(this.now())
    this.currentPath = this.pathForDate(this.currentDate)

    if (!existsSync(closingPath) || sizeOrZero(closingPath) === 0) {
      try {
        if (existsSync(closingPath)) unlinkSync(closingPath)
      } catch {
        /* an empty file is harmless */
      }
      this.openStream()
      return
    }

    const sequence = reason === 'size' ? this.rotationCount : 0
    const sealedPath = this.sealedPathFor(closingDate, reason, sequence)
    try {
      if (this.faults.seal) throw new Error('injected seal failure')
      await withFsRetries(() => renameSync(closingPath, sealedPath), {
        attempts: 5,
        baseDelayMs: 25,
        totalTimeoutMs: 2_000,
      })
    } catch (err) {
      // Preserve the original: continue appending to the SAME active file.
      this.diagnose('seal-failed', err, { closingPath })
      this.setHealth('degraded', 'seal failed; continuing on active file', err)
      this.currentDate = closingDate
      this.currentPath = closingPath
      this.openStream()
      return
    }
    this.protectedFiles.add(sealedPath)

    // Writes resume on the fresh active file BEFORE compression starts, so a
    // slow gzip never holds up plugin logging.
    this.openStream()

    if (!this.cfg.compress) {
      this.protectedFiles.delete(sealedPath)
      return
    }

    // ---- ARCHIVING / VERIFYING / PUBLISHING ------------------------------
    const preferredArchive = this.chooseArchivePath(this.archivePathFor(sealedPath))
    const tmpPath = tempArchivePathFor(preferredArchive)
    this.protectedFiles.add(tmpPath)
    let archiveVerified = false
    try {
      await compressFileToArchive(sealedPath, tmpPath, this.faults)
      await verifyGzipArchive(tmpPath)
      archiveVerified = true
      if (this.faults.publishDelayMs) await new Promise((resolve) => setTimeout(resolve, this.faults.publishDelayMs))

      if (this.faults.publish) throw new Error('injected publish failure')
      let published = false
      let archivePath = preferredArchive
      for (let attempt = 0; attempt < 32 && !published; attempt += 1) {
        try {
          published = await withFsRetries(() => atomicPublish(tmpPath, archivePath), {
            attempts: 4,
            baseDelayMs: 25,
            totalTimeoutMs: 2_000,
            isRetryable: (err) => errorCode(err) !== 'EEXIST' && errorCode(err) !== 'ENOENT',
          })
        } catch (err) {
          this.diagnose('publish-failed', err, { archivePath })
          break
        }
        if (!published) archivePath = this.chooseArchivePath(preferredArchive, attempt + 2)
      }
      if (!published) {
        // Sealed source + verified temp archive stay for historical recovery.
        this.diagnose('publish-unresolved', undefined, { sealedPath, tmpPath, archivePath })
        this.setHealth('degraded', 'archive publication deferred to recovery')
        return
      }
      this.protectedFiles.delete(tmpPath)
      this.diagnose('archive-published', undefined, { archivePath })

      // ---- COMPLETED: delete the source only AFTER publication -----------
      try {
        if (this.faults.unlink) throw new Error('injected unlink failure')
        await withFsRetries(() => unlinkSync(sealedPath), {
          attempts: 4,
          baseDelayMs: 25,
          totalTimeoutMs: 2_000,
        })
      } catch (err) {
        // A leftover sealed log is harmless and recoverable; never lose data.
        this.diagnose('source-unlink-failed', err, { sealedPath })
      }
      this.setHealth('healthy', 'rotation completed')
    } catch (err) {
      if (archiveVerified) {
        // Publication failed AFTER verification: KEEP the complete temp
        // archive so recovery can publish it without recompressing.
        this.diagnose('publish-failed-after-verify', err, { sealedPath, tmpPath })
        this.setHealth('degraded', 'archive publication deferred to recovery')
      } else {
        // Compression / verification failure: discard the INCOMPLETE temp
        // archive, but preserve the sealed source.
        this.diagnose('compression-failed', err, { sealedPath, tmpPath })
        this.setHealth('degraded', 'rotation failed; sealed source preserved', err)
        try {
          if (existsSync(tmpPath)) unlinkSync(tmpPath)
        } catch {
          /* recovery will quarantine an incomplete temp archive */
        }
        this.protectedFiles.delete(tmpPath)
      }
    } finally {
      this.protectedFiles.delete(sealedPath)
      await this.runSweepSafely()
    }
  }

  private async runSweepSafely(): Promise<void> {
    try {
      await this.runSweep()
    } catch (err) {
      this.diagnose('sweep-failed', err)
    }
  }

  /**
   * Capacity + retention. Counts ACTUAL disk consumption of the instance
   * directory. The active file and any file involved in the current rotation
   * are never deleted.
   */
  private async runSweep(): Promise<void> {
    this.deletions = 0
    let entries: string[]
    try {
      entries = await fsPromises.readdir(this.dir)
    } catch {
      return
    }

    const activeName = `${this.baseName}.${this.currentDate}.log`
    const now = Date.now()
    const retentionMs = this.cfg.retentionDays * 24 * 60 * 60 * 1000
    const candidates: Array<{ name: string; path: string; size: number; mtime: number }> = []
    let totalSize = 0

    for (const name of entries.slice(0, 20_000)) {
      const path = join(this.dir, name)
      try {
        const stat = await fsPromises.stat(path)
        if (!stat.isFile()) continue
        totalSize += stat.size
        if (name === activeName || this.protectedFiles.has(path)) continue
        if (isArchiveName(name)) {
          candidates.push({ name, path, size: stat.size, mtime: stat.mtimeMs })
        } else if (name.includes(TEMP_MARKER) && now - stat.mtimeMs > TEMP_MAX_AGE_MS) {
          candidates.push({ name, path, size: stat.size, mtime: stat.mtimeMs })
        }
      } catch {
        /* an unreadable entry is preserved, never deleted */
      }
    }

    // 1. Retention by the date in the name (mtime is the fallback).
    for (const file of candidates) {
      const match = /\.(\d{4}-\d{2}-\d{2})\./.exec(file.name)
      const stamp = match?.[1] ? Date.parse(match[1]) : Number.NaN
      const age = Number.isNaN(stamp) ? now - file.mtime : now - stamp
      if (age <= retentionMs) continue
      if (await this.deleteEligible(file)) totalSize -= file.size
    }

    // 2. Capacity: delete the oldest eligible archive first, bounded per sweep.
    if (totalSize > this.cfg.maxStorageBytes) {
      const sorted = candidates.filter((file) => existsSync(file.path)).sort((a, b) => a.mtime - b.mtime)
      for (const file of sorted) {
        if (totalSize <= this.cfg.maxStorageBytes) break
        if (await this.deleteEligible(file)) totalSize -= file.size
      }
    }
  }

  private async deleteEligible(file: { name: string; path: string }): Promise<boolean> {
    if (this.deletions >= MAX_DELETES_PER_SWEEP) return false
    if (!existsSync(file.path)) return false
    try {
      await withFsRetries(() => unlinkSync(file.path), { attempts: 3, baseDelayMs: 25, totalTimeoutMs: 1_000 })
      this.deletions += 1
      return true
    } catch (err) {
      this.diagnose('cleanup-failed', err, { file: file.name })
      return false
    }
  }

  /**
   * Waits until everything enqueued so far — including a rotation it
   * triggered — has completed. Never called from plugin code; only from DSH
   * shutdown and tests.
   */
  async flush(): Promise<void> {
    await this.queue
  }

  /** Bounded, final close. Deletes nothing and finishes the active file. */
  async close(): Promise<void> {
    if (this.closing) {
      await this.queue
      return
    }
    this.closing = true
    await this.queue
    await this.closeStream()
  }
}
