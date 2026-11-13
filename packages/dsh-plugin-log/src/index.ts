/**
 * `@huaqiu/dsh-plugin-log` — one shared, per-DSH-process log for every Huaqiu
 * DSH plugin.
 *
 * ## Why this exists
 *
 * Plugin diagnostics used to live only in the browser console: each plugin's
 * browser half logged to `console.*`, and the node half — the half that
 * actually owns credentials, HTTP routes and agent tools — logged nothing at
 * all outside the DSH process's stdout, which HQ Edge only captures as an
 * opaque text blob.
 *
 * ## What changed (docs/tasks/dsh-plugin-log-isolation.md)
 *
 * The package is shared by every plugin, but the logging RESOURCE belongs to
 * the DSH process that loads them. So:
 *
 *   - one DSH process = one log directory = one active file;
 *   - the directory is `<dsh-root>/<dsh_instance_id>/`, where `dsh-root` is the
 *     parent HQ Edge instance's `dsh/` directory;
 *   - `dsh_instance_id` is generated per DSH LAUNCH — a restart produces a new
 *     directory, a plugin reload does not;
 *   - plugins never configure a destination or a rotation; they only name
 *     themselves (`pluginId`) and get a namespaced logger;
 *   - the DSH process owns rotation, compression, retention and shutdown.
 *
 * Layout:
 *
 *   <HQ_EDGE_HOME>/logs/instances/<edge-instance-id>/dsh/
 *     <dsh-instance-id>/
 *       instance.json          ← identity of this DSH process
 *       owner.lock             ← diagnostic only; existence ≠ ownership
 *       dsh.2026-11-11.log     ← active log (owned by this process)
 *       dsh.2026-11-11.log.gz  ← published archive
 *
 * ## Guarantees
 *
 *  - `getLogger()` and every log call are synchronous, never throw, and never
 *    fail plugin business logic because a destination failed;
 *  - initialization is idempotent across duplicated package copies (the state
 *    lives in a process-wide `globalThis` registry);
 *  - a plugin's `fields` can never override identity or level fields;
 *  - plugin unload/reload never creates a second transport and never closes
 *    the shared one — only DSH shutdown flushes and closes.
 */

import { existsSync, mkdirSync } from 'node:fs'

import { isEnabled, parseLevel, type LogLevel } from './levels.js'
import { redact } from './redact.js'
import { getDshLogRoot, getLogBaseDir, getHqEdgeHome } from './paths.js'
import { RESERVED_FIELDS } from './fields.js'
import {
  awaitRuntimeReady,
  enqueueRecord,
  flushRuntime,
  getDshIdentity,
  getRuntimeSnapshot,
  initializeDshRuntime,
  resetRuntime,
  runRuntimeMaintenance,
  shutdownRuntime,
  type DshLogRuntimeConfig,
  type DshRuntimeSnapshot,
} from './runtime.js'
import type { DshRotationFaults, LoggingHealth, LoggingHealthState } from './rotation.js'

export type { LogLevel } from './levels.js'
export { LOG_LEVELS, levelRank, parseLevel } from './levels.js'
export { redact, REDACTED } from './redact.js'
export type { DshRotationConfig, DshRotationFaults, LoggingHealth, LoggingHealthState } from './rotation.js'
export { DSH_ROTATION, parseSize, todayString } from './rotation.js'
export type { DshInstanceMetadata, DshLogContext } from './identity.js'
export { INSTANCE_METADATA_FILENAME, OWNER_LOCK_FILENAME, RESERVED_FIELDS } from './identity.js'
export type { DshOwnershipHandle } from './ownership.js'
export { acquireDshOwnership, probeDshOwnership } from './ownership.js'
export type { DshMaintenanceOptions, DshMaintenanceReport, LegacyPluginLogReport } from './recovery.js'
export { cleanupExpiredDshInstances, recoverDshInstances, reportLegacyPluginLogs } from './recovery.js'
export type { HostLogSink } from './runtime.js'
export { installHostLogSink } from './runtime.js'

/** Arbitrary structured context attached to a log record. */
export type LogFields = Record<string, unknown>

/** The logger surface every plugin codes against. */
export interface PluginLogger {
  /** Plugin that owns these records (`pluginId`, e.g. `dsh-auth`). */
  readonly pluginId: string
  /** @deprecated Legacy alias for `pluginId`; kept for existing call sites. */
  readonly component: string
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Derive a logger that always carries `fields`. */
  child(fields: LogFields): PluginLogger
}

export interface LoggingOptions {
  /**
   * DSH log ROOT. The per-process instance directory is always appended, so a
   * shared directory can never be written directly. Highest precedence, beats
   * `$DSH_LOG_ROOT` and `$HQ_EDGE_INSTANCE_ID`.
   */
  dir?: string
  /** Alias for {@link dir}, with a name that says what it is. */
  dshLogRoot?: string
  /** Test/host injection of `dsh_instance_id`. Production generates one. */
  dshInstanceId?: string
  /** Minimum file level. Default from `$DSH_PLUGIN_LOG_LEVEL`, else `info`. */
  level?: LogLevel
  /**
   * Minimum level mirrored to DSH's stdout. HQ Edge captures that stream, so
   * this is how a plugin surfaces a problem without anyone opening a file.
   * Default from `$DSH_PLUGIN_LOG_CONSOLE`, else `warn`.
   */
  consoleLevel?: LogLevel | 'off'
  /** Rotate once the active file exceeds this size. Default 10 MiB. */
  maxSize?: string
  /** @deprecated Use {@link maxSize}. Converted to a byte count. */
  maxBytes?: number
  /** @deprecated Retained for source compatibility; superseded by date+size rotation. */
  maxFiles?: number
  /** Days of compressed history to keep. Default 14. */
  retentionDays?: number
  /** Total bytes this instance directory may consume. Default 256 MiB. */
  maxStorageBytes?: number
  /** Gzip rotated files. Default true. */
  compress?: boolean
  /** Test-only fault injection for rotation. */
  faults?: DshRotationFaults
  /** Test-only: bypass the OS ownership lock. */
  skipOwnership?: boolean
  /** Clock override (tests). */
  now?: () => Date
  /** Internal diagnostic sink (tests). */
  onDiagnostic?: (record: Record<string, unknown>) => void
}

const DEFAULT_LEVEL: LogLevel = 'info'
const DEFAULT_CONSOLE_LEVEL: LogLevel = 'warn'

// ── configuration ───────────────────────────────────────────────────────────

interface ResolvedConfig {
  dshLogRoot: string | undefined
  dshInstanceId: string | undefined
  level: LogLevel
  consoleLevel: LogLevel | 'off'
  maxSize: string
  retentionDays: number
  maxStorageBytes: number
  compress: boolean
  faults: DshRotationFaults | undefined
  skipOwnership: boolean
  now: (() => Date) | undefined
  onDiagnostic: ((record: Record<string, unknown>) => void) | undefined
}

let override: LoggingOptions | null = null
let resolved: ResolvedConfig | null = null
let bootstrapped = false
/**
 * Pending boot-banner emission. `flushLogs()` must await it: the banner is
 * written once the destination is decided, so without this barrier a flush
 * could return before the banner (and any rotation it triggers) had landed.
 */
let bootPromise: Promise<void> | null = null

function env(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function consoleLevelFrom(raw: string | undefined, explicit?: LogLevel | 'off'): LogLevel | 'off' {
  if (explicit === 'off') return 'off'
  if (explicit !== undefined) return explicit
  if (raw === 'off' || raw === 'none' || raw === '0') return 'off'
  if (raw === 'all' || raw === '1' || raw === 'true') return 'debug'
  return parseLevel(raw, DEFAULT_CONSOLE_LEVEL)
}

function currentConfig(): ResolvedConfig {
  if (resolved) return resolved
  const o: LoggingOptions = override ?? {}
  const rootFromOption = o.dshLogRoot ?? o.dir
  const rootFromEnv = env('DSH_LOG_ROOT') ?? env('DSH_PLUGIN_LOG_DIR')
  const maxSize =
    o.maxSize ?? (o.maxBytes !== undefined ? `${Math.max(1, Math.floor(o.maxBytes / (1024 * 1024)))}m` : undefined)
  resolved = {
    dshLogRoot: rootFromOption ?? rootFromEnv,
    dshInstanceId: o.dshInstanceId,
    level: o.level ?? parseLevel(env('DSH_PLUGIN_LOG_LEVEL'), DEFAULT_LEVEL),
    consoleLevel: consoleLevelFrom(env('DSH_PLUGIN_LOG_CONSOLE'), o.consoleLevel),
    maxSize: maxSize ?? env('DSH_PLUGIN_LOG_MAX_BYTES_SIZE') ?? '10m',
    retentionDays: o.retentionDays ?? readInt(env('DSH_PLUGIN_LOG_RETENTION_DAYS'), 14),
    maxStorageBytes: o.maxStorageBytes ?? readInt(env('DSH_PLUGIN_LOG_MAX_STORAGE_BYTES'), 256 * 1024 * 1024),
    compress: o.compress ?? readBool(env('DSH_PLUGIN_LOG_COMPRESS'), true),
    faults: o.faults,
    skipOwnership: o.skipOwnership === true,
    now: o.now,
    onDiagnostic: o.onDiagnostic,
  }
  return resolved
}

function runtimeConfig(cfg: ResolvedConfig): DshLogRuntimeConfig {
  return {
    dshLogRoot: cfg.dshLogRoot,
    dshInstanceId: cfg.dshInstanceId,
    rotation: {
      frequency: 'daily',
      maxSize: cfg.maxSize,
      retentionDays: cfg.retentionDays,
      maxStorageBytes: cfg.maxStorageBytes,
      compress: cfg.compress,
    },
    faults: cfg.faults,
    skipOwnership: cfg.skipOwnership,
    now: cfg.now,
    onDiagnostic: cfg.onDiagnostic,
  }
}

/**
 * Programmatically configure logging. Call before the first `getLogger()`;
 * once the destination is established a later call only takes effect after
 * {@link shutdownLogging} + {@link resetLogging} (tests, host re-init).
 */
export function configureLogging(options: LoggingOptions): void {
  override = { ...(override ?? {}), ...options }
  resolved = null
  if (getDshIdentity() !== null) {
    // The destination is already established. Say so in the current log
    // instead of silently pretending the new configuration applies.
    enqueueRecord(
      serialize({
        time: Date.now(),
        ts: new Date().toISOString(),
        level: 'warn',
        msg: 'configureLogging called after logging started; restart required for it to take effect',
        pluginId: 'dsh-plugin-log',
        component: 'dsh-plugin-log',
        pid: process.pid,
      }),
    )
  }
}

/** Forgets all configuration and cached state. Test/teardown helper. */
export async function resetLogging(): Promise<void> {
  if (bootPromise) await bootPromise
  await resetRuntime()
  override = null
  resolved = null
  bootstrapped = false
  bootPromise = null
}

// ── record building ─────────────────────────────────────────────────────────

/** Drops reserved keys so a plugin cannot spoof identity or level. */
function sanitize(fields: LogFields | undefined): LogFields {
  if (!fields) return {}
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) continue
    out[key] = value
  }
  return out
}

/** JSON.stringify that can never throw (BigInt, cycles in exotic values). */
function serialize(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record)
  } catch {
    try {
      return JSON.stringify({
        time: Date.now(),
        ts: new Date().toISOString(),
        level: 'error',
        msg: '[unserializable log record]',
        pluginId: typeof record.pluginId === 'string' ? record.pluginId : 'unknown',
        pid: process.pid,
      })
    } catch {
      return '{"level":"error","msg":"[unserializable log record]"}'
    }
  }
}

function consoleMethod(level: LogLevel): 'log' | 'info' | 'warn' | 'error' {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warn'
  if (level === 'info') return 'info'
  return 'log'
}

function emit(pluginId: string, defaults: LogFields, level: LogLevel, message: string, fields?: LogFields): void {
  try {
    const cfg = currentConfig()
    const fileEnabled = isEnabled(level, cfg.level)
    const consoleEnabled = cfg.consoleLevel !== 'off' && isEnabled(level, cfg.consoleLevel)
    if (!fileEnabled && !consoleEnabled) return

    ensureInitialized()

    const identity = getDshIdentity()
    const record: LogFields = {
      time: Date.now(),
      // Legacy ISO timestamp; `time` is the canonical field.
      ts: new Date().toISOString(),
      level,
      msg: message,
      pluginId,
      // Legacy alias, still emitted so existing `grep '"component"'` recipes
      // keep working. Never settable by the caller (see RESERVED_FIELDS).
      component: pluginId,
      installationId: identity?.installationId ?? null,
      hostType: identity?.hostType ?? null,
      hostInstanceId: identity?.hostInstanceId ?? null,
      edgeInstanceId: identity?.edgeInstanceId ?? null,
      dshInstanceId: identity?.dshInstanceId ?? null,
      pid: identity?.pid ?? process.pid,
    }
    Object.assign(record, sanitize(defaults))
    Object.assign(record, sanitize(fields))

    const safe = redact(record) as LogFields

    if (fileEnabled) {
      enqueueRecord(`${serialize(safe)}\n`)
    }
    if (consoleEnabled) {
      const { msg, ...rest } = safe
      // eslint-disable-next-line no-console
      console[consoleMethod(level)](`[${pluginId}] ${String(msg)}`, rest)
    }
  } catch {
    /* logging must never throw into plugin business logic */
  }
}

function createLoggerFor(pluginId: string, defaults: LogFields): PluginLogger {
  return {
    pluginId,
    component: pluginId,
    debug: (message, fields) => emit(pluginId, defaults, 'debug', message, fields),
    info: (message, fields) => emit(pluginId, defaults, 'info', message, fields),
    warn: (message, fields) => emit(pluginId, defaults, 'warn', message, fields),
    error: (message, fields) => emit(pluginId, defaults, 'error', message, fields),
    child: (fields) => createLoggerFor(pluginId, { ...defaults, ...fields }),
  }
}

/**
 * Gets (or creates) the logger for `pluginId`.
 *
 * `pluginId` should be the value used everywhere else in that plugin's output —
 * `dsh-auth`, `dsh-artifacts`, `dsh-schematic-gen`, or the full package name
 * (`@huaqiu/dsh-plugin-eda`) when that is less ambiguous. It is attached to
 * every record, which is what makes per-plugin filtering possible without a
 * file per plugin.
 */
export function getLogger(pluginId: string, defaults: LogFields = {}): PluginLogger {
  ensureInitialized()
  bootstrap()
  return createLoggerFor(pluginId, defaults)
}

/** Spec-shaped factory: `createLogger({ pluginId })`. Equivalent to `getLogger`. */
export function createLogger(options: { pluginId: string }): PluginLogger {
  return getLogger(options.pluginId)
}

// ── initialization / boot banner ────────────────────────────────────────────

function ensureInitialized(): void {
  if (getDshIdentity() !== null) return
  initializeDshRuntime(runtimeConfig(currentConfig()))
}

/**
 * One record describing where this process logs and which identities it
 * carries. This is the line that makes the next "one editor logged, the other
 * did not" investigation cheap.
 *
 * Emitted AFTER the destination is decided, so `ownership` and `logFile` in the
 * banner describe reality instead of the transient "pending" state. Records
 * logged before then are buffered and appear before it in the file.
 */
function bootstrap(): void {
  if (bootstrapped) return
  bootstrapped = true
  bootPromise = awaitRuntimeReady().then(() => emitBootRecord())
}

function emitBootRecord(): void {
  const snapshot = getRuntimeSnapshot()
  const identity = getDshIdentity()
  let hqEdgeHome: string | null = null
  try {
    hqEdgeHome = getHqEdgeHome()
  } catch {
    hqEdgeHome = null
  }
  emit('dsh-plugin-log', {}, 'info', 'dsh plugin log ready', {
    logRoot: snapshot.logRoot,
    instanceDir: snapshot.instanceDir,
    logFile: snapshot.logFile,
    ownership: snapshot.ownership,
    degradedReason: snapshot.degradedReason,
    version: identity?.version ?? null,
    targetHost: identity?.targetHost ?? null,
    dshHome: identity?.dshHome ?? null,
    hqEdgeHome,
    level: currentConfig().level,
    consoleLevel: currentConfig().consoleLevel,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  })
}

// ── introspection ───────────────────────────────────────────────────────────

/** Absolute directory this DSH process exclusively owns, or null before init. */
export function logDir(): string | null {
  ensureInitialized()
  return getRuntimeSnapshot().instanceDir
}

/** Absolute path of the active log file, or null before it is open. */
export function logFilePath(): string | null {
  return getRuntimeSnapshot().logFile
}

/** Root that contains one directory per DSH instance. */
export function logRoot(): string | null {
  ensureInitialized()
  return getRuntimeSnapshot().logRoot
}

/** Identity of this DSH process (null before initialization). */
export function dshInstanceInfo(): DshRuntimeSnapshot {
  return getRuntimeSnapshot()
}

export interface LoggingHealthReport extends LoggingHealth {
  instanceDir: string | null
  logFile: string | null
  ownership: DshRuntimeSnapshot['ownership']
  degradedReason: string | null
}

/** Destination health, for a diagnostics/health endpoint or a support bundle. */
export function getLoggingHealth(): LoggingHealthReport {
  const snapshot = getRuntimeSnapshot()
  const health = snapshot.health
  const state: LoggingHealthState = health
    ? health.state
    : snapshot.degradedReason !== null
      ? 'unavailable'
      : snapshot.ready
        ? 'healthy'
        : 'initializing'
  return {
    state,
    reason: health?.reason ?? snapshot.degradedReason ?? (snapshot.ready ? 'destination open' : 'not initialized'),
    droppedRecords: (health?.droppedRecords ?? 0) + snapshot.droppedBeforeReady,
    rotationCount: health?.rotationCount ?? 0,
    lastError: health?.lastError ?? null,
    instanceDir: snapshot.instanceDir,
    logFile: snapshot.logFile,
    ownership: snapshot.ownership,
    degradedReason: snapshot.degradedReason,
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/** Waits until the destination is decided. For tests and startup diagnostics. */
export function ready(): Promise<boolean> {
  ensureInitialized()
  return awaitRuntimeReady()
}

/** Waits for all pending records (and any rotation they triggered) to land. */
export async function flushLogs(): Promise<void> {
  if (bootPromise) await bootPromise
  await flushRuntime()
}

/**
 * Final flush + close + ownership release.
 *
 * Owned by the DSH host. A plugin must NEVER call this: it would close the
 * shared destination for every other plugin in the process.
 */
export async function shutdownLogging(): Promise<void> {
  if (bootPromise) await bootPromise
  await shutdownRuntime()
}

/** Runs historical recovery/retention now (tests, or a DSH maintenance hook). */
export async function runMaintenance(
  options: { timeBudgetMs?: number; retentionDays?: number; minAgeMs?: number } = {},
): Promise<void> {
  ensureInitialized()
  await awaitRuntimeReady()
  await runRuntimeMaintenance(options)
}

/**
 * Creates the log root if it does not exist. Exposed for the DSH host's
 * startup path, which may want to validate the destination before plugins load.
 */
export function ensureLogRoot(): string {
  const cfg = currentConfig()
  const root = cfg.dshLogRoot ?? getDshLogRoot(getDshIdentity()?.edgeInstanceId ?? null)
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
  } catch {
    /* the runtime reports the failure with full context */
  }
  return root
}
