/**
 * `@huaqiu/dsh-plugin-log/client` — browser half of the shared plugin log.
 *
 * The browser has no filesystem and no DSH process identity, so there is no
 * destination to isolate: this module keeps the *same* `PluginLogger` surface
 * as the node half (so a plugin can log identically from either half) but
 * writes to the console with a stable `[pluginId] message` prefix and a
 * structured payload as the second argument — which is what the existing
 * client-side debugging already relies on.
 *
 * It also keeps a small in-memory ring of the most recent records. That costs
 * nothing and gives a user something to copy out of the devtools console
 * (`dumpPluginLogs()`) when a file is not available.
 *
 * Redaction is shared with the node half, so a credential can never reach the
 * browser console through this logger either. The reserved-field rule is shared
 * too: a caller cannot rewrite `level`/`msg`/`pluginId` by passing them as
 * context.
 */

import { isEnabled, parseLevel, type LogLevel } from './levels.js'
import { redact } from './redact.js'
import { RESERVED_FIELDS } from './fields.js'

export type { LogLevel } from './levels.js'
export type LogFields = Record<string, unknown>

export interface PluginLogger {
  readonly pluginId: string
  /** @deprecated Legacy alias for `pluginId`. */
  readonly component: string
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(fields: LogFields): PluginLogger
}

/** Most recent records kept in memory for `dumpPluginLogs()`. */
const RING_SIZE = 200
const ring: Array<Record<string, unknown>> = []

const DEFAULT_LEVEL: LogLevel = 'debug'

function currentLevel(): LogLevel {
  const global = globalThis as { DSH_PLUGIN_LOG_LEVEL?: string }
  return parseLevel(global.DSH_PLUGIN_LOG_LEVEL, DEFAULT_LEVEL)
}

function consoleMethod(level: LogLevel): 'log' | 'info' | 'warn' | 'error' {
  if (level === 'error') return 'error'
  if (level === 'warn') return 'warn'
  if (level === 'info') return 'info'
  return 'log'
}

function sanitize(fields: LogFields | undefined): LogFields {
  if (!fields) return {}
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) continue
    out[key] = value
  }
  return out
}

function createLoggerFor(pluginId: string, defaults: LogFields): PluginLogger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    try {
      if (!isEnabled(level, currentLevel())) return
      const record: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        pluginId,
        component: pluginId,
        msg: message,
      }
      Object.assign(record, sanitize(defaults))
      Object.assign(record, sanitize(fields))

      const safe = redact(record) as Record<string, unknown>
      ring.push(safe)
      if (ring.length > RING_SIZE) ring.shift()

      const { msg, ...rest } = safe
      // eslint-disable-next-line no-console
      console[consoleMethod(level)](`[${pluginId}] ${String(msg)}`, rest)
    } catch {
      /* logging must never throw */
    }
  }

  return {
    pluginId,
    component: pluginId,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLoggerFor(pluginId, { ...defaults, ...fields }),
  }
}

/** Get (or create) the browser logger for `pluginId`. */
export function getLogger(pluginId: string, defaults: LogFields = {}): PluginLogger {
  return createLoggerFor(pluginId, defaults)
}

/** Spec-shaped factory: `createLogger({ pluginId })`. */
export function createLogger(options: { pluginId: string }): PluginLogger {
  return createLoggerFor(options.pluginId, {})
}

/** Snapshot of the in-memory ring — handy from the devtools console. */
export function dumpPluginLogs(): Array<Record<string, unknown>> {
  return ring.slice()
}
