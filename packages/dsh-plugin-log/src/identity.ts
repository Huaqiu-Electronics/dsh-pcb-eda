/**
 * Identity for ONE DSH process, and the log root it is allowed to write into.
 *
 * This is the fourth level of the ownership hierarchy
 * (docs/tasks/dsh-plugin-log-isolation.md §1):
 *
 *   installation_id   HQ Edge installation   (installation lifetime)
 *   host_instance_id  EDA Host               (host process lifetime)
 *   edge_instance_id  HQ Edge                (Edge process lifetime)
 *   dsh_instance_id   DSH runtime            (DSH process lifetime)  ← here
 *
 * Plugins have no process identity of their own. They are attributed to a DSH
 * process through `plugin_id` (see `index.ts`), which is why nothing in this
 * module knows about plugins.
 *
 * Rules encoded here:
 *   - `dsh_instance_id` is generated per DSH LAUNCH. A DSH restart produces a
 *     new id and therefore a new directory; a plugin reload does not.
 *   - HQ Edge passes the parent identities in the environment. It must never
 *     generate a `dsh_instance_id` itself and reuse it across restarts.
 *   - An absent or malformed parent identity is recorded as `null`, never
 *     fabricated: attributing logs to the wrong Edge process is worse than
 *     attributing them to none.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getDshLogRootFrom, getHqEdgeHomeFrom } from './paths.js'
import { isUuid, readJsonSafe } from './fs-utils.js'

/** Written once per DSH process, atomically, never overwritten. */
export const INSTANCE_METADATA_FILENAME = 'instance.json'
/** Diagnostic JSONL. Its EXISTENCE never implies ownership. */
export const OWNER_LOCK_FILENAME = 'owner.lock'
/** Appended by historical recovery in the recovering process's own directory. */
export const RECOVERY_LOG_FILENAME = 'recovery.log'
/** Written when the destination cannot be established at all. */
export const FATAL_LOG_FILENAME = 'fatal.log'

export const DSH_METADATA_SCHEMA_VERSION = 1

/**
 * Record fields owned by this package. Re-exported from `fields.ts` (a leaf
 * module) so the browser half can enforce the same rule without importing
 * Node builtins.
 */
export { RESERVED_FIELDS } from './fields.js'

export type DshLogRootSource = 'override' | 'env:DSH_LOG_ROOT' | 'edge-instance' | 'unscoped'

/** Everything the environment tells this DSH process about its place in the tree. */
export interface DshLogContext {
  /** Directory that contains one subdirectory per DSH instance. */
  readonly dshLogRoot: string
  /** Why the root resolved to that path (surfaced in the boot record). */
  readonly dshLogRootSource: DshLogRootSource
  readonly installationId: string | null
  readonly edgeInstanceId: string | null
  readonly hostType: string | null
  readonly hostInstanceId: string | null
  readonly targetHost: string | null
  readonly dshHome: string | null
  readonly hqEdgeHome: string
  /** Non-fatal problems found while reading the environment. */
  readonly warnings: readonly string[]
}

export interface DshInstanceMetadata {
  readonly schemaVersion: number
  readonly dshInstanceId: string
  readonly installationId: string | null
  readonly edgeInstanceId: string | null
  readonly hostType: string | null
  readonly hostInstanceId: string | null
  readonly targetHost: string | null
  readonly pid: number
  readonly startedAt: string
  /** Version of `@huaqiu/dsh-plugin-log` that produced the directory. */
  readonly version: string
  readonly dshHome: string | null
  readonly logRoot: string
}

export interface DshLogContextOverrides {
  /** Explicit DSH log root (beats every environment variable). */
  dshLogRoot?: string
  /** Base log directory used when no explicit root/env root is given. */
  baseDir?: string
}

export interface DshIdentityOptions {
  /** Test/host injection. Production DSH generates its own id. */
  dshInstanceId?: string
  pid?: number
  now?: Date
  version?: string
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function uuidOrNull(
  env: NodeJS.ProcessEnv,
  name: string,
  warnings: string[],
): string | null {
  const value = envValue(env, name)
  if (value === undefined) return null
  if (isUuid(value)) return value
  warnings.push(`${name} is not a valid UUID and was ignored`)
  return null
}

function hostTypeOrNull(env: NodeJS.ProcessEnv, warnings: string[]): string | null {
  const value = envValue(env, 'HQ_HOST_TYPE')
  if (value === undefined) return null
  const normalized = value.toLowerCase()
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
    warnings.push('HQ_HOST_TYPE has an unexpected shape and was ignored')
    return null
  }
  return normalized
}

/**
 * Resolves the DSH log root and the parent identities from the environment.
 *
 * Root precedence (§3 / §4):
 *   1. explicit option            (`configureLogging({ dir })`)
 *   2. `$DSH_LOG_ROOT`            (set by HQ Edge when it launches DSH)
 *   3. `$HQ_EDGE_INSTANCE_ID`     → `<logs>/instances/<edge>/dsh`
 *   4. otherwise                  → `<logs>/dsh`   (standalone DSH)
 */
export function readDshLogContext(
  env: NodeJS.ProcessEnv = process.env,
  overrides: DshLogContextOverrides = {},
): DshLogContext {
  const warnings: string[] = []
  const installationId = uuidOrNull(env, 'HQ_EDGE_INSTALLATION_ID', warnings)
  const edgeInstanceId = uuidOrNull(env, 'HQ_EDGE_INSTANCE_ID', warnings)
  const hostInstanceId = uuidOrNull(env, 'HQ_HOST_INSTANCE_ID', warnings)
  const hostType = hostTypeOrNull(env, warnings)

  let dshLogRoot: string
  let dshLogRootSource: DshLogRootSource

  if (overrides.dshLogRoot && overrides.dshLogRoot.length > 0) {
    dshLogRoot = overrides.dshLogRoot
    dshLogRootSource = 'override'
  } else {
    const fromEnv = envValue(env, 'DSH_LOG_ROOT')
    if (fromEnv) {
      dshLogRoot = fromEnv
      dshLogRootSource = 'env:DSH_LOG_ROOT'
    } else {
      dshLogRoot = getDshLogRootFrom(env, edgeInstanceId, overrides.baseDir)
      dshLogRootSource = edgeInstanceId ? 'edge-instance' : 'unscoped'
    }
  }

  return {
    dshLogRoot,
    dshLogRootSource,
    installationId,
    edgeInstanceId,
    hostType,
    hostInstanceId,
    targetHost: envValue(env, 'HQ_TARGET_HOST') ?? null,
    dshHome: envValue(env, 'DSH_HOME') ?? null,
    hqEdgeHome: getHqEdgeHomeFrom(env),
    warnings,
  }
}

let cachedVersion: string | null = null

/**
 * Version of this package, used to attribute a log directory to the build that
 * created it. Resolved lazily and cached: `import.meta.url` may point outside
 * the package when a plugin bundle inlines this module, in which case the env
 * override or `unknown` is used instead of failing.
 */
export function pluginLogVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  const fromEnv = process.env.DSH_PLUGIN_LOG_VERSION?.trim()
  if (fromEnv) {
    cachedVersion = fromEnv
    return cachedVersion
  }
  try {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}

/**
 * Creates the immutable identity of THIS DSH process.
 *
 * `dsh_instance_id` is taken from an explicit override (tests / host
 * injection), else `$DSH_INSTANCE_ID`, else freshly generated. HQ Edge must
 * not set either variable: a restart has to produce a new directory.
 */
export function createDshIdentity(
  context: DshLogContext,
  options: DshIdentityOptions = {},
): DshInstanceMetadata {
  const injected = options.dshInstanceId ?? envValue(process.env, 'DSH_INSTANCE_ID')
  const dshInstanceId = isUuid(injected) ? injected : randomUUID()
  return {
    schemaVersion: DSH_METADATA_SCHEMA_VERSION,
    dshInstanceId,
    installationId: context.installationId,
    edgeInstanceId: context.edgeInstanceId,
    hostType: context.hostType,
    hostInstanceId: context.hostInstanceId,
    targetHost: context.targetHost,
    pid: options.pid ?? process.pid,
    startedAt: (options.now ?? new Date()).toISOString(),
    version: options.version ?? pluginLogVersion(),
    dshHome: context.dshHome,
    logRoot: context.dshLogRoot,
  }
}

/** Absolute directory this DSH process exclusively owns. */
export function instanceDirFor(identity: DshInstanceMetadata): string {
  return join(identity.logRoot, identity.dshInstanceId)
}

/** Reads and validates `instance.json` from an (historical) directory. */
export function readDshInstanceMetadata(dir: string): DshInstanceMetadata | null {
  const value = readJsonSafe<Partial<DshInstanceMetadata>>(join(dir, INSTANCE_METADATA_FILENAME))
  if (!value) return null
  if (!isUuid(value.dshInstanceId)) return null
  // The directory name is authoritative for which instance this is; a
  // mismatched metadata file means the directory was tampered with or copied.
  if (basename(dir).toLowerCase() !== value.dshInstanceId.toLowerCase()) return null
  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 0,
    dshInstanceId: value.dshInstanceId,
    installationId: isUuid(value.installationId) ? value.installationId : null,
    edgeInstanceId: isUuid(value.edgeInstanceId) ? value.edgeInstanceId : null,
    hostType: typeof value.hostType === 'string' ? value.hostType : null,
    hostInstanceId: isUuid(value.hostInstanceId) ? value.hostInstanceId : null,
    targetHost: typeof value.targetHost === 'string' ? value.targetHost : null,
    pid: typeof value.pid === 'number' ? value.pid : 0,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
    version: typeof value.version === 'string' ? value.version : 'unknown',
    dshHome: typeof value.dshHome === 'string' ? value.dshHome : null,
    logRoot: typeof value.logRoot === 'string' ? value.logRoot : dir,
  }
}
