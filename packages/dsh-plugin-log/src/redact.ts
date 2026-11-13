/**
 * Credential redaction for `@huaqiu/dsh-plugin-log`.
 *
 * The whole point of a shared plugin log is that it is safe to hand to someone
 * else when debugging — which means it must never become a second, unmanaged
 * copy of the user's credential. Everything written through this logger goes
 * through `redact()` first, so a caller cannot leak a token by accident.
 *
 * Two rules:
 *
 *  1. **Key-based** — any field whose name looks credential-ish
 *     (`token`, `authorization`, `password`, `cookie`, `apiKey`, …) has its
 *     value replaced, at any nesting depth.
 *  2. **Shape-based** — string values that look like a bearer header or a
 *     long opaque secret are replaced even when the key is innocent
 *     (`headers: ['Authorization: Bearer ey…']`).
 *
 * Redaction is deliberately key-name based rather than "redact every long
 * string": log readability matters, and most long strings (project paths,
 * URLs, artifact ids) carry no secret.
 */

/** Field names whose values are always replaced. Matches at any depth. */
const SENSITIVE_KEY = /(token|secret|password|passwd|pwd|authorization|cookie|api[-_]?key|access[-_]?key|credential)/i

/** `Bearer <opaque>` / `Basic <opaque>` inside a free-form string. */
const BEARER_IN_STRING = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i

/** Strings at least this long that look like a single opaque credential blob. */
const OPAQUE_SECRET = /^[A-Za-z0-9_-]{32,}$/

/**
 * UUIDs are identifiers, not secrets. Every record carries at least
 * `installationId` / `edgeInstanceId` / `dshInstanceId`, all UUID-shaped, so
 * without this exemption the shape-based rule would blank out exactly the
 * fields that make a multi-process log attributable.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const REDACTED = '[redacted]'

/** Maximum object depth walked before the value is collapsed. Cycle-safe. */
const MAX_DEPTH = 6

/**
 * Return a copy of `value` with credential-ish fields replaced.
 *
 * Never throws and never mutates the caller's object — a logging call must not
 * be able to change plugin state or crash the host.
 */
export function redact(value: unknown, depth = 0): unknown {
  try {
    return redactInner(value, depth, new WeakSet<object>())
  } catch {
    // Anything unexpected (proxy getters, exotic objects) — do not log it.
    return REDACTED
  }
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'symbol') return value.toString()

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), ...(value.stack ? { stack: value.stack } : {}) }
  }
  if (value instanceof Date) return value.toISOString()

  if (depth >= MAX_DEPTH) return '[deep]'
  if (seen.has(value as object)) return '[circular]'

  if (Array.isArray(value)) {
    seen.add(value)
    const out = value.map((item) => redactInner(item, depth + 1, seen))
    seen.delete(value)
    return out
  }

  if (typeof value === 'object') {
    seen.add(value as object)
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactInner(raw, depth + 1, seen)
    }
    seen.delete(value as object)
    return out
  }

  return String(value)
}

/** Redact credentials embedded in an otherwise ordinary string. */
function redactString(value: string): string {
  if (BEARER_IN_STRING.test(value)) return value.replace(BEARER_IN_STRING, '$1 ' + REDACTED)
  if (UUID_SHAPE.test(value)) return value
  // A bare 32+ char opaque blob is almost always a credential. Project paths,
  // URLs and sentences all contain separators, so they survive this filter.
  if (OPAQUE_SECRET.test(value)) return REDACTED
  return value
}
