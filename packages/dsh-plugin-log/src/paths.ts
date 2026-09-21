/**
 * Inlined from `@hqedge/paths` (hq-edge/packages/paths/src/index.ts) so this
 * plugin stays fully self-contained — no runtime dependency on the published
 * package. Keep in sync when `@hqedge/paths` changes its path conventions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Shared path resolution for HQ Edge runtimes.
 *
 * The single source of truth for where HQ Edge places per-user directories.
 * `getHqEdgeHome()` is the root: every other path getter (`getLogBaseDir`,
 * `getLogDir`) is derived from it, so all HQ Edge user directories live under
 * one self-contained tree and every consumer resolves the same location.
 *
 * The home is **the same on every platform** — `~/.hq-edge/` — because HQ Edge
 * is a developer/EDA runtime environment rather than a conventional desktop
 * app: a single dotfile under `$HOME` keeps logging, diagnostics, DSH
 * integration, CLI behavior and documentation identical on macOS / Linux /
 * Windows, instead of introducing a second filesystem convention
 * (`%LOCALAPPDATA%\hq-edge` or `~/.local/share/hq-edge`) per platform.
 * `HQ_EDGE_HOME` is the universal escape hatch (tests, bundling, portable
 * installs, CI).
 *
 * Note: the immutable HQ Edge runtime (`<installRoot>/dsh`,
 * `<installRoot>/dsh-plugins`) and `<KiCad installation>/` (application
 * install) are deliberately NOT this home — user data, managed runtime and
 * installation stay distinct. Mutable per-version DSH state lives UNDER this
 * home at `<home>/<version>/dsh-home` (see dshHome.ts). The
 * `~/.hq/hq-edge/<version>/` path from an earlier design draft never landed.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Application identifier used for OS-native directories.
 */
export const APP_ID = 'hq-edge'

/**
 * Resolves the per-user data home directory for HQ Edge — the single root from
 * which every other HQ Edge path getter is derived.
 *
 *   macOS / Linux / Windows: ~/.hq-edge/
 *
 * Unconditional across platforms (see the file header for the rationale). The
 * path may be overridden explicitly via `override` or the `HQ_EDGE_HOME`
 * environment variable (useful for tests / bundling / portable installs).
 */
export function getHqEdgeHome(override?: string): string {
  if (override) return override
  if (process.env.HQ_EDGE_HOME) return process.env.HQ_EDGE_HOME

  return join(homedir(), '.hq-edge')
}

/**
 * Resolves the base log directory for HQ Edge.
 *
 * Built on top of `getHqEdgeHome()` as `<home>/logs` on every platform, so
 * logs live inside the HQ Edge home tree:
 *
 *   macOS / Linux / Windows: ~/.hq-edge/logs/
 *
 * The path may be overridden explicitly via `override` or the
 * `HQ_EDGE_LOG_DIR` environment variable.
 */
export function getLogBaseDir(override?: string): string {
  if (override) return override
  if (process.env.HQ_EDGE_LOG_DIR) return process.env.HQ_EDGE_LOG_DIR
  return join(getHqEdgeHome(), 'logs')
}

/**
 * Resolves the per-component log directory, e.g. `<base>/dsh-plugins/`.
 *
 * The directory is created on demand by the rotating file stream.
 *
 * Note: the directory name is the component verbatim — there is no implicit
 * version scoping. Callers that need version isolation (e.g. the DSH home,
 * which keeps one tree per HQ Edge release) must layer it on top of
 * `getHqEdgeHome()` themselves. Cross-version logs (server, plugin diagnostics)
 * intentionally share a tree so a single `tail -F` follows them across upgrades.
 */
export function getLogDir(component: string, baseDirOverride?: string): string {
  return join(getLogBaseDir(baseDirOverride), component)
}
