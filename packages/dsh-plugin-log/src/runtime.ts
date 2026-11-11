/**
 * Process-wide logging runtime for ONE DSH process.
 *
 * This module is the only place that decides WHERE records go. Plugins never
 * see it: they call `getLogger()` and get a namespaced logger.
 *
 * Startup order (docs/tasks/dsh-plugin-log-isolation.md §4):
 *   1. read the parent logging context from the environment
 *   2. generate `dsh_instance_id` (per LAUNCH, never per plugin)
 *   3. create `<dsh-root>/<dsh_instance_id>/` exclusively
 *   4. write `instance.json` atomically (never overwrite)
 *   5. acquire the OS ownership lock for that directory
 *   6. open `dsh.<date>.log` and replay records buffered during 1–5
 *
 * Steps 1–4 are synchronous so that `logDir()` / `logFilePath()` are correct
 * the instant DSH starts. Step 5 is asynchronous (a socket bind resolves on the
 * event loop), so records emitted in the meantime are buffered — bounded — and
 * replayed after ownership is confirmed. If ownership cannot be established the
 * destination is marked unavailable and the buffer is dropped: there is
 * deliberately no fallback to a shared writable file.
 *
 * ## Why `globalThis`
 *
 * A plugin bundle may inline its own copy of this package, so a module-level
 * singleton would give each copy its own sink, rotation counter and buffer.
 * The state lives on `globalThis` under a `Symbol.for` key, which is a genuine
 * process-wide registry: every copy — bundled, external or duplicated —
 * cooperates on one destination.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  DSH_METADATA_SCHEMA_VERSION,
  FATAL_LOG_FILENAME,
  INSTANCE_METADATA_FILENAME,
  createDshIdentity,
  instanceDirFor,
  readDshInstanceMetadata,
  readDshLogContext,
  type DshInstanceMetadata,
  type DshLogContext,
} from './identity.js'
import { acquireDshOwnership, type DshOwnershipHandle } from './ownership.js'
import {
  DSH_ROTATION,
  DshLogWriter,
  type DshRotationConfig,
  type DshRotationFaults,
  type LoggingHealth,
} from './rotation.js'
import { cleanupExpiredDshInstances, recoverDshInstances, reportLegacyPluginLogs } from './recovery.js'
import { appendDiagnostic, atomicCreateNewFile } from './fs-utils.js'
import { getLogBaseDir } from './paths.js'

const STATE_KEY = Symbol.for('@huaqiu/dsh-plugin-log/runtime')
const HOST_SINK_KEY = Symbol.for('@huaqiu/dsh-plugin-log/host-sink')
const STDIO_GUARD_KEY = Symbol.for('@huaqiu/dsh-plugin-log/stdio')

/**
 * A sink supplied by the DSH host. When present the package delegates the
 * actual transport (and its lifecycle) to DSH instead of opening its own file
 * — the preferred integration when DSH exposes a native logging service.
 */
export interface HostLogSink {
  write(line: string): void
  flush?(): Promise<void>
  close?(): void
}

export interface DshLogRuntimeConfig {
  /** Explicit DSH log ROOT. The instance directory is always appended. */
  dshLogRoot?: string
  /** HQ Edge log base override, used when no DSH root is given. */
  baseDir?: string
  /** Test / host injection of the instance id. Production generates one. */
  dshInstanceId?: string
  rotation?: DshRotationConfig
  /** Test-only: skip the OS lock (never in production). */
  skipOwnership?: boolean
  ownershipTimeoutMs?: number
  now?: () => Date
  faults?: DshRotationFaults
  /** Extra structured sink for internal diagnostics (tests). */
  onDiagnostic?: (record: Record<string, unknown>) => void
}

type OwnershipState = 'pending' | 'held' | 'skipped' | 'unavailable'

interface DshRuntimeState {
  readonly schema: 2
  config: DshLogRuntimeConfig | null
  context: DshLogContext | null
  identity: DshInstanceMetadata | null
  instanceDir: string | null
  ownership: DshOwnershipHandle | null
  ownershipState: OwnershipState
  ownershipPromise: Promise<void> | null
  writer: DshLogWriter | null
  ready: boolean
  degradedReason: string | null
  pending: string[]
  pendingBytes: number
  droppedBeforeReady: number
  shutdown: boolean
  shutdownPromise: Promise<void> | null
  maintenanceScheduled: boolean
  generation: number
}

const MAX_PENDING_RECORDS = 2_000
const MAX_PENDING_BYTES = 1024 * 1024
const DEFAULT_OWNERSHIP_TIMEOUT_MS = 5_000
const FLUSH_TIMEOUT_MS = 5_000
const MAINTENANCE_DELAY_MS = 1_500
const MAINTENANCE_BUDGET_MS = 3_000
const RETENTION_DAYS = 30

function freshState(): DshRuntimeState {
  return {
    schema: 2,
    config: null,
    context: null,
    identity: null,
    instanceDir: null,
    ownership: null,
    ownershipState: 'pending',
    ownershipPromise: null,
    writer: null,
    ready: false,
    degradedReason: null,
    pending: [],
    pendingBytes: 0,
    droppedBeforeReady: 0,
    shutdown: false,
    shutdownPromise: null,
    maintenanceScheduled: false,
    generation: 0,
  }
}

function state(): DshRuntimeState {
  const registry = globalThis as Record<symbol, unknown>
  const existing = registry[STATE_KEY] as DshRuntimeState | undefined
  if (existing && existing.schema === 2) return existing
  const created = freshState()
  registry[STATE_KEY] = created
  return created
}

function hostSink(): HostLogSink | null {
  const registry = globalThis as Record<symbol, unknown>
  return (registry[HOST_SINK_KEY] as HostLogSink | undefined) ?? null
}

/**
 * Installs a DSH-host-provided sink. MUST be called before the first log
 * record: once the package has established its own destination (and taken the
 * ownership lock), silently switching transports would abandon a directory it
 * owns. A late call is ignored and diagnosed rather than throwing.
 */
export function installHostLogSink(sink: HostLogSink | null): void {
  const registry = globalThis as Record<symbol, unknown>
  if (sink === null) {
    delete registry[HOST_SINK_KEY]
    return
  }
  const s = state()
  if (s.identity !== null) {
    appendDiagnostic(join(s.instanceDir ?? '.', FATAL_LOG_FILENAME), {
      event: 'host-sink-installed-too-late',
      detail: 'installHostLogSink() must be called before the first log record',
    })
    return
  }
  registry[HOST_SINK_KEY] = sink
}

function degraded(reason: string, detail?: string): void {
  const s = state()
  s.degradedReason = reason
  s.ownershipState = 'unavailable'
  if (s.instanceDir && detail) {
    appendDiagnostic(join(s.instanceDir, FATAL_LOG_FILENAME), {
      event: 'logging-degraded',
      reason,
      detail,
      dshInstanceId: s.identity?.dshInstanceId ?? null,
      pid: process.pid,
    })
  }
}

// ── stdio guard ─────────────────────────────────────────────────────────────

interface StdioGuard {
  stdout: boolean
  stderr: boolean
  reported: boolean
}

/**
 * DSH's stdout/stderr are pipes owned by HQ Edge. If the parent dies or closes
 * the pipe, writing to it raises EPIPE asynchronously on the stream, which
 * without a listener is an uncaught exception: a logging call would take the
 * DSH process down. Install one `error` listener per stream, mark the stream
 * unusable and stop mirroring to it.
 */
function installStdioGuard(): StdioGuard {
  const registry = globalThis as Record<symbol, unknown>
  const existing = registry[STDIO_GUARD_KEY] as StdioGuard | undefined
  if (existing) return existing

  const guard: StdioGuard = { stdout: true, stderr: true, reported: false }
  const attach = (name: 'stdout' | 'stderr', stream: NodeJS.WriteStream | undefined): void => {
    if (!stream || typeof stream.on !== 'function') return
    stream.on('error', (err: unknown) => {
      guard[name] = false
      if (guard.reported) return
      guard.reported = true
      const s = state()
      if (!s.instanceDir) return
      appendDiagnostic(join(s.instanceDir, FATAL_LOG_FILENAME), {
        event: 'stdio-error',
        stream: name,
        code: (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
        note: 'console mirroring disabled; file logging unaffected',
      })
    })
  }
  attach('stdout', process.stdout)
  attach('stderr', process.stderr)
  registry[STDIO_GUARD_KEY] = guard
  return guard
}

/** True when `name` is still safe to write to. */
export function isStdioHealthy(name: 'stdout' | 'stderr'): boolean {
  return installStdioGuard()[name]
}

// ── initialization ──────────────────────────────────────────────────────────

/**
 * Creates the instance directory and metadata, then starts ownership
 * acquisition in the background. Idempotent: later calls return immediately.
 */
export function initializeDshRuntime(config: DshLogRuntimeConfig = {}): void {
  const s = state()
  if (s.shutdown) return
  if (s.identity !== null) return

  s.config = config
  s.generation += 1
  const generation = s.generation

  const context = readDshLogContext(process.env, {
    dshLogRoot: config.dshLogRoot,
    baseDir: config.baseDir,
  })
  s.context = context

  // Ensure the root exists before the exclusive per-instance creation, which
  // must fail rather than reuse an existing directory.
  try {
    mkdirSync(context.dshLogRoot, { recursive: true })
  } catch (err) {
    degraded('dsh-log-root-unavailable', String(err))
    return
  }

  let identity: DshInstanceMetadata | null = null
  let instanceDir: string | null = null
  for (let attempt = 0; attempt < 3 && identity === null; attempt += 1) {
    const candidate = createDshIdentity(context, {
      dshInstanceId: config.dshInstanceId,
      now: config.now?.(),
    })
    const candidateDir = instanceDirFor(candidate)

    let created = false
    try {
      // Non-recursive on purpose: a UUID collision must be visible, never
      // silently merged.
      mkdirSync(candidateDir)
      created = true
    } catch {
      created = false
    }

    if (!created) {
      if (!existsSync(candidateDir)) {
        degraded('instance-directory-unavailable', candidateDir)
        return
      }
      // The directory already exists. Adopt it ONLY when its metadata names
      // this exact instance id (a restart of the same logical instance, e.g.
      // a test with a fixed id, or a crashed process whose directory was
      // never cleaned). Ownership is still acquired later: if a live process
      // owns it, the destination degrades instead of sharing the file.
      const existing = readDshInstanceMetadata(candidateDir)
      if (existing !== null && existing.dshInstanceId === candidate.dshInstanceId) {
        identity = candidate
        instanceDir = candidateDir
        break
      }
      if (config.dshInstanceId !== undefined) {
        degraded('instance-directory-collision', candidateDir)
        return
      }
      continue
    }

    const metadataPath = join(candidateDir, INSTANCE_METADATA_FILENAME)
    const metadata = { ...candidate, schemaVersion: DSH_METADATA_SCHEMA_VERSION }
    if (!atomicCreateNewFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)) {
      degraded('instance-metadata-collision', metadataPath)
      return
    }
    identity = candidate
    instanceDir = candidateDir
  }

  if (identity === null || instanceDir === null) {
    degraded('instance-identity-unavailable')
    return
  }

  s.identity = identity
  s.instanceDir = instanceDir

  // A host-provided sink replaces the file transport entirely (the host owns
  // rotation, ownership and shutdown in that mode).
  if (hostSink() !== null) {
    s.ready = true
    s.ownershipState = 'skipped'
    s.writer = null
    flushPendingIntoHost()
    return
  }

  const rotation = config.rotation ?? DSH_ROTATION
  const skipOwnership = config.skipOwnership === true

  s.ownershipPromise = (async () => {
    let handle: DshOwnershipHandle | null = null
    try {
      handle = await acquireDshOwnership(instanceDir as string, identity!.dshInstanceId, {
        diagnostics: true,
      })
    } catch {
      handle = null
    }
    if (s.generation !== generation) {
      handle?.release()
      return
    }
    if (!handle && !skipOwnership) {
      degraded('ownership-unavailable', instanceDir ?? undefined)
      dropPending()
      return
    }
    s.ownership = handle
    s.ownershipState = skipOwnership ? 'skipped' : 'held'

    const writer = new DshLogWriter({
      dir: instanceDir as string,
      baseName: 'dsh',
      cfg: rotation,
      faults: config.faults,
      now: config.now,
      onDiagnostic: config.onDiagnostic,
    })
    writer.open()
    if (s.shutdown) {
      await writer.close()
      handle?.release()
      return
    }
    s.writer = writer
    s.ready = true
    flushPendingIntoWriter(writer)
    scheduleMaintenance()
  })()
}

function dropPending(): void {
  const s = state()
  s.droppedBeforeReady += s.pending.length
  s.pending = []
  s.pendingBytes = 0
}

function flushPendingIntoWriter(writer: DshLogWriter): void {
  const s = state()
  const pending = s.pending
  s.pending = []
  s.pendingBytes = 0
  for (const line of pending) writer.write(line)
}

function flushPendingIntoHost(): void {
  const sink = hostSink()
  if (!sink) return
  const s = state()
  const pending = s.pending
  s.pending = []
  s.pendingBytes = 0
  for (const line of pending) {
    try {
      sink.write(line)
    } catch {
      s.droppedBeforeReady += 1
    }
  }
}

// ── record intake ───────────────────────────────────────────────────────────

/**
 * Accepts one already-serialized JSONL record. Never throws, never blocks.
 * Before the destination is ready the record is buffered (bounded); if the
 * destination is unavailable it is dropped — logging must never fail plugin
 * business logic.
 */
export function enqueueRecord(line: string): void {
  const s = state()
  if (s.shutdown) return

  const sink = hostSink()
  if (sink !== null) {
    try {
      sink.write(line)
    } catch {
      s.droppedBeforeReady += 1
    }
    return
  }

  if (s.writer !== null && s.ready) {
    s.writer.write(line)
    return
  }
  if (s.degradedReason !== null && s.ownershipState === 'unavailable') {
    s.droppedBeforeReady += 1
    return
  }
  const bytes = Buffer.byteLength(line, 'utf8')
  if (s.pending.length >= MAX_PENDING_RECORDS || s.pendingBytes + bytes > MAX_PENDING_BYTES) {
    s.droppedBeforeReady += 1
    return
  }
  s.pending.push(line)
  s.pendingBytes += bytes
}

// ── readiness / health ──────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref()
  })])
}

/** Resolves when the destination is decided (held, skipped or unavailable). */
export async function awaitRuntimeReady(timeoutMs = DEFAULT_OWNERSHIP_TIMEOUT_MS): Promise<boolean> {
  const s = state()
  if (s.ready) return true
  if (s.degradedReason !== null) return false
  if (!s.ownershipPromise) return false
  const settled = await withTimeout(
    s.ownershipPromise.then(() => s.ready || s.degradedReason === null),
    timeoutMs,
    false,
  )
  return settled && (s.ready || s.ownershipState === 'skipped')
}

export interface DshRuntimeSnapshot {
  readonly dshInstanceId: string | null
  readonly instanceDir: string | null
  readonly logFile: string | null
  readonly logRoot: string | null
  readonly ready: boolean
  readonly ownership: OwnershipState
  readonly degradedReason: string | null
  readonly droppedBeforeReady: number
  readonly health: LoggingHealth | null
}

export function getRuntimeSnapshot(): DshRuntimeSnapshot {
  const s = state()
  return {
    dshInstanceId: s.identity?.dshInstanceId ?? null,
    instanceDir: s.instanceDir,
    logFile: s.writer?.path ?? null,
    logRoot: s.context?.dshLogRoot ?? null,
    ready: s.ready,
    ownership: s.ownershipState,
    degradedReason: s.degradedReason,
    droppedBeforeReady: s.droppedBeforeReady,
    health: s.writer?.getHealth() ?? null,
  }
}

/** Identity of this DSH process, or null before initialization. */
export function getDshIdentity(): DshInstanceMetadata | null {
  return state().identity
}

/** Context the log root and parent identities resolved from. */
export function getDshLogContext(): DshLogContext | null {
  return state().context
}

// ── maintenance ─────────────────────────────────────────────────────────────

/**
 * Repairs and prunes HISTORICAL sibling directories. Runs on the serialized
 * writer chain's behalf but touches only directories whose ownership lock is
 * free — i.e. whose DSH process is gone.
 */
export async function runRuntimeMaintenance(
  options: { timeBudgetMs?: number; retentionDays?: number; minAgeMs?: number } = {},
): Promise<void> {
  const s = state()
  if (!s.instanceDir || !s.context) return
  if (s.shutdown) return
  const ownInstanceDir = s.instanceDir
  const instancesRoot = s.context.dshLogRoot
  const report = (record: Record<string, unknown>) => {
    // Diagnostics go to the CURRENT process's own directory, never a
    // historical one that may be deleted by this very pass.
    appendDiagnostic(join(ownInstanceDir, 'maintenance.log'), record)
  }
  try {
    await recoverDshInstances({
      instancesRoot,
      ownInstanceDir,
      timeBudgetMs: options.timeBudgetMs ?? MAINTENANCE_BUDGET_MS,
      minAgeMs: options.minAgeMs,
      report,
    })
    await cleanupExpiredDshInstances({
      instancesRoot,
      ownInstanceDir,
      retentionDays: options.retentionDays ?? RETENTION_DAYS,
      timeBudgetMs: options.timeBudgetMs ?? MAINTENANCE_BUDGET_MS,
      report,
    })
    const legacy = await reportLegacyPluginLogs(getLogBaseDir(s.config?.baseDir))
    if (legacy.files.length > 0) report({ event: 'legacy-plugin-logs', ...legacy })
  } catch {
    /* maintenance must never affect plugin logging */
  }
}

function scheduleMaintenance(): void {
  const s = state()
  if (s.maintenanceScheduled) return
  s.maintenanceScheduled = true
  const timer = setTimeout(() => {
    void runRuntimeMaintenance()
  }, MAINTENANCE_DELAY_MS)
  timer.unref()
}

// ── flush / shutdown ────────────────────────────────────────────────────────

/** Waits for everything enqueued so far, bounded. */
export async function flushRuntime(): Promise<void> {
  const s = state()
  const sink = hostSink()
  if (sink !== null) {
    try {
      await sink.flush?.()
    } catch {
      /* a failed flush must not surface */
    }
    return
  }
  if (s.ownershipPromise) await withTimeout(s.ownershipPromise, FLUSH_TIMEOUT_MS, undefined)
  if (s.writer) await withTimeout(s.writer.flush(), FLUSH_TIMEOUT_MS, undefined)
}

/**
 * Final flush + close + ownership release. Owned by the DSH host only: a
 * plugin unload must never call this, because it would close the destination
 * for every other plugin in the process.
 */
export async function shutdownRuntime(): Promise<void> {
  const s = state()
  if (s.shutdownPromise) return s.shutdownPromise
  s.shutdown = true
  s.shutdownPromise = (async () => {
    const sink = hostSink()
    if (sink !== null) {
      try {
        await sink.flush?.()
        sink.close?.()
      } catch {
        /* ignore */
      }
      return
    }
    if (s.ownershipPromise) await withTimeout(s.ownershipPromise, FLUSH_TIMEOUT_MS, undefined)
    const writer = s.writer
    s.writer = null
    if (writer) {
      await withTimeout(writer.flush(), FLUSH_TIMEOUT_MS, undefined)
      await withTimeout(writer.close(), FLUSH_TIMEOUT_MS, undefined)
    }
    const ownership = s.ownership
    s.ownership = null
    ownership?.release()
  })()
  return s.shutdownPromise
}

/**
 * Test/teardown helper: shuts the runtime down and forgets all state so a test
 * can re-initialize with different configuration. Never called in production.
 */
export async function resetRuntime(): Promise<void> {
  const s = state()
  await shutdownRuntime()
  const registry = globalThis as Record<symbol, unknown>
  const fresh = freshState()
  fresh.generation = s.generation + 1
  registry[STATE_KEY] = fresh
}
