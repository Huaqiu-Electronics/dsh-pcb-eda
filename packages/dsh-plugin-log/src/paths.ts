/**
 * Inlined from `@hqedge/paths` (hq-edge/packages/paths/src/index.ts) so this
 * package stays fully self-contained — no runtime dependency on the published
 * package. Keep in sync when `@hqedge/paths` changes its path conventions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Shared path resolution for HQ Edge runtimes.
 *
 * The home is **the same on every platform** — `~/.hq-edge/` — because HQ Edge
 * is a developer/EDA runtime environment rather than a conventional desktop
 * app: a single dotfile under `$HOME` keeps logging, diagnostics, DSH
 * integration, CLI behavior and documentation identical on macOS / Linux /
 * Windows.
 *
 * ## Log tree layout (docs/tasks/dsh-plugin-log-isolation.md §3)
 *
 *   <home>/logs/instances/<edge-instance-id>/
 *     server.<date>.log                  ← owned by the HQ Edge process
 *     dsh/
 *       <dsh-instance-id>/
 *         instance.json                  ← this package writes it
 *         owner.lock                     ← diagnostic only
 *         dsh.<date>.log                 ← owned by THIS DSH process
 *         dsh.<date>.log.gz              ← published archive
 *
 * A DSH process never writes into another DSH process's directory, and never
 * into its parent Edge instance directory: it only appends the
 * `<dsh-instance-id>` level below the `dsh/` root it is handed.
 *
 * `HQ_EDGE_HOME` / `HQ_EDGE_LOG_DIR` / `DSH_LOG_ROOT` are the escape hatches
 * (tests, portable installs, CI). Per repository convention a relative
 * `HQ_EDGE_HOME` is ignored rather than resolved against the CWD.
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * Application identifier used for OS-native directories.
 */
export const APP_ID = 'hq-edge'

/** True for a non-empty absolute path — the only accepted override shape. */
function absoluteOverride(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return isAbsolute(trimmed) ? trimmed : undefined
}

/**
 * Resolves the per-user data home directory for HQ Edge — the single root from
 * which every other HQ Edge path getter is derived.
 *
 *   macOS / Linux / Windows: ~/.hq-edge/
 *
 * The path may be overridden explicitly via `override` or the `HQ_EDGE_HOME`
 * environment variable (tests / bundling / portable installs).
 */
export function getHqEdgeHome(override?: string): string {
  return getHqEdgeHomeFrom(process.env, override)
}

/**
 * Environment-parameterized form of {@link getHqEdgeHome}. Identity resolution
 * uses this so the result depends on the environment it was HANDED, never on
 * whatever `process.env` happens to contain at that moment.
 */
export function getHqEdgeHomeFrom(env: NodeJS.ProcessEnv, override?: string): string {
  const explicit = absoluteOverride(override)
  if (explicit) return explicit
  const fromEnv = absoluteOverride(env.HQ_EDGE_HOME)
  if (fromEnv) return fromEnv
  return join(homedir(), '.hq-edge')
}

/**
 * Resolves the base log directory for HQ Edge: `<home>/logs` on every
 * platform. Overridable via `override` or `HQ_EDGE_LOG_DIR`.
 */
export function getLogBaseDir(override?: string): string {
  return getLogBaseDirFrom(process.env, override)
}

/** Environment-parameterized form of {@link getLogBaseDir}. */
export function getLogBaseDirFrom(env: NodeJS.ProcessEnv, override?: string): string {
  const explicit = absoluteOverride(override)
  if (explicit) return explicit
  const fromEnv = absoluteOverride(env.HQ_EDGE_LOG_DIR)
  if (fromEnv) return fromEnv
  return join(getHqEdgeHomeFrom(env), 'logs')
}

/**
 * Resolves the per-component log directory, e.g. `<base>/dsh-plugins/`.
 *
 * LEGACY. `dsh-plugins/` was the pre-isolation shared plugin log directory and
 * is no longer written to; it is only inspected by maintenance so old files can
 * be reported (never migrated or deleted). New per-process logs MUST go through
 * {@link getDshLogRoot} + the owning process's instance id.
 */
export function getLogDir(component: string, baseDirOverride?: string): string {
  return join(getLogBaseDir(baseDirOverride), component)
}

/** `<base>/instances` — one directory per HQ Edge process. */
export function getInstanceLogRoot(baseDirOverride?: string): string {
  return join(getLogBaseDir(baseDirOverride), 'instances')
}

/**
 * `<base>/instances/<edge-instance-id>/dsh` — the DSH log root owned by one HQ
 * Edge process. Every DSH launch under that process creates its own child
 * directory here.
 *
 * When `edgeInstanceId` is unknown (a standalone `dsh` used in development or a
 * test), the root degrades to `<base>/dsh`, deliberately WITHOUT an
 * `instances/<id>` level: inventing an Edge identity would attribute DSH logs
 * to an HQ Edge process that does not exist.
 */
export function getDshLogRoot(edgeInstanceId: string | null, baseDirOverride?: string): string {
  return getDshLogRootFrom(process.env, edgeInstanceId, baseDirOverride)
}

/** Environment-parameterized form of {@link getDshLogRoot}. */
export function getDshLogRootFrom(
  env: NodeJS.ProcessEnv,
  edgeInstanceId: string | null,
  baseDirOverride?: string,
): string {
  const base = getLogBaseDirFrom(env, baseDirOverride)
  return edgeInstanceId ? join(base, 'instances', edgeInstanceId, 'dsh') : join(base, 'dsh')
}
