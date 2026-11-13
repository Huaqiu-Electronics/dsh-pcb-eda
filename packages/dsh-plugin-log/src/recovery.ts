/**
 * Bounded historical recovery + retention for DSH log directories.
 *
 * A running DSH process owns ONLY `<dsh-root>/<its own dsh_instance_id>`. It may
 * inspect sibling (historical) directories — a previous DSH launch under the
 * same HQ Edge process leaves one behind every time DSH restarts — but every
 * modification MUST be preceded by successfully acquiring THAT directory's OS
 * ownership lock.
 *
 * That ordering is the whole safety argument (§5):
 *   - the parent HQ Edge process never rotates DSH logs while DSH runs;
 *   - one DSH process never rotates another LIVE DSH process's log;
 *   - a directory whose owner is gone can be repaired by any later DSH process.
 *
 * Recovery is idempotent, bounded in time and file count, never rewrites
 * `instance.json`, never overwrites a published archive, and preserves
 * anything it cannot verify.
 */
import { existsSync, promises as fsPromises, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { appendDiagnostic, atomicPublish, errorMessage, isUuid, withFsRetries } from './fs-utils.js'
import { readDshInstanceMetadata, RECOVERY_LOG_FILENAME } from './identity.js'
import { acquireHistoricalDshOwnership, recordRecoveryDiagnostic } from './ownership.js'
import {
  ARCHIVE_SUFFIX,
  QUARANTINE_MARKER,
  SEALED_MARKER,
  TEMP_MARKER,
  archivePathFromTempName,
  compressFileToArchive,
  isArchiveName,
  tempArchivePathFor,
  verifyGzipArchive,
} from './rotation.js'

export interface DshMaintenanceOptions {
  /** The DSH log root (`<edge>/dsh`). Each child directory is one DSH instance. */
  instancesRoot: string
  /** This process's own directory — never touched by maintenance. */
  ownInstanceDir: string
  maxDirectories?: number
  maxFilesPerDirectory?: number
  timeBudgetMs?: number
  /** A directory younger than this is assumed to be a live, just-started process. */
  minAgeMs?: number
  now?: () => number
  /** Structured sink into the CURRENT process's log (never a historical one). */
  report?: (record: Record<string, unknown>) => void
}

export interface DshMaintenanceReport {
  scanned: number
  skippedLive: number
  skippedInvalid: number
  skippedRecent: number
  recovered: number
  preserved: number
  quarantined: number
  deletedFiles: number
  deletedDirectories: number
  truncated: boolean
  details: Array<{ dir: string; action: string; detail?: string }>
}

function emptyReport(): DshMaintenanceReport {
  return {
    scanned: 0,
    skippedLive: 0,
    skippedInvalid: 0,
    skippedRecent: 0,
    recovered: 0,
    preserved: 0,
    quarantined: 0,
    deletedFiles: 0,
    deletedDirectories: 0,
    truncated: false,
    details: [],
  }
}

function report(options: DshMaintenanceOptions, record: Record<string, unknown>): void {
  appendDiagnostic(join(options.ownInstanceDir, RECOVERY_LOG_FILENAME), record)
  try {
    options.report?.(record)
  } catch {
    /* reporting must never break maintenance */
  }
}

function archivePathForArtifact(dir: string, name: string): string {
  // dsh.<date>.1.log.gz.tmp-<uuid>     -> dsh.<date>.1.log.gz
  // dsh.<date>.1.log.sealed-<uuid>     -> dsh.<date>.1.log.gz
  if (name.includes(TEMP_MARKER)) return archivePathFromTempName(dir, name)
  const stem = name.slice(0, name.indexOf(SEALED_MARKER))
  return join(dir, `${stem}${ARCHIVE_SUFFIX}`)
}

function uniqueArchivePath(preferred: string): string {
  if (!existsSync(preferred)) return preferred
  const stem = preferred.slice(0, -ARCHIVE_SUFFIX.length)
  for (let seq = 1; seq < 1_000; seq += 1) {
    const candidate = `${stem}.${seq}${ARCHIVE_SUFFIX}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem}.${randomUUID()}${ARCHIVE_SUFFIX}`
}

/**
 * Repairs incomplete rotation artifacts left by a previous DSH process.
 * Safe to run repeatedly and safe to run while other DSH processes are active
 * (their directories are skipped because their ownership lock is held).
 */
export async function recoverDshInstances(options: DshMaintenanceOptions): Promise<DshMaintenanceReport> {
  const now = options.now ?? Date.now
  const maxDirectories = options.maxDirectories ?? 64
  const maxFiles = options.maxFilesPerDirectory ?? 256
  const deadline = now() + (options.timeBudgetMs ?? 3_000)
  const minAgeMs = options.minAgeMs ?? 5_000
  const result = emptyReport()
  // An explicit 0 (or negative) disables the guard entirely. The comparison below
  // must not run at all in that case: on NTFS the directory mtime can round a few
  // milliseconds into the FUTURE relative to `Date.now()`, which would otherwise
  // make `now() - mtimeMs` negative and skip a directory that is known quiescent.
  const recentGuard = minAgeMs > 0
  const note = (dir: string, action: string, detail?: string) => {
    result.details.push({ dir, action, detail })
    report(options, { event: 'dsh-historical-recovery', dir, action, detail })
  }

  let names: string[]
  try {
    names = await fsPromises.readdir(options.instancesRoot)
  } catch {
    return result
  }

  for (const name of names.slice(0, maxDirectories)) {
    if (now() > deadline) {
      result.truncated = true
      break
    }
    const dir = join(options.instancesRoot, name)
    if (dir === options.ownInstanceDir) continue
    if (!isUuid(name)) {
      result.skippedInvalid += 1
      note(dir, 'preserved-invalid-name')
      continue
    }

    let stat
    try {
      stat = await fsPromises.stat(dir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    result.scanned += 1

    const metadata = readDshInstanceMetadata(dir)
    if (!metadata) {
      result.skippedInvalid += 1
      note(dir, 'preserved-corrupt-metadata')
      continue
    }
    if (recentGuard && Math.max(0, now() - stat.mtimeMs) < minAgeMs) {
      result.skippedRecent += 1
      note(dir, 'skipped-recent')
      continue
    }

    const ownership = await acquireHistoricalDshOwnership(dir, metadata.dshInstanceId)
    if (!ownership) {
      result.skippedLive += 1
      note(dir, 'skipped-live-owner')
      continue
    }

    try {
      let files: string[]
      try {
        files = (await fsPromises.readdir(dir)).slice(0, maxFiles)
      } catch {
        continue
      }
      for (const file of files) {
        if (now() > deadline) {
          result.truncated = true
          break
        }
        if (file.includes(QUARANTINE_MARKER)) continue // already handled (idempotent)
        if (!file.includes(TEMP_MARKER) && !file.includes(SEALED_MARKER)) continue

        const path = join(dir, file)
        const canonicalArchive = archivePathForArtifact(dir, file)
        // The existence check MUST use the canonical name. `uniqueArchivePath`
        // would return a fresh numbered candidate whenever the canonical
        // archive already exists, hiding the "already published" case.
        const canonicalExists = existsSync(canonicalArchive)

        if (file.includes(TEMP_MARKER)) {
          try {
            await verifyGzipArchive(path)
          } catch {
            try {
              renameSync(path, `${path}${QUARANTINE_MARKER}${randomUUID()}`)
              result.quarantined += 1
              note(dir, 'quarantined-invalid-temp', file)
            } catch {
              result.preserved += 1
              note(dir, 'preserved-invalid-temp', file)
            }
            continue
          }
          if (canonicalExists) {
            // A published archive already exists — never overwrite it. The
            // verified temp is redundant, so it can be removed safely.
            try {
              unlinkSync(path)
              result.deletedFiles += 1
              note(dir, 'removed-redundant-temp', file)
            } catch {
              result.preserved += 1
            }
            continue
          }
          try {
            if (atomicPublish(path, canonicalArchive)) {
              result.recovered += 1
              note(dir, 'published-temp-archive', file)
            } else {
              result.preserved += 1
              note(dir, 'preserved-publish-conflict', file)
            }
          } catch {
            result.preserved += 1
            note(dir, 'preserved-publish-failure', file)
          }
          continue
        }

        // SEALED_MARKER: a sealed source whose compression never completed.
        if (canonicalExists) {
          // The archive exists, so the source is redundant. Deletion is
          // conservative: keep it for the next maintenance pass.
          result.preserved += 1
          note(dir, 'preserved-redundant-sealed', file)
          continue
        }
        const archivePath = uniqueArchivePath(canonicalArchive)
        const tmp = tempArchivePathFor(archivePath)
        try {
          await compressFileToArchive(path, tmp)
          await verifyGzipArchive(tmp)
          if (atomicPublish(tmp, archivePath)) {
            await withFsRetries(() => unlinkSync(path), { attempts: 3, baseDelayMs: 25, totalTimeoutMs: 800 })
            result.recovered += 1
            note(dir, 'recovered-sealed-source', file)
          } else {
            result.preserved += 1
            note(dir, 'preserved-archive-conflict', file)
          }
        } catch (err) {
          result.preserved += 1
          note(dir, 'preserved-compression-failure', `${file}: ${errorMessage(err).slice(0, 160)}`)
          try {
            if (existsSync(tmp)) unlinkSync(tmp)
          } catch {
            /* preserved as an incomplete artifact */
          }
        }
      }
    } finally {
      ownership.release()
      recordRecoveryDiagnostic(dir, { event: 'recovery-lock-released', pid: process.pid })
    }
  }
  return result
}

/** Files that may remain in an expired instance directory. */
const METADATA_FILES = new Set(['instance.json', 'owner.lock', 'recovery.log', 'fatal.log', 'logging-health.log'])

/**
 * Per-instance retention. Never deletes an active directory: ownership
 * acquisition fails while the owner is alive. Never deletes a directory that
 * still has incomplete recovery artifacts.
 */
export async function cleanupExpiredDshInstances(
  options: DshMaintenanceOptions & { retentionDays?: number },
): Promise<DshMaintenanceReport> {
  const now = options.now ?? Date.now
  const retentionMs = (options.retentionDays ?? 30) * 24 * 60 * 60 * 1000
  const deadline = now() + (options.timeBudgetMs ?? 3_000)
  const result = emptyReport()
  const note = (dir: string, action: string, detail?: string) => {
    result.details.push({ dir, action, detail })
    report(options, { event: 'dsh-historical-cleanup', dir, action, detail })
  }

  let names: string[]
  try {
    names = await fsPromises.readdir(options.instancesRoot)
  } catch {
    return result
  }

  for (const name of names.slice(0, options.maxDirectories ?? 64)) {
    if (now() > deadline) {
      result.truncated = true
      break
    }
    const dir = join(options.instancesRoot, name)
    if (dir === options.ownInstanceDir || !isUuid(name)) continue
    const metadata = readDshInstanceMetadata(dir)
    if (!metadata) {
      result.skippedInvalid += 1
      note(dir, 'preserved-corrupt-metadata')
      continue
    }
    let stat
    try {
      stat = await fsPromises.stat(dir)
    } catch {
      continue
    }
    if (Math.max(0, now() - stat.mtimeMs) < retentionMs) continue
    result.scanned += 1

    const ownership = await acquireHistoricalDshOwnership(dir, metadata.dshInstanceId)
    if (!ownership) {
      result.skippedLive += 1
      note(dir, 'skipped-live-owner')
      continue
    }
    try {
      let files: string[]
      try {
        files = await fsPromises.readdir(dir)
      } catch {
        continue
      }
      if (files.some((file) => file.includes(TEMP_MARKER) || file.includes(SEALED_MARKER) || file.includes(QUARANTINE_MARKER))) {
        result.preserved += 1
        note(dir, 'preserved-unrecovered-artifacts')
        continue
      }
      for (const file of files) {
        if (METADATA_FILES.has(file)) continue
        // Ownership was ACQUIRED above, which proves no live process owns this
        // directory. Its `.log` file is therefore historical, not an active
        // destination, and is eligible for retention cleanup. Active files are
        // protected by the ownership check, not by their extension.
        if (!isArchiveName(file) && !file.endsWith('.log')) {
          result.preserved += 1
          note(dir, 'preserved-unknown-file', file)
          continue
        }
        try {
          await withFsRetries(() => unlinkSync(join(dir, file)), {
            attempts: 3,
            baseDelayMs: 25,
            totalTimeoutMs: 800,
          })
          result.deletedFiles += 1
        } catch {
          result.preserved += 1
          note(dir, 'preserved-delete-failure', file)
        }
      }
      const remaining = await fsPromises.readdir(dir)
      if (remaining.every((file) => METADATA_FILES.has(file))) {
        try {
          await fsPromises.rm(dir, { recursive: true, force: true })
          result.deletedDirectories += 1
          note(dir, 'deleted-expired-dsh-instance')
        } catch {
          note(dir, 'preserved-delete-directory-failure')
        }
      }
    } finally {
      ownership.release()
    }
  }
  return result
}

export interface LegacyPluginLogReport {
  files: Array<{ path: string; size: number; action: 'preserved' }>
  totalBytes: number
  note: string
}

/**
 * Conservative handling of the pre-isolation shared plugin log (§3).
 *
 * Old builds wrote `<HQ_EDGE_HOME>/logs/dsh-plugins/dsh-plugins.log[.N]` from
 * every plugin in every DSH process. Those files have no ownership metadata
 * and may still be written by an older build during a rolling upgrade, so this
 * function only REPORTS them. Nothing is moved, compressed or deleted: a
 * one-time, operator-reviewed migration is the only safe way to retire them.
 */
export async function reportLegacyPluginLogs(logBaseDir: string): Promise<LegacyPluginLogReport> {
  const files: LegacyPluginLogReport['files'] = []
  let totalBytes = 0
  const legacyDir = join(logBaseDir, 'dsh-plugins')
  let names: string[]
  try {
    names = await fsPromises.readdir(legacyDir)
  } catch {
    return { files, totalBytes: 0, note: 'no legacy dsh-plugins directory' }
  }
  for (const name of names) {
    if (!name.endsWith('.log') && !isArchiveName(name)) continue
    const path = join(legacyDir, name)
    try {
      const stat = await fsPromises.stat(path)
      if (!stat.isFile()) continue
      files.push({ path, size: stat.size, action: 'preserved' })
      totalBytes += stat.size
    } catch {
      /* preserve */
    }
  }
  return {
    files,
    totalBytes,
    note:
      `Preserved ${files.length} legacy shared plugin log file(s) (${totalBytes} bytes). ` +
      'No file was moved or deleted: ownership cannot be established from the old naming scheme.',
  }
}
