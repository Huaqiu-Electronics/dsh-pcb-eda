/**
 * Configuration for `@huaqiu/dsh-kicad`.
 *
 * Deliberately small. Everything KiCad-specific (socket, token, board state)
 * belongs to KiCad and the bundled scripts — the scripts read
 * `KICAD_API_SOCKET` / `KICAD_API_TOKEN` that KiCad injects, and this package
 * never guesses them. The only host configuration here is *how to reach the
 * Python environment that owns `kipy`*, which is a machine concern, not a
 * design concern.
 *
 * @module
 */

/** Configuration accepted by the plugin's `apply()`. */
export interface KicadConfig {
  /**
   * Python interpreter used to run the bundled KiCad scripts. It must have the
   * official `kicad-python` package (`kipy`) installed.
   */
  pythonPath: string
  /** Scripts directory override (defaults to the bundled skill's `scripts/`). */
  skillsDir?: string
  /** Per-script timeout in milliseconds. */
  timeoutMs: number
  /** Timeout for the two diagnostic scripts, which are fast but must be prompt. */
  diagnosticTimeoutMs: number
  /** Timeout for `refill_zones`, which can legitimately block for ~2 minutes. */
  refillTimeoutMs: number
}

export type KicadConfigInput = Partial<KicadConfig>

/** Default Python interpreter when nothing is configured. */
export const DEFAULT_PYTHON_PATH = 'python3'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 15_000
/** `refill_zones.py` polls zone fills; the script itself documents ~120 s. */
const DEFAULT_REFILL_TIMEOUT_MS = 150_000

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * Resolve the effective configuration.
 *
 * Precedence matches the rest of the Huaqiu DSH package set: explicit plugin
 * config wins over the environment, which wins over the default.
 */
export function resolveKicadConfig(input: KicadConfigInput = {}): KicadConfig {
  const pythonPath =
    firstNonEmpty(input.pythonPath, process.env['DSH_KICAD_PYTHON']) ?? DEFAULT_PYTHON_PATH

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const diagnosticTimeoutMs = input.diagnosticTimeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS
  const refillTimeoutMs = input.refillTimeoutMs ?? DEFAULT_REFILL_TIMEOUT_MS

  return {
    pythonPath,
    ...(input.skillsDir ? { skillsDir: input.skillsDir } : {}),
    timeoutMs,
    diagnosticTimeoutMs,
    refillTimeoutMs,
  }
}

/** Whether any host configuration was supplied (used for startup logging). */
export function hasHostConfig(input: KicadConfigInput = {}): boolean {
  return Boolean(
    input.pythonPath ??
      process.env['DSH_KICAD_PYTHON'] ??
      input.skillsDir ??
      process.env['DSH_KICAD_SKILLS_DIR'],
  )
}
