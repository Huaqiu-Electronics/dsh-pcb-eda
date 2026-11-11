/**
 * Shared helpers for the DSH logging isolation tests.
 *
 * Most suites exercise the package in-process. The isolation guarantees that
 * matter most — separate `dsh_instance_id` per launch, OS lock release on
 * abnormal termination, crash-during-rotation recovery — are only meaningful
 * across real OS processes, so `spawnProbe()` runs `fixtures/dsh-probe.ts` with
 * `node --import tsx` instead of faking it in-process.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROBE_PATH = fileURLToPath(new URL('./fixtures/dsh-probe.ts', import.meta.url))

export const EDGE_A = '11111111-1111-4111-8111-111111111111'
export const EDGE_B = '22222222-2222-4222-8222-222222222222'
export const INSTALL_ID = '33333333-3333-4333-8333-333333333333'
export const HOST_ID = '44444444-4444-4444-8444-444444444444'

/** Identity env the runtime reads. Cleared before every test. */
export const IDENTITY_ENV = [
  'HQ_EDGE_HOME',
  'HQ_EDGE_LOG_DIR',
  'HQ_EDGE_INSTANCE_ID',
  'HQ_EDGE_INSTALLATION_ID',
  'HQ_HOST_TYPE',
  'HQ_HOST_INSTANCE_ID',
  'HQ_TARGET_HOST',
  'DSH_HOME',
  'DSH_LOG_ROOT',
  'DSH_INSTANCE_ID',
  'DSH_PLUGIN_LOG_DIR',
  'DSH_PLUGIN_LOG_LEVEL',
  'DSH_PLUGIN_LOG_CONSOLE',
  'DSH_PLUGIN_LOG_MAX_BYTES',
  'DSH_PLUGIN_LOG_RETENTION_DAYS',
  'DSH_PLUGIN_LOG_MAX_STORAGE_BYTES',
  'DSH_PLUGIN_LOG_COMPRESS',
  'DSH_PLUGIN_LOG_VERSION',
] as const

export function clearIdentityEnv(): void {
  for (const name of IDENTITY_ENV) delete process.env[name]
}

/** Fresh absolute HQ Edge home under the OS temp dir. */
export function tempHome(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-plugin-log-${label}-`))
}

/** Deterministic base log directory for one temp home. */
export function logsDir(home: string): string {
  return join(home, 'logs')
}

/** Cross-platform lowercase key, used to compare paths without case games. */
export function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

export function exists(path: string): boolean {
  return existsSync(path)
}

export function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Parses a JSONL log file, skipping blank lines. */
export function readJsonl(path: string): Array<Record<string, any>> {
  const raw = readFileSync(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>)
}

/** Decompresses a `.gz` archive into a string. */
export async function readArchive(path: string): Promise<string> {
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void): void {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  await pipeline(createReadStream(path), createGunzip(), sink)
  return Buffer.concat(chunks).toString('utf8')
}

/** Count of 0x00 bytes in a file — the corruption signature from the Nov 10 incident. */
export function nulBytes(path: string): number {
  const buffer = readFileSync(path)
  let count = 0
  for (const byte of buffer) if (byte === 0) count += 1
  return count
}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export interface SeedFile {
  name: string
  contents: string | Buffer
}

/**
 * Creates an already-exited (historical) DSH instance directory, as a previous
 * DSH launch would have left it.
 */
export function seedDshInstance(
  dshRoot: string,
  dshInstanceId: string,
  files: SeedFile[] = [],
  options: { edgeInstanceId?: string; pid?: number } = {},
): string {
  const dir = join(dshRoot, dshInstanceId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'instance.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        dshInstanceId,
        installationId: INSTALL_ID,
        edgeInstanceId: options.edgeInstanceId ?? EDGE_A,
        hostType: 'kicad',
        hostInstanceId: HOST_ID,
        targetHost: 'kicad',
        pid: options.pid ?? 999_999,
        startedAt: new Date().toISOString(),
        version: '0.0.0-test',
        dshHome: null,
        logRoot: dshRoot,
      },
      null,
      2,
    )}\n`,
  )
  for (const file of files) writeFileSync(join(dir, file.name), file.contents)
  return dir
}

// ── real subprocess probes ──────────────────────────────────────────────────

export interface SpawnedProbe {
  readonly child: ChildProcess
  /** Everything written to stdout so far. */
  stdout(): string
  /** Everything written to stderr so far. */
  stderr(): string
  /** Resolves with the exit code (or null when killed by a signal). */
  exited: Promise<number | null>
  kill(): void
}

export interface ProbeOptions {
  /** Kill the probe automatically after this long (safety net). */
  killAfterMs?: number
}

/** Spawns the fixture with the given extra env, inheriting the test's PATH. */
export function spawnProbe(env: Record<string, string>, options: ProbeOptions = {}): SpawnedProbe {
  const child = spawn(process.execPath, ['--import', 'tsx', PROBE_PATH], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    out += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    err += chunk
  })

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })

  if (options.killAfterMs !== undefined) {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, options.killAfterMs)
    timer.unref()
    void exited.then(() => clearTimeout(timer))
  }

  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    kill: () => {
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

export interface ProbeReport {
  mode: string
  pid: number
  dshInstanceId: string | null
  instanceDir: string | null
  logFile: string | null
  logRoot: string | null
  ownership: string
  degradedReason: string | null
  files?: string[]
  [key: string]: unknown
}

/** Waits for the fixture's `##PROBE##` line and parses it. */
export async function waitForProbeReport(probe: SpawnedProbe, timeoutMs = 20_000): Promise<ProbeReport> {
  const marker = '##PROBE##'
  const deadline = Date.now() + timeoutMs
  let seen = ''
  while (Date.now() < deadline) {
    const index = probe.stdout().indexOf(marker)
    if (index >= 0) {
      const line = probe.stdout().slice(index + marker.length).split('\n')[0]
      if (line !== undefined && line.trim().length > 0) {
        try {
          seen = line
          return JSON.parse(line) as ProbeReport
        } catch {
          /* the line may be partially written; retry */
        }
      }
    }
    if (probe.child.exitCode !== null) break
    await wait(25)
  }
  throw new Error(`probe report not received (${seen || 'none'}); stderr=${probe.stderr().slice(-800)}`)
}

export async function runProbe(
  env: Record<string, string>,
  options: ProbeOptions = {},
): Promise<{ report: ProbeReport; code: number | null; stdout: string; stderr: string }> {
  const probe = spawnProbe(env, { killAfterMs: 60_000, ...options })
  try {
    const report = await waitForProbeReport(probe)
    const code = await probe.exited
    return { report, code, stdout: probe.stdout(), stderr: probe.stderr() }
  } finally {
    probe.kill()
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
