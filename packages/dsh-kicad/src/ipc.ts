/**
 * KiCad IPC adapter.
 *
 * ── Boundary (task: dsh-kicad-skill-plugin §13) ──────────────────────────────
 *
 *   DSH tool  ->  KiCad IPC adapter (this module)  ->  bundled script  ->  KiCad
 *
 * This module is the *only* place that knows how a KiCad capability is reached.
 * It does not implement KiCad IPC and must never grow a second, competing
 * representation of board state: every call returns what KiCad said, verbatim
 * (§12 — KiCad is the single source of truth).
 *
 * The adapter deliberately runs the migrated `kicad-agent` scripts rather than
 * re-implementing the protocol in TypeScript. Those scripts are the preserved
 * implementation: they own `kipy` usage, commit/rollback, unit conversion and
 * post-mutation verification. Rewriting them would be a redesign (§27).
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { kicadScript, type KicadScript } from './scripts.js'

/**
 * Semantic failure kinds, shared by every KiCad tool.
 *
 * Same vocabulary as `@huaqiu/dsh-eda-host` so the agent's error handling does
 * not have to differ per EDA plugin.
 */
export type KicadErrorKind =
  /** The environment cannot run KiCad IPC at all (no python, no kipy, no board). */
  | 'FAILED_PRECONDITION'
  /** KiCad is installed but unreachable right now — retryable. */
  | 'UNAVAILABLE'
  /** The script did not finish inside its timeout. */
  | 'DEADLINE_EXCEEDED'
  /** The arguments were rejected before KiCad was touched. */
  | 'INVALID_ARGUMENT'
  /** KiCad or the script failed after the connection was established. */
  | 'INTERNAL'

export interface KicadError {
  kind: KicadErrorKind
  message: string
}

/** Raw result of one script invocation. */
export interface ScriptRun {
  /** Script identifier (file stem). */
  script: string
  /** Process exit code; `null` when it never started or was killed. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** Exact argv handed to the interpreter, for auditability. */
  argv: string[]
  /** `true` when the process was killed because the timeout elapsed. */
  timedOut: boolean
}

export interface RunScriptOptions {
  /** Directory holding the bundled scripts. */
  scriptsDir: string
  /** Python interpreter with `kipy` available. */
  pythonPath: string
  /** Script to run. */
  script: KicadScript
  /** CLI flags, already stringified (e.g. `['--net', 'GND']`). */
  args?: readonly string[]
  /** Timeout in milliseconds. */
  timeoutMs: number
  /** Optional cancellation from the tool call. */
  signal?: AbortSignal
}

/** A script the caller asked for but that is not bundled. */
export class KicadScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KicadScriptError'
  }
}

/**
 * Run one bundled KiCad script.
 *
 * Never throws for script-level failures — the outcome is reported, so a
 * missing `kipy` or a closed KiCad degrades into a typed error the agent can
 * act on instead of crashing the plugin. It only throws when the script itself
 * is not part of the package.
 */
export async function runKicadScript(options: RunScriptOptions): Promise<ScriptRun> {
  const { scriptsDir, pythonPath, script, args = [], timeoutMs, signal } = options

  const scriptPath = join(scriptsDir, script.file)
  // cwd is the scripts directory so `import kipy_common` resolves regardless of
  // how the interpreter is invoked (documented requirement of the templates).
  const argv = [scriptPath, ...args]

  return new Promise<ScriptRun>((resolvePromise) => {
    let child
    try {
      child = spawn(pythonPath, argv, {
        cwd: scriptsDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolvePromise({
        script: script.id,
        exitCode: null,
        stdout: '',
        stderr: String((err as Error)?.message ?? err),
        argv: [pythonPath, ...argv],
        timedOut: false,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (result: ScriptRun) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // If SIGTERM is ignored, SIGKILL after a short grace period.
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 2_000).unref()
    }, timeoutMs)

    const onAbort = () => {
      timedOut = true
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        script: script.id,
        exitCode: null,
        stdout,
        stderr: stderr || String(err?.message ?? err),
        argv: [pythonPath, ...argv],
        timedOut,
      })
    })

    child.on('close', (code: number | null) => {
      finish({
        script: script.id,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        argv: [pythonPath, ...argv],
        timedOut,
      })
    })
  })
}

/**
 * Translate a raw run into a semantic error, or `undefined` on success.
 *
 * Exit codes are part of the scripts' contract:
 *
 *   - `diagnose_ipc_connection.py`: 0 ok, 1 unreachable, 2 `kipy` missing,
 *     3 API version mismatch, 4 no board open.
 *   - every argparse script: 2 = rejected arguments (KiCad untouched).
 *   - anything else non-zero: a real KiCad/script failure.
 */
export function classifyRun(run: ScriptRun): KicadError | undefined {
  if (run.timedOut) {
    return {
      kind: 'DEADLINE_EXCEEDED',
      message:
        `KiCad script "${run.script}" did not finish within its timeout. ` +
        'KiCad may be busy (a GUI operation in progress); retry a read once, and ' +
        're-read board state before retrying a write.',
    }
  }

  if (run.exitCode === 0) return undefined

  // The interpreter itself was missing.
  if (run.exitCode === null) {
    return {
      kind: 'FAILED_PRECONDITION',
      message:
        `Could not start the Python interpreter for KiCad IPC. ` +
        'Set dsh-kicad `pythonPath` (or $DSH_KICAD_PYTHON) to an interpreter that ' +
        `has the official kicad-python package installed. ${detail(run)}`,
    }
  }

  const stdout = run.stdout || run.stderr

  if (run.script === 'diagnose_ipc_connection') {
    switch (run.exitCode) {
      case 1:
        return {
          kind: 'UNAVAILABLE',
          message:
            'KiCad IPC is unreachable. Open PCB Editor (the project manager is ' +
            'not enough), enable the KiCad API service in Preferences → Plugins, ' +
            'restart PCB Editor, and confirm DSH runs with Full Access. ' +
            'A permission denial is not a retryable connection failure. ' +
            detail(run),
        }
      case 2:
        return {
          kind: 'FAILED_PRECONDITION',
          message:
            'The kicad-python package (kipy) is not installed for the configured ' +
            'Python interpreter. Install the version matching the running KiCad. ' +
            detail(run),
        }
      case 3:
        return {
          kind: 'FAILED_PRECONDITION',
          message:
            'kicad-python and the connected KiCad disagree on the API version. ' +
            'Do not work around it — install the matching official package. ' +
            detail(run),
        }
      case 4:
        return {
          kind: 'FAILED_PRECONDITION',
          message:
            'Connected to KiCad, but no .kicad_pcb is open in PCB Editor. ' +
            'Open a board and retry. ' +
            detail(run),
        }
      default:
        return { kind: 'INTERNAL', message: `KiCad IPC diagnostic failed. ${detail(run)}` }
    }
  }

  if (run.exitCode === 2) {
    return {
      kind: 'INVALID_ARGUMENT',
      message:
        `KiCad script "${run.script}" rejected its arguments before touching the ` +
        `board. Check units (mm), required flags and value ranges. ${detail(run)}`,
    }
  }

  // kipy raises ModuleNotFoundError paths through the shared helper; make the
  // most common cause explicit instead of a bare INTERNAL.
  if (/ModuleNotFoundError|No module named/i.test(run.stderr)) {
    return {
      kind: 'FAILED_PRECONDITION',
      message:
        'kicad-python (kipy) is missing for the configured Python interpreter. ' +
        detail(run),
    }
  }

  return {
    kind: 'INTERNAL',
    message:
      `KiCad script "${run.script}" failed (exit ${run.exitCode}). ` +
      `The commit was dropped, so the board is unchanged. ${detail(run, stdout)}`,
  }
}

/** Compact, single-line diagnostic tail appended to error messages. */
function detail(run: ScriptRun, preferred = run.stdout || run.stderr): string {
  const text = preferred.replace(/\s+/g, ' ').trim()
  return text.length > 0 ? `KiCad said: ${text}` : ''
}

/** Convenience: run a script and return its semantic outcome. */
export async function invokeKicadScript(
  options: RunScriptOptions,
): Promise<{ ok: boolean; run: ScriptRun; error?: KicadError }> {
  const script = kicadScript(options.script.id)
  const run = await runKicadScript({ ...options, script })
  const error = classifyRun(run)
  return { ok: error === undefined, run, ...(error ? { error } : {}) }
}
