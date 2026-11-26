/**
 * Download → verify → extract → validate → promote, as one cancellable job.
 *
 * The order of the stages *is* the safety property (§8.5): nothing is reported
 * installed until a checksum matched the manifest entry and the extracted
 * executables answered a version probe, and a failure at any stage removes what
 * that stage wrote. Every stage is host-side and asynchronous, so the browser
 * only ever polls progress (§7.5).
 *
 * @module @huaqiu/hardware-artifacts/toolchain/install
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ManifestEntry } from './manifest.js'
import { label, type ToolchainId } from './resolve.js'
import { commonDirectory, extractZip, readZipDirectory, ZipError } from './zip.js'

/** Stage a job is in; the first five are transient, the last three terminal. */
export type InstallPhase =
  | 'download'
  | 'verify'
  | 'extract'
  | 'layout'
  | 'promote'
  | 'done'
  | 'failed'
  | 'cancelled'

/** A stable error vocabulary for the UI, independent of Node's error text. */
export type InstallErrorCode =
  | 'http'
  | 'network'
  | 'checksum-mismatch'
  | 'invalid-zip'
  | 'unsafe-entry'
  | 'archive-too-large'
  | 'unsupported-compression'
  | 'unsupported-zip64'
  | 'duplicate-entry'
  | 'layout'
  | 'validation'
  | 'disk'
  | 'cancelled'
  | 'internal'

/** One job's observable state, as the UI polls it. */
export interface InstallJobSnapshot {
  readonly id: string
  readonly tool: ToolchainId
  readonly version: string
  readonly phase: InstallPhase
  /** Bytes received so far (download), or written so far (extract). */
  readonly received: number
  /** Total bytes when the server or the archive declared a reliable one. */
  readonly total?: number
  /** Whole-percent progress, present only when `total` is known. */
  readonly percent?: number
  /** Operator-facing line for the current stage. */
  readonly message: string
  readonly errorCode?: InstallErrorCode
  readonly error?: string
  /** Installation root the job registered, on success only. */
  readonly installPath?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** How one job ended. */
export interface InstallOutcome {
  readonly ok: boolean
  /** Installation root promoted (or reused) on success. */
  readonly installPath?: string
  /** Version the manifest asked for. */
  readonly version: string
  /** True when an already-installed, valid copy satisfied the request (§8.6). */
  readonly reused: boolean
  readonly errorCode?: InstallErrorCode
  readonly error?: string
}

/** What the manager supplies to one run. */
export interface InstallHooks {
  /**
   * Validate the extracted/promoted installation before it may be registered.
   * @param installPath - candidate installation root.
   * @returns whether it is usable, with the reason when it is not.
   */
  readonly validate: (installPath: string) => Promise<{ readonly ok: boolean; readonly error?: string }>
  /** Receive each progress step (the manager fans it out to its status cache). */
  readonly onProgress?: (snapshot: InstallJobSnapshot) => void
}

/** Injectable boundaries, so the whole stage machine is testable. */
export interface InstallerOptions {
  /** Per-user toolchain root (`<DSH home>/toolchains`). */
  readonly root: string
  readonly fetchImpl?: typeof fetch
  /** Abort the download stage after this long without a byte. */
  readonly idleTimeoutMs?: number
  readonly now?: () => number
  readonly idPrefix?: string
}

/** The primary file an installation must contain, per distribution (§8.2/§8.3). */
export function expectedLayout(tool: ToolchainId, platform: NodeJS.Platform = process.platform): string[] {
  const exe = platform === 'win32' ? '.exe' : ''
  if (tool === 'kicad') {
    return platform === 'darwin'
      ? ['KiCad.app/Contents/MacOS/kicad-cli']
      : [join('bin', `kicad-cli${exe}`)]
  }
  return [`solidcraft${exe}`]
}

/** The stable vocabulary, as a runtime list so a thrown code can be recognised. */
const INSTALL_ERROR_CODES: readonly InstallErrorCode[] = [
  'http', 'network', 'checksum-mismatch', 'invalid-zip', 'unsafe-entry', 'archive-too-large',
  'unsupported-compression', 'unsupported-zip64', 'duplicate-entry', 'layout', 'validation',
  'disk', 'cancelled', 'internal',
]

/** Wrap a Node/unknown failure into the job's stable vocabulary. */
function classify(error: unknown): { code: InstallErrorCode; message: string } {
  const declared = (error as { code?: unknown } | null)?.code
  if (typeof declared === 'string' && INSTALL_ERROR_CODES.includes(declared as InstallErrorCode)) {
    return { code: declared as InstallErrorCode, message: error instanceof Error ? error.message : String(error) }
  }
  if (error instanceof ZipError) {
    return { code: 'invalid-zip', message: error.message }
  }
  if (typeof declared === 'string') {
    if (declared === 'ENOSPC' || declared === 'EDQUOT') return { code: 'disk', message: 'not enough free disk space' }
    if (declared === 'ABORT_ERR') return { code: 'cancelled', message: 'the download was cancelled' }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Runs one download/install at a time per tool, and reports it as a snapshot.
 *
 * Job identity is the tool: a second request while one is running joins the
 * running job instead of starting a competing one (§14.4).
 */
export class ToolchainInstaller {
  private readonly jobs = new Map<string, InstallJobSnapshot>()
  private readonly running = new Map<ToolchainId, { id: string; controller: AbortController }>()
  private readonly root: string
  private readonly fetchImpl: typeof fetch
  private readonly idleTimeoutMs: number
  private readonly now: () => number
  private sequence = 0

  constructor(private readonly options: InstallerOptions) {
    this.root = options.root
    this.fetchImpl = options.fetchImpl ?? fetch
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000
    this.now = options.now ?? (() => Date.now())
  }

  /** One job's current snapshot. */
  snapshot(id: string): InstallJobSnapshot | undefined {
    return this.jobs.get(id)
  }

  /** The job currently running for one tool, if any. */
  activeFor(tool: ToolchainId): InstallJobSnapshot | undefined {
    const entry = this.running.get(tool)
    return entry === undefined ? undefined : this.jobs.get(entry.id)
  }

  /**
   * Cancel one job.
   * @param id - job to cancel.
   * @returns true when a running job was signalled.
   */
  cancel(id: string): boolean {
    for (const [tool, entry] of this.running) {
      if (entry.id !== id) continue
      entry.controller.abort()
      this.running.delete(tool)
      return true
    }
    return false
  }

  /**
   * Start (or join) the install of one manifest entry.
   * @param tool - which toolchain.
   * @param entry - validated manifest entry to install.
   * @param hooks - validation and progress callbacks.
   * @returns the job's initial snapshot and the promise that settles it.
   */
  start(
    tool: ToolchainId,
    entry: ManifestEntry,
    hooks: InstallHooks,
  ): { readonly snapshot: InstallJobSnapshot; readonly done: Promise<InstallOutcome> } {
    const active = this.running.get(tool)
    if (active !== undefined) {
      const snapshot = this.jobs.get(active.id) as InstallJobSnapshot
      return { snapshot, done: Promise.resolve({ ok: false, version: snapshot.version, reused: false, errorCode: 'internal', error: 'another installation is already running' }) }
    }
    this.sequence += 1
    const id = `${tool}-${this.now()}-${this.sequence}`
    const controller = new AbortController()
    this.running.set(tool, { id, controller })
    const initial: InstallJobSnapshot = {
      id, tool, version: entry.version, phase: 'download', received: 0,
      message: `Downloading ${label(tool)} ${entry.version}`, startedAt: this.now(),
    }
    this.jobs.set(id, initial)
    const done = this.run(id, tool, entry, controller, hooks)
    return { snapshot: this.jobs.get(id) as InstallJobSnapshot, done }
  }

  /** Emit one snapshot and keep it as the job's latest state. */
  private publish(snapshot: InstallJobSnapshot, hooks: InstallHooks): void {
    this.jobs.set(snapshot.id, snapshot)
    hooks.onProgress?.(snapshot)
  }

  /** Advance one job to a transient stage. */
  private stage(
    id: string,
    tool: ToolchainId,
    version: string,
    phase: InstallPhase,
    message: string,
    progress: { received?: number; total?: number } = {},
    hooks?: InstallHooks,
  ): InstallJobSnapshot {
    const startedAt = this.jobs.get(id)?.startedAt ?? this.now()
    const received = progress.received ?? 0
    const total = progress.total
    const snapshot: InstallJobSnapshot = {
      id, tool, version, phase, received, message, startedAt,
      ...(total === undefined ? {} : { total, percent: total === 0 ? 100 : Math.min(100, Math.round((received / total) * 100)) }),
    }
    this.jobs.set(id, snapshot)
    if (hooks !== undefined) hooks.onProgress?.(snapshot)
    return snapshot
  }

  /** The whole stage machine for one job. */
  private async run(
    id: string,
    tool: ToolchainId,
    entry: ManifestEntry,
    controller: AbortController,
    hooks: InstallHooks,
  ): Promise<InstallOutcome> {
    const tempRoot = join(this.root, '.tmp')
    const stagingRoot = join(this.root, '.staging')
    const trashRoot = join(this.root, '.trash')
    const archivePath = join(tempRoot, `${tool}-${entry.version}-${id}.zip`)
    const stagingPath = join(stagingRoot, `${tool}-${entry.version}-${id}`)
    const finalPath = join(this.root, tool, entry.version)
    let promoted = false
    try {
      await mkdir(tempRoot, { recursive: true })
      await mkdir(stagingRoot, { recursive: true })
      await mkdir(join(this.root, tool), { recursive: true })

      // §8.6: an already-installed, valid copy of the requested version is
      // reused rather than downloaded again.
      if (existsSync(finalPath) && (await hooks.validate(finalPath)).ok) {
        this.stage(id, tool, entry.version, 'done', `${label(tool)} ${entry.version} is already installed`, {}, hooks)
        this.jobs.set(id, { ...(this.jobs.get(id) as InstallJobSnapshot), installPath: finalPath })
        return { ok: true, installPath: finalPath, version: entry.version, reused: true }
      }

      this.stage(id, tool, entry.version, 'download', `Downloading ${label(tool)} ${entry.version}`, {}, hooks)
      const digest = await this.download(id, tool, entry, archivePath, controller, hooks)

      this.stage(id, tool, entry.version, 'verify', 'Verifying the download', {}, hooks)
      if (digest !== entry.sha256.toLowerCase()) {
        throw Object.assign(new Error('the download does not match the published SHA-256'), { code: 'checksum-mismatch' })
      }
      // The manifest's size is not declared, so the archive's own size is the
      // only "complete download" signal available (§7.5).
      const archiveBytes = (await stat(archivePath)).size
      if (archiveBytes === 0) throw Object.assign(new Error('the downloaded archive is empty'), { code: 'invalid-zip' })

      this.stage(id, tool, entry.version, 'extract', 'Extracting', { received: 0 }, hooks)
      const directory = await readZipDirectory(archivePath)
      await rm(stagingPath, { recursive: true, force: true })
      await mkdir(stagingPath, { recursive: true })
      const prefix = commonDirectory(directory)
      await extractZip(archivePath, stagingPath, {
        ...(prefix === undefined ? {} : { stripPrefix: prefix }),
        directory,
        signal: controller.signal,
        ...(hooks.onProgress === undefined ? {} : {
          onProgress: (progress) => {
            this.stage(
              id, tool, entry.version, 'extract',
              `Extracting ${String(progress.entries)}/${String(progress.totalEntries)} files`,
              { received: progress.written, total: directory.totalUncompressed },
              hooks,
            )
          },
        }),
      })

      this.stage(id, tool, entry.version, 'layout', 'Checking the installation layout', {}, hooks)
      for (const relative of expectedLayout(tool)) {
        if (!existsSync(join(stagingPath, relative))) {
          throw Object.assign(new Error(`the archive is missing ${relative}`), { code: 'layout' })
        }
      }

      this.stage(id, tool, entry.version, 'promote', 'Installing', {}, hooks)
      if (existsSync(finalPath)) {
        // A previously promoted copy exists but did not validate above: move it
        // aside instead of overwriting it in place (§8.4).
        await mkdir(trashRoot, { recursive: true })
        await rename(finalPath, join(trashRoot, `${tool}-${entry.version}-${id}`))
      }
      await rename(stagingPath, finalPath)
      promoted = true

      const validation = await hooks.validate(finalPath)
      if (!validation.ok) {
        throw Object.assign(new Error(validation.error ?? 'the installed executables did not validate'), { code: 'validation' })
      }

      await rm(archivePath, { force: true }).catch(() => {})
      this.jobs.set(id, { ...(this.jobs.get(id) as InstallJobSnapshot), phase: 'done', message: `${label(tool)} ${entry.version} installed`, installPath: finalPath, received: 1, total: 1 })
      hooks.onProgress?.(this.jobs.get(id) as InstallJobSnapshot)
      return { ok: true, installPath: finalPath, version: entry.version, reused: false }
    } catch (error) {
      const cancelled = controller.signal.aborted || (error as { code?: unknown } | null)?.code === 'cancelled'
      const failure = classify(error)
      // An unvalidated promotion is not an installation: take it back out.
      if (promoted) {
        await mkdir(trashRoot, { recursive: true }).catch(() => {})
        await rename(finalPath, join(trashRoot, `${tool}-${entry.version}-${id}-rejected`)).catch(() => {})
      }
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {})
      await rm(archivePath, { force: true, maxRetries: 2 }).catch(() => {})
      const phase: InstallPhase = cancelled ? 'cancelled' : 'failed'
      const message = cancelled ? 'Installation cancelled' : `${label(tool)} could not be installed: ${failure.message}`
      this.jobs.set(id, {
        id, tool, version: entry.version, phase, received: 0, message,
        errorCode: cancelled ? 'cancelled' : failure.code, error: message,
        startedAt: this.jobs.get(id)?.startedAt ?? this.now(), finishedAt: this.now(),
      })
      hooks.onProgress?.(this.jobs.get(id) as InstallJobSnapshot)
      return {
        ok: false, version: entry.version, reused: false,
        errorCode: cancelled ? 'cancelled' : failure.code, error: message,
      }
    } finally {
      this.running.delete(tool)
      const snapshot = this.jobs.get(id)
      if (snapshot !== undefined && (snapshot.phase === 'done' || snapshot.phase === 'failed' || snapshot.phase === 'cancelled')) {
        this.jobs.set(id, { ...snapshot, finishedAt: snapshot.finishedAt ?? this.now() })
      }
    }
  }

  /** Stream one archive to disk, hashing as it arrives. */
  private async download(
    id: string,
    tool: ToolchainId,
    entry: ManifestEntry,
    archivePath: string,
    controller: AbortController,
    hooks: InstallHooks,
  ): Promise<string> {
    const signal = controller.signal
    let response: Response
    try {
      response = await this.fetchImpl(entry.url, { signal, redirect: 'follow' })
    } catch (error) {
      throw Object.assign(new Error(`the download could not start: ${error instanceof Error ? error.message : String(error)}`), { code: 'network' })
    }
    if (!response.ok || response.body === null) {
      throw Object.assign(new Error(`the download answered HTTP ${String(response.status)}`), { code: 'http' })
    }
    const declared = Number(response.headers.get('content-length') ?? '')
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined
    const digest = createHash('sha256')
    let received = 0
    let lastEmit = 0
    let idle = setTimeout(() => { controller.abort() }, this.idleTimeoutMs)
    idle.unref?.()
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length
        digest.update(chunk)
        clearTimeout(idle)
        idle = setTimeout(() => { controller.abort() }, this.idleTimeoutMs)
        idle.unref?.()
        const now = this.now()
        // Progress is throttled: one snapshot per quarter second is enough for a
        // 840 MB transfer, and a per-chunk update would flood the poll.
        const percent = total === undefined ? 0 : Math.round((received / total) * 100)
        if (now - lastEmit >= 250 || percent === 100) {
          lastEmit = now
          this.stage(
            id, tool, entry.version, 'download',
            total === undefined ? `Downloading (${String(received)} bytes)` : `Downloading ${String(percent)}%`,
            { received, ...(total === undefined ? {} : { total }) },
            hooks,
          )
        }
        callback(null, chunk)
      },
    })
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    const sink = createWriteStream(archivePath)
    try {
      await pipeline(source, counter, sink)
    } finally {
      clearTimeout(idle)
    }
    if (total !== undefined && received !== total) {
      throw Object.assign(
        new Error(`the download stopped at ${String(received)} of ${String(total)} bytes`),
        { code: 'network' },
      )
    }
    return digest.digest('hex')
  }
}
