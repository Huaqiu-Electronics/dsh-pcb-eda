/**
 * Exclusive, OS-backed ownership of ONE DSH instance log directory.
 *
 * The lock is a **bound IPC endpoint held open by the owning DSH process**:
 *
 *   Windows : named pipe  \\.\pipe\hq-edge-dsh-instance-<sha256(dir)>
 *   POSIX   : unix socket <dir>/.owner.sock
 *
 * Creating a second server on the same endpoint fails with EADDRINUSE while
 * the owner is alive, and the OS closes the handle — releasing the lock — the
 * instant the owner terminates, including abnormal termination. There is no
 * PID check, no heartbeat and no stale-timestamp heuristic: a DSH process that
 * crashes must not leave a lock that a later process has to guess about.
 *
 * The endpoint is keyed by the INSTANCE DIRECTORY, so two DSH processes under
 * the same HQ Edge process, two DSH processes under different Edge processes,
 * and a DSH process plus the Edge maintenance job never contend for the same
 * lock unless they genuinely target the same directory.
 *
 * `owner.lock` is a diagnostic JSONL file only. Its existence NEVER implies
 * ownership, and it is intentionally left behind after exit: it is the record
 * of which process last owned the directory and when.
 */
import { createConnection, createServer, type Server } from 'node:net'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { appendDiagnostic, errorCode } from './fs-utils.js'
import { OWNER_LOCK_FILENAME, RECOVERY_LOG_FILENAME } from './identity.js'

const PIPE_PREFIX = '\\\\.\\pipe\\hq-edge-dsh-instance-'
const SOCKET_FILENAME = '.owner.sock'

export interface DshOwnershipHandle {
  readonly instanceDir: string
  readonly dshInstanceId: string
  readonly released: boolean
  /** Idempotent. Releases the OS handle; never deletes another owner's data. */
  release(): void
}

function normalizedDir(dir: string): string {
  const absolute = resolve(dir)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Deterministic, filesystem-safe lock key. Not an identity — a lookup key. */
export function ownershipKey(dir: string): string {
  return createHash('sha256').update(normalizedDir(dir)).digest('hex').slice(0, 32)
}

function endpointFor(dir: string): string {
  return process.platform === 'win32' ? `${PIPE_PREFIX}${ownershipKey(dir)}` : join(resolve(dir), SOCKET_FILENAME)
}

function recordOwnerClaim(dir: string, dshInstanceId: string): void {
  appendDiagnostic(join(dir, OWNER_LOCK_FILENAME), {
    event: 'ownership-claimed',
    pid: process.pid,
    dshInstanceId,
    acquiredAt: new Date().toISOString(),
  })
}

class DshOwnershipHandleImpl implements DshOwnershipHandle {
  private _released = false

  constructor(
    public readonly instanceDir: string,
    public readonly dshInstanceId: string,
    private readonly server: Server,
    private readonly socketFile: string | null,
    private readonly diagnostics: boolean,
  ) {}

  get released(): boolean {
    return this._released
  }

  release(): void {
    if (this._released) return
    this._released = true
    try {
      this.server.close()
    } catch {
      /* already closed */
    }
    if (this.socketFile) {
      try {
        unlinkSync(this.socketFile)
      } catch {
        /* best effort — a stale socket is handled on the next acquisition */
      }
    }
    if (this.diagnostics) {
      appendDiagnostic(join(this.instanceDir, OWNER_LOCK_FILENAME), {
        event: 'ownership-released',
        pid: process.pid,
        dshInstanceId: this.dshInstanceId,
        releasedAt: new Date().toISOString(),
      })
    }
  }
}

function bindServer(endpoint: string): Promise<{ server: Server; ok: boolean; code?: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    let settled = false
    const finish = (ok: boolean, code?: string) => {
      if (settled) return
      settled = true
      resolvePromise({ server, ok, code })
    }
    // A listener MUST exist before listen(): an unhandled 'error' event on a
    // Server would be an uncaught exception, exactly the failure mode logging
    // must never introduce.
    server.once('error', (err: NodeJS.ErrnoException) => finish(false, err.code ?? 'UNKNOWN'))
    server.once('listening', () => finish(true))
    try {
      server.listen(endpoint)
    } catch (err) {
      finish(false, errorCode(err))
    }
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * Binds the endpoint, retrying briefly while it reports EADDRINUSE.
 *
 * A process that has JUST released the endpoint can take a few milliseconds to
 * disappear (Windows closes the named-pipe instance asynchronously). Without
 * the retry, a recovery pass that runs immediately after a release mistakes a
 * dying owner for a live one and skips the directory. A genuinely live owner
 * keeps failing every attempt, so this only removes the race — it never steals
 * a held lock.
 */
async function bindWithRetry(
  endpoint: string,
): Promise<{ server: Server; ok: boolean; code?: string }> {
  let bound = await bindServer(endpoint)
  for (let attempt = 0; attempt < 4 && !bound.ok && bound.code === 'EADDRINUSE'; attempt += 1) {
    try {
      bound.server.close()
    } catch {
      /* never listened */
    }
    await delay(15 * (attempt + 1))
    bound = await bindServer(endpoint)
  }
  return bound
}

/** POSIX only: is the socket file a live owner or a stale crash leftover? */
function socketIsLive(socketFile: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection(socketFile)
    const done = (live: boolean) => {
      socket.destroy()
      resolvePromise(live)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(250, () => done(false))
  })
}

/**
 * Attempts exclusive ownership. Returns `null` when another live process owns
 * the directory — callers MUST then leave the directory completely alone.
 *
 * Asynchronous because a socket bind resolves on the event loop. The runtime
 * gates opening the active log file on this promise, so no active file is ever
 * written before ownership is established.
 */
export async function acquireDshOwnership(
  instanceDir: string,
  dshInstanceId: string,
  options: { diagnostics?: boolean } = {},
): Promise<DshOwnershipHandle | null> {
  const diagnostics = options.diagnostics !== false
  try {
    mkdirSync(instanceDir, { recursive: true })
  } catch {
    return null
  }

  const endpoint = endpointFor(instanceDir)
  let bound = await bindWithRetry(endpoint)

  if (!bound.ok && process.platform !== 'win32' && bound.code === 'EADDRINUSE') {
    if (existsSync(endpoint) && !(await socketIsLive(endpoint))) {
      try {
        unlinkSync(endpoint)
      } catch {
        /* another recovery process won the cleanup race */
      }
      bound = await bindWithRetry(endpoint)
    }
  }

  if (!bound.ok) {
    try {
      bound.server.close()
    } catch {
      /* ignore */
    }
    return null
  }

  // Only the CONFIRMED owner may write into the directory. A losing process
  // must never append to another live owner's `owner.lock`.
  if (diagnostics) recordOwnerClaim(instanceDir, dshInstanceId)

  // Holding a lock must not keep the DSH process alive on its own.
  bound.server.unref()
  return new DshOwnershipHandleImpl(
    instanceDir,
    dshInstanceId,
    bound.server,
    process.platform === 'win32' ? null : endpoint,
    diagnostics,
  )
}

/**
 * Historical recovery / cleanup entry point. Stricter than
 * {@link acquireDshOwnership}: it refuses to create the directory (a deleted
 * directory must stay deleted) and writes no diagnostics into it.
 */
export async function acquireHistoricalDshOwnership(
  instanceDir: string,
  dshInstanceId: string,
): Promise<DshOwnershipHandle | null> {
  if (!existsSync(instanceDir)) return null
  return acquireDshOwnership(instanceDir, dshInstanceId, { diagnostics: false })
}

/** Non-destructive probe: true when nobody currently owns the directory. */
export async function probeDshOwnership(instanceDir: string): Promise<boolean> {
  if (!existsSync(instanceDir)) return false
  const handle = await acquireDshOwnership(instanceDir, 'ownership-probe', { diagnostics: false })
  if (!handle) return false
  handle.release()
  return true
}

/** Writes a recovery diagnostic without touching a live owner's data. */
export function recordRecoveryDiagnostic(instanceDir: string, record: Record<string, unknown>): void {
  try {
    const fd = openSync(join(instanceDir, RECOVERY_LOG_FILENAME), 'a', 0o600)
    try {
      writeSync(fd, Buffer.from(`${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`))
    } finally {
      closeSync(fd)
    }
  } catch {
    /* diagnostics must never break recovery */
  }
}
