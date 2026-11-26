/**
 * The toolchain capability: status, validation, discovery, download and
 * configuration for KiCad and SolidCraft.
 *
 * One object owns the whole lifecycle so the wizard, the Settings panel, the
 * installer and the agent prompt read the same facts (§10.5). It never writes
 * UI state and never invents a download: everything it reports comes from a
 * resolution of the configured path, a validated manifest entry, or a job it is
 * running right now.
 *
 * @module @huaqiu/hardware-artifacts/toolchain/manager
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pickFile, TOOLCHAIN_FILTERS, type PickFileResult } from './dialog.js'
import {
  candidateRoots, probeInstallation, validateCandidates,
  type DiscoveryInternals, type ToolDiscovery,
} from './discovery.js'
import { ToolchainInstaller, type InstallJobSnapshot, type InstallOutcome } from './install.js'
import { fetchManifest, MANIFEST_URL, type ManifestEntry, type ManifestFailure, type ToolchainManifest } from './manifest.js'
import {
  canonicalPath, installationRootOf, label, normalizeVersion, resolveToolchain,
  type ToolchainId, type ToolchainResolution, type ToolchainSource,
} from './resolve.js'

/** The fallback download pages offered when the HuaQiu manifest is unusable (§9.2). */
export const OFFICIAL_DOWNLOAD_PAGES: Readonly<Record<ToolchainId, string>> = Object.freeze({
  kicad: 'https://www.kicad.org/download/',
  solidcraft: 'https://github.com/tangency-labs/solidcraft/releases/',
})

/** Persisted configuration the manager reads; every field is user-owned. */
export interface ToolchainSettings {
  readonly kicadRoot?: string
  readonly solidcraftRoot?: string
  readonly kicadVersion?: string
  readonly kicadSource?: string
  readonly kicadValidatedAt?: number
  readonly solidcraftVersion?: string
  readonly solidcraftSource?: string
  readonly solidcraftValidatedAt?: number
}

/** The patch written back after a successful install or an in-app validation. */
export type ToolchainConfigPatch = Partial<Record<
  | 'kicadRoot' | 'solidcraftRoot'
  | 'kicadVersion' | 'kicadSource' | 'kicadValidatedAt'
  | 'solidcraftVersion' | 'solidcraftSource' | 'solidcraftValidatedAt',
  string | number
>>

/** One tool's status, as the UI renders it. */
export interface ToolStatus {
  readonly tool: ToolchainId
  /** `validating` covers the window before the first probe answers. */
  readonly state: 'unconfigured' | 'validating' | 'configured' | 'invalid'
  readonly installPath?: string
  readonly cliPath?: string
  readonly appPath?: string
  readonly version?: string
  readonly source?: ToolchainSource
  readonly validatedAt?: number
  readonly error?: string
  readonly discovery: ToolDiscovery
  /** Manifest entry this host could install, when one is available. */
  readonly download?: { readonly version: string; readonly url: string }
}

/** Everything the settings/wizard surface needs, in one poll. */
export interface ToolchainStatus {
  readonly kicad: ToolStatus
  readonly solidcraft: ToolStatus
  readonly manifest:
    | { readonly state: 'unknown' | 'loading' }
    | { readonly state: 'ready'; readonly schemaVersion: number; readonly url: string }
    | { readonly state: 'unavailable'; readonly code: string; readonly message: string }
  /** Platform/architecture the download flow targets (§7.3). */
  readonly target: { readonly platform: string; readonly arch: string; readonly downloadsSupported: boolean }
  /** Official pages offered when the download flow cannot be used (§9.3). */
  readonly official: Readonly<Record<ToolchainId, string>>
  /** The running or last finished jobs the caller asked about — one per tool. */
  readonly jobs?: readonly InstallJobSnapshot[]
  /** First of `jobs`, kept for callers that still ask about a single run. */
  readonly job?: InstallJobSnapshot
}

/** Result of "validate and save" for one path. */
export interface ValidationOutcome {
  readonly ok: boolean
  readonly installPath?: string
  readonly cliPath?: string
  readonly appPath?: string
  readonly version?: string
  readonly error?: string
}

/** Result of a native browse request. */
export interface BrowseOutcome {
  readonly kind: 'picked' | 'cancelled' | 'unsupported'
  readonly path?: string
  /** Which chooser answered: the plugin's file dialog or DSH's own seam. */
  readonly mechanism?: string
  readonly message?: string
}

/** Injectable boundaries of the capability. */
export interface ToolchainManagerOptions {
  /** Live read of the persisted configuration. */
  readonly settings: () => ToolchainSettings
  /** Persist a patch through the Host's own settings service. */
  readonly persist?: (patch: ToolchainConfigPatch) => Promise<boolean>
  /** Per-user toolchain root (`<DSH home>/toolchains`). */
  readonly managedRoot?: string
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fetchImpl?: typeof fetch
  readonly manifestUrl?: string
  /** Version probe for one executable, answering the tool's raw report. */
  readonly versionProbe?: (executable: string, tool: ToolchainId) => Promise<string | undefined>
  /** DSH's own native directory chooser, used when the file dialog is unavailable. */
  readonly pickFolder?: (title: string) => Promise<string | null>
  /** Plugin-level native file dialog (overridable for tests). */
  readonly pickFile?: (request: Parameters<typeof pickFile>[0], internals: { signal?: AbortSignal }) => Promise<PickFileResult>
  readonly discoveryInternals?: DiscoveryInternals
  readonly now?: () => number
}

/** Version probes cost a process; cache them briefly per executable. */
const PROBE_CACHE_MS = 30_000

/** Dispatch one version command per tool — the interfaces are not identical (§5.3). */
function versionCommand(tool: ToolchainId, executable: string): { command: string; args: string[] } {
  return tool === 'kicad' ? { command: executable, args: ['version'] } : { command: executable, args: ['--version'] }
}

/** Default probe: one short-lived process, no shell. */
async function defaultVersionProbe(executable: string, tool: ToolchainId): Promise<string | undefined> {
  const { command, args } = versionCommand(tool, executable)
  return new Promise((resolvePromise) => {
    execFile(command, args, {
      timeout: 15_000,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error !== null) {
        resolvePromise(undefined)
        return
      }
      resolvePromise(normalizeVersion(String(stdout)) ?? String(stdout).trim())
    })
  })
}

/** The per-user toolchain root, following the DSH home convention (§8.1). */
export function defaultManagedRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? resolve(env.DSH_HOME) : join(homedir(), '.dsh')
  return join(home, 'toolchains')
}

/**
 * Discovery is asynchronous by construction: `state: 'running'` is answered
 * immediately, and the verdicts arrive through {@link ToolchainManager.status}.
 */
export class ToolchainManager {
  private readonly installer: ToolchainInstaller
  private readonly managedRoot: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly home: string
  private readonly now: () => number
  private readonly probeCache = new Map<string, { readonly at: number; readonly version?: string }>()
  private readonly discovery: Record<ToolchainId, ToolDiscovery>
  private readonly discovering = new Set<ToolchainId>()
  private manifestCache?: { readonly at: number; readonly result: Awaited<ReturnType<typeof fetchManifest>> }
  private manifestPending?: Promise<Awaited<ReturnType<typeof fetchManifest>>>

  constructor(private readonly options: ToolchainManagerOptions) {
    this.managedRoot = options.managedRoot ?? defaultManagedRoot(options.env ?? process.env)
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.env = options.env ?? process.env
    this.home = options.home ?? homedir()
    this.now = options.now ?? (() => Date.now())
    this.installer = new ToolchainInstaller({
      root: this.managedRoot,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      now: this.now,
    })
    this.discovery = {
      kicad: { tool: 'kicad', state: 'idle', candidates: [] },
      solidcraft: { tool: 'solidcraft', state: 'idle', candidates: [] },
    }
  }

  /** The per-user root this capability installs into, for diagnostics. */
  get toolchainRoot(): string {
    return this.managedRoot
  }

  /** Probe one executable, memoised briefly; an install invalidates it. */
  private async versionOf(tool: ToolchainId, executable: string): Promise<string | undefined> {
    const key = `${tool}:${executable}`
    const cached = this.probeCache.get(key)
    if (cached !== undefined && this.now() - cached.at < PROBE_CACHE_MS) return cached.version
    const report = await (this.options.versionProbe ?? defaultVersionProbe)(executable, tool)
    const version = report === undefined ? undefined : normalizeVersion(report) ?? report
    this.probeCache.set(key, { at: this.now(), ...(version === undefined ? {} : { version }) })
    return version
  }

  /** Resolve one configured path into its executables and validated state. */
  private async resolve(tool: ToolchainId, root: string | undefined): Promise<ToolchainResolution> {
    if (root === undefined || root.trim() === '') {
      return resolveToolchain(tool, root)
    }
    // Probe only when the primary executable actually exists, then hand the
    // answer to the one shared resolver: the manager decides nothing itself.
    const layout = resolveToolchain(tool, root, { platform: this.platform })
    const executable = layout.cli ?? layout.app
    const version = executable === undefined ? undefined : await this.versionOf(tool, executable)
    return resolveToolchain(tool, root, {
      platform: this.platform,
      probeVersion: () => version,
    })
  }

  /** The persisted path for one tool, as the settings service holds it. */
  private roots(): ToolchainSettings {
    return this.options.settings()
  }

  /** Status of one tool, from its configured path. */
  private async toolStatus(tool: ToolchainId): Promise<ToolStatus> {
    const settings = this.roots()
    const root = tool === 'kicad' ? settings.kicadRoot : settings.solidcraftRoot
    const persistedVersion = tool === 'kicad' ? settings.kicadVersion : settings.solidcraftVersion
    const persistedSource = tool === 'kicad' ? settings.kicadSource : settings.solidcraftSource
    const validatedAt = tool === 'kicad' ? settings.kicadValidatedAt : settings.solidcraftValidatedAt
    const resolution = await this.resolve(tool, root)
    const source = persistedSource === 'manual' || persistedSource === 'browse' || persistedSource === 'download' || persistedSource === 'detected'
      ? persistedSource as ToolchainSource
      : undefined
    const entry = await this.selectedEntry(tool)
    const base = {
      tool,
      discovery: this.discovery[tool],
      ...(entry === undefined ? {} : { download: { version: entry.version, url: entry.url } }),
    }
    if (resolution.configured) {
      return {
        ...base,
        state: 'configured',
        installPath: resolution.installPath,
        ...(resolution.cli === undefined ? {} : { cliPath: resolution.cli }),
        ...(resolution.app === undefined ? {} : { appPath: resolution.app }),
        ...(resolution.version === undefined ? {} : { version: resolution.version }),
        ...(source === undefined ? {} : { source }),
        ...(validatedAt === undefined || validatedAt === 0 ? {} : { validatedAt }),
      }
    }
    if (root === undefined || root.trim() === '') {
      return { ...base, state: 'unconfigured' }
    }
    return {
      ...base,
      state: 'invalid',
      installPath: resolution.installPath,
      ...(resolution.cli === undefined ? {} : { cliPath: resolution.cli }),
      ...(resolution.app === undefined ? {} : { appPath: resolution.app }),
      ...(persistedVersion === undefined || persistedVersion === '' ? {} : { version: persistedVersion }),
      ...(source === undefined ? {} : { source }),
      ...(validatedAt === undefined || validatedAt === 0 ? {} : { validatedAt }),
      ...(resolution.error === undefined ? {} : { error: resolution.error }),
    }
  }

  /**
   * Full status for the settings/wizard surfaces.
   * @param jobIds - optional jobs whose progress the caller wants included. Both
   *   tools can be downloading at once, so this is a list: asking for one id at a
   *   time is exactly how the second download used to erase the first one's bar.
   * @returns both tools plus the manifest and target facts.
   */
  async status(jobIds?: readonly string[]): Promise<ToolchainStatus> {
    const [kicad, solidcraft] = await Promise.all([this.toolStatus('kicad'), this.toolStatus('solidcraft')])
    const manifest = await this.manifestState()
    const jobs = (jobIds ?? [])
      .map(id => this.installer.snapshot(id))
      .filter((job): job is InstallJobSnapshot => job !== undefined)
    const downloadsSupported = this.platform === 'win32' || this.platform === 'darwin' || this.platform === 'linux'
    return {
      kicad,
      solidcraft,
      manifest,
      target: { platform: this.platform, arch: this.arch, downloadsSupported },
      official: OFFICIAL_DOWNLOAD_PAGES,
      ...(jobs.length === 0 ? {} : { jobs }),
      ...(jobs.length === 0 ? {} : { job: jobs[0] }),
    }
  }

  /** Manifest projection for the status poll. */
  private async manifestState(): Promise<ToolchainStatus['manifest']> {
    if (this.manifestCache !== undefined && this.now() - this.manifestCache.at < 10 * 60_000) {
      return this.manifestProjection(this.manifestCache.result)
    }
    const pending = this.loadManifest()
    if (pending === undefined) return { state: 'unknown' }
    return this.manifestProjection(await pending)
  }

  private manifestProjection(result: Awaited<ReturnType<typeof fetchManifest>>): ToolchainStatus['manifest'] {
    if (result.ok) {
      return { state: 'ready', schemaVersion: result.manifest.schemaVersion, url: this.options.manifestUrl ?? MANIFEST_URL }
    }
    return { state: 'unavailable', code: result.code, message: result.message }
  }

  /** Fetch the manifest once; concurrent callers share one request. */
  loadManifest(force = false): Promise<Awaited<ReturnType<typeof fetchManifest>>> | undefined {
    if (!force && this.manifestCache !== undefined && this.now() - this.manifestCache.at < 10 * 60_000) {
      return Promise.resolve(this.manifestCache.result)
    }
    if (this.manifestPending !== undefined) return this.manifestPending
    if (this.platform !== 'win32' && this.platform !== 'darwin' && this.platform !== 'linux') return undefined
    this.manifestPending = fetchManifest({
      ...(this.options.manifestUrl === undefined ? {} : { url: this.options.manifestUrl }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      platform: this.platform,
      arch: this.arch,
    }).then((result) => {
      this.manifestCache = { at: this.now(), result }
      this.manifestPending = undefined
      return result
    })
    return this.manifestPending
  }

  /** The validated manifest entry for one tool, when the manifest answered. */
  private async selectedEntry(tool: ToolchainId): Promise<ManifestEntry | undefined> {
    const result = await this.loadManifest()
    if (result === undefined || !result.ok) return undefined
    return result.manifest.selected[tool]
  }

  /** Validated manifest for the installer; a refusal keeps manual paths usable. */
  async manifest(): Promise<{ readonly ok: true; readonly manifest: ToolchainManifest } | ManifestFailure> {
    const result = await this.loadManifest(true)
    return result ?? { ok: false, code: 'network', message: 'the toolchain manifest is unavailable on this platform' }
  }

  /**
   * Validate one user-supplied path without persisting anything (§6.3).
   * @param tool - which toolchain.
   * @param input - installation root, `bin` directory or executable path.
   * @returns resolution verdict with the normalised root to persist on success.
   */
  async validate(tool: ToolchainId, input: string): Promise<ValidationOutcome> {
    const root = installationRootOf(tool, input)
    if (root === undefined) return { ok: false, error: 'a path is required' }
    const resolution = await this.resolve(tool, root)
    return {
      ok: resolution.configured,
      installPath: resolution.installPath,
      ...(resolution.cli === undefined ? {} : { cliPath: resolution.cli }),
      ...(resolution.app === undefined ? {} : { appPath: resolution.app }),
      ...(resolution.version === undefined ? {} : { version: resolution.version }),
      ...(resolution.error === undefined ? {} : { error: resolution.error }),
    }
  }

  /** Persist a validated configuration; the host settings service stays authoritative. */
  async save(tool: ToolchainId, input: string, source: ToolchainSource): Promise<ValidationOutcome> {
    const outcome = await this.validate(tool, input)
    if (!outcome.ok || outcome.installPath === undefined) return outcome
    const patch: ToolchainConfigPatch = tool === 'kicad'
      ? {
          kicadRoot: outcome.installPath,
          kicadVersion: outcome.version ?? '',
          kicadSource: source,
          kicadValidatedAt: this.now(),
        }
      : {
          solidcraftRoot: outcome.installPath,
          solidcraftVersion: outcome.version ?? '',
          solidcraftSource: source,
          solidcraftValidatedAt: this.now(),
        }
    const written = await this.options.persist?.(patch) ?? false
    if (!written) {
      return { ...outcome, ok: false, error: 'the Host refused the configuration write' }
    }
    this.probeCache.clear()
    return outcome
  }

  /**
   * Start background discovery for one tool (or both).
   *
   * Returns the current discovery state immediately: the run continues off-request
   * and the UI polls {@link ToolchainManager.status} (§4.2/§5.5).
   * @param tool - tool to discover; both when omitted.
   * @returns the discovery state at the moment the request was answered.
   */
  startDiscovery(tool?: ToolchainId): { kicad: ToolDiscovery; solidcraft: ToolDiscovery } {
    for (const candidate of tool === undefined ? (['kicad', 'solidcraft'] as const) : [tool]) {
      if (this.discovering.has(candidate)) continue
      this.discovering.add(candidate)
      this.discovery[candidate] = { ...this.discovery[candidate], state: 'running' }
      void this.runDiscovery(candidate)
    }
    return { kicad: this.discovery.kicad, solidcraft: this.discovery.solidcraft }
  }

  /** One bounded discovery run; a failure is recorded, never thrown at the UI. */
  private async runDiscovery(tool: ToolchainId): Promise<void> {
    try {
      const roots = candidateRoots(tool, {
        platform: this.platform,
        env: this.env,
        managedRoot: this.managedRoot,
        home: this.home,
      }, this.options.discoveryInternals ?? {})
      const validated = await this.validateDiscoveryCandidates(tool, roots)
      this.discovery[tool] = {
        tool,
        state: 'done',
        candidates: validated.candidates,
        ...(validated.selected === undefined ? {} : { selected: validated.selected }),
        finishedAt: this.now(),
      }
    } catch (error) {
      this.discovery[tool] = {
        tool,
        state: 'failed',
        candidates: [],
        error: error instanceof Error ? error.message : String(error),
        finishedAt: this.now(),
      }
    } finally {
      this.discovering.delete(tool)
    }
  }

  /**
   * Probe candidates asynchronously, then rank them with the shared policy.
   *
   * The ranking stays in {@link validateCandidates}; this method only supplies
   * the asynchronous probes it needs, keyed by the executable the resolver will
   * actually ask about, so discovery and manual validation cannot disagree about
   * what counts as valid.
   */
  private async validateDiscoveryCandidates(
    tool: ToolchainId,
    roots: readonly { path: string; origin: 'managed' | 'system' | 'user-local' }[],
  ): Promise<{ candidates: ToolDiscovery['candidates']; selected?: NonNullable<ToolDiscovery['selected']> }> {
    const versions = new Map<string, string | undefined>()
    for (const root of roots) {
      const layout = resolveToolchain(tool, root.path, { platform: this.platform })
      const executable = layout.cli ?? layout.app
      if (executable === undefined) continue
      versions.set(executable, await this.versionOf(tool, executable))
    }
    return validateCandidates(tool, roots, {
      ...(this.options.discoveryInternals ?? {}),
      probeVersion: (executable) => versions.get(executable),
    })
  }

  /** One directory probe for a diagnostics path (no version process). */
  probeDirectory(tool: ToolchainId, root: string): ReturnType<typeof probeInstallation> {
    return probeInstallation(tool, root, this.options.discoveryInternals ?? {})
  }

  /** Install the manifest entry for one tool; the job reports progress. */
  async install(tool: ToolchainId): Promise<{ readonly snapshot?: InstallJobSnapshot; readonly error?: ManifestFailure }> {
    const running = this.installer.activeFor(tool)
    if (running !== undefined) return { snapshot: running }
    const result = await this.manifest()
    if (!result.ok) return { error: result }
    const entry = result.manifest.selected[tool]
    if (entry === undefined) {
      return { error: { ok: false, code: 'no-entry', message: `the toolchain manifest offers no ${label(tool)} build for this platform` } }
    }
    // The stage validates through the same resolver a manual save uses, so a
    // freshly extracted tree is judged by exactly the rules §8.5 step 8 states.
    const { snapshot, done } = this.installer.start(tool, entry, {
      validate: async (installPath) => {
        this.probeCache.clear()
        const resolution = await this.resolve(tool, installPath)
        return resolution.configured ? { ok: true } : { ok: false, error: resolution.error ?? 'the installation did not validate' }
      },
      onProgress: () => {},
    })
    void done.then(async (outcome) => {
      await this.afterInstall(tool, entry, outcome)
    })
    return { snapshot }
  }

  /** Persist the completed installation and drop stale probes (§8.5). */
  private async afterInstall(tool: ToolchainId, entry: ManifestEntry, outcome: InstallOutcome): Promise<void> {
    if (!outcome.ok || outcome.installPath === undefined) return
    this.probeCache.clear()
    const probe = await this.resolve(tool, outcome.installPath)
    if (!probe.configured) return
    const patch: ToolchainConfigPatch = tool === 'kicad'
      ? {
          kicadRoot: canonicalPath(outcome.installPath),
          kicadVersion: probe.version ?? entry.version,
          kicadSource: 'download',
          kicadValidatedAt: this.now(),
        }
      : {
          solidcraftRoot: canonicalPath(outcome.installPath),
          solidcraftVersion: probe.version ?? entry.version,
          solidcraftSource: 'download',
          solidcraftValidatedAt: this.now(),
        }
    await this.options.persist?.(patch)
  }

  /** One job's snapshot. */
  job(id: string): InstallJobSnapshot | undefined {
    return this.installer.snapshot(id)
  }

  /** Cancel one running job. */
  cancel(id: string): boolean {
    return this.installer.cancel(id)
  }

  /**
   * Open the native chooser for one tool.
   *
   * The plugin-owned file dialog answers first (it can filter to the expected
   * executable); when it is unavailable the Host's own native folder chooser
   * answers instead, so a native picker exists on every supported desktop.
   * @param tool - which toolchain the choice is for.
   * @param signal - request lifetime; abort dismisses the chooser.
   * @returns the picked path, a cancellation, or an unsupported notice.
   */
  async browse(tool: ToolchainId, signal?: AbortSignal): Promise<BrowseOutcome> {
    const request = {
      title: tool === 'kicad' ? 'Select kicad-cli' : 'Select SolidCraft',
      filters: TOOLCHAIN_FILTERS[tool],
    }
    const dialog = this.options.pickFile ?? pickFile
    const outcome = await dialog(request, {
      ...(signal === undefined ? {} : { signal }),
    })
    if (outcome.kind === 'picked') return { kind: 'picked', path: outcome.path, mechanism: outcome.mechanism }
    if (outcome.kind === 'cancelled') return { kind: 'cancelled', mechanism: outcome.mechanism }
    if (this.options.pickFolder !== undefined) {
      const folder = await this.options.pickFolder(request.title)
      if (folder !== null) return { kind: 'picked', path: folder, mechanism: 'dsh-directory-picker' }
      return { kind: 'cancelled', mechanism: 'dsh-directory-picker' }
    }
    return { kind: 'unsupported', message: outcome.message }
  }

  /**
   * Compact capability facts for the agent (§12.1).
   *
   * Versions and availability only: an agent needs to know whether an export is
   * possible, not where the binary lives, and the tools resolve the executable
   * themselves from the same configuration.
   */
  async capabilities(): Promise<{
    readonly kicad: { readonly available: boolean; readonly version?: string }
    readonly solidcraft: { readonly available: boolean; readonly version?: string; readonly cliAvailable: boolean }
  }> {
    const [kicad, solidcraft] = await Promise.all([this.toolStatus('kicad'), this.toolStatus('solidcraft')])
    return {
      kicad: {
        available: kicad.state === 'configured',
        ...(kicad.version === undefined ? {} : { version: kicad.version }),
      },
      solidcraft: {
        available: solidcraft.state === 'configured',
        ...(solidcraft.version === undefined ? {} : { version: solidcraft.version }),
        cliAvailable: solidcraft.state === 'configured' && solidcraft.cliPath !== undefined,
      },
    }
  }
}
