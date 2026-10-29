/**
 * Plugin-update API client (browser half).
 *
 * Every call is a same-origin fetch against the DSH webServer prefix route
 * (`/api/v1/huaqiu/plugin-update/…`) which the node half forwards to hq-edge.
 * Response shapes mirror hq-edge `apps/server/src/routes/plugin-updates.ts`.
 *
 * @module
 */
import { normalizePluginUpdateReport } from './version.js'

export const UPDATE_BASE = '/api/v1/huaqiu/plugin-update'

export interface PluginUpdateItem {
  name: string
  /** Version installed in the active bundle; null when the plugin is absent. */
  currentVersion: string | null
  availableVersion: string
  /**
   * Server state. `update` is re-checked on arrival against the SemVer
   * direction rule (`version.ts`): an offer that is not strictly newer than
   * `currentVersion` is demoted to `current`, so the panel and the badge can
   * never offer a downgrade even against an older hq-edge.
   */
  state: 'current' | 'update' | 'install' | 'blocked' | 'ignored'
  /** The block reason, or null when the item is not blocked. The server sends a
   *  single code (`"runtime-unknown"`), so it is normalized before use. */
  blockedBy?: string | string[] | null
  ignored?: boolean
  reasons?: string[]
  notes?: string[]
  /**
   * User-facing release metadata (schemaVersion-2 manifests). ALL optional and
   * absent for v1 manifests — the view falls back to the package short name
   * and version line when they are missing.
   */
  displayName?: string
  description?: string
  sizeBytes?: number
  changes?: string[]
}

/**
 * One downloadable HQ Edge runtime distribution, as hq-edge reports it
 * (`RuntimeUpdateEntry` in `apps/server/src/dsh/PluginUpdateService.ts`).
 *
 * Note the shape: `runtime.latest` is this ENTRY OBJECT, not a bare version
 * string. Reading it as a string is what once rendered "[object Object]".
 */
export interface RuntimeUpdateEntry {
  /** Clean SemVer of the available distribution. */
  version: string
  /** SHA-256 of the release archive, lowercase hex (64 chars). */
  sha256: string
  /** Platform the archive targets: win | darwin | linux | all. */
  platform: string
  /** Optional CPU architecture: x64 | arm64 (absent = any). */
  arch?: string
  /** Exact absolute HTTPS URL of the release archive. */
  url: string
  /**
   * Optional user-facing metadata (schemaVersion-2 runtime manifest). All
   * absent for v1 manifests; the panel degrades gracefully without them.
   */
  publishedAt?: string
  sizeBytes?: number
  summary?: string
  notesUrl?: string
  notes?: string[]
  breaking?: string[]
  channel?: string
}

/**
 * The EDA host's own report of the last runtime replacement, read from
 * `runtime-update-result.json` by hq-edge. This is the authoritative outcome
 * after HQ Edge exits and the host swaps the runtime — it must be rendered,
 * not discarded. `state` is `succeeded`, `rolled_back` (swap failed but the
 * previous runtime was restored) or `failed` (no confirmed rollback).
 */
export interface RuntimeLastResult {
  state: 'succeeded' | 'rolled_back' | 'failed'
  targetVersion?: string | null
  installedVersion?: string | null
  at?: string
  errorCode?: string
  message?: string
}

export interface RuntimeUpdateInfo {
  configured: boolean
  currentVersion?: string | null
  /** The latest compatible distribution, or null when the manifest had none. */
  latest?: RuntimeUpdateEntry | null
  updateAvailable: boolean
  checkedAt?: string | null
  lastError?: string | null
  /** The host-reported outcome of the last runtime swap; null when none. */
  lastResult?: RuntimeLastResult | null
  /**
   * Where the runtime-update manifest is read from. Optional: an older hq-edge
   * does not send it, and the panel must degrade to a read-only source row.
   */
  source?: RuntimeUpdateSource
}

/**
 * The runtime-update manifest source, editable from this panel.
 *
 * `origin` says which URL is in effect: `override` is a URL the user set here
 * (persisted by hq-edge per host), `config` is the packaged/env default, and
 * `unset` means runtime updates are not configured at all.
 */
export interface RuntimeUpdateSource {
  /** The manifest URL currently in effect; empty when none is known. */
  url: string
  origin: 'override' | 'config' | 'unset'
  /** The URL configuration supplies, independent of any user override. */
  configuredUrl: string
  /** True when a user override is shadowing the configured URL. */
  override: boolean
}

/**
 * The plugin release-manifest source (the gitee
 * `plugins-release-manifest.json` by default) — same shape and same edit flow
 * as {@link RuntimeUpdateSource}, because hq-edge serves both from one shared
 * type.
 */
export type PluginUpdateSource = RuntimeUpdateSource

/**
 * The latest runtime version to display, or null when there is none.
 *
 * hq-edge sends the full release entry; an older or future server could send
 * a bare string. Both are accepted here so the facts row can never again fall
 * back to `String(object)` — i.e. "[object Object]" — in the DOM.
 */
export function runtimeLatestVersion(
  runtime: RuntimeUpdateInfo | null | undefined,
): string | null {
  const latest: unknown = runtime?.latest
  if (typeof latest === 'string') return latest.length > 0 ? latest : null
  if (latest !== null && typeof latest === 'object' && 'version' in latest) {
    const version = (latest as { version?: unknown }).version
    if (typeof version === 'string' && version.length > 0) return version
  }
  return null
}

/**
 * Set-level release metadata from a schemaVersion-2 plugin manifest. ALL
 * fields optional: v1 manifests send none, and the panel must fall back to
 * showing just the version then.
 */
export interface ReleaseInfo {
  publishedAt?: string
  channel?: string
  requiresRestart?: boolean
  summary?: string
  notesUrl?: string
  notes?: string[]
  breaking?: string[]
}

export interface PluginUpdateReport {
  /** The evaluated release set; null while no manifest has been read. */
  manifestVersion: string | null
  pluginSetVersion?: string
  items: PluginUpdateItem[]
  actionableCount: number
  ignoredSet: boolean
  fetchedAt?: string
  /** When the last plugin discovery ran (ISO); drives the "上次检查" row. */
  checkedAt?: string | null
  /** Non-empty when the last plugin discovery FAILED — the panel must show
   *  an error row with a Retry, never the silent "no updates" empty state. */
  lastError?: string | null
  /** Set-level release metadata; absent for v1 manifests. */
  release?: ReleaseInfo | null
  runtime: RuntimeUpdateInfo
  /**
   * Where the plugin release manifest is read from. Optional: an older
   * hq-edge does not send it, and the panel must degrade to no source row.
   */
  pluginSource?: PluginUpdateSource
}

// ── Durable update-job lifecycle (GET /status, GET /status/:id) ────────────

/** Lifecycle phases of one durable update job. Terminal phases end the poll. */
export type UpdatePhase =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'staging'
  | 'activating'
  | 'awaiting-host'
  | 'restarting'
  | 'verifying-after-restart'
  | 'done'
  | 'failed'
  | 'rolled-back'
  | 'abandoned'

/** Phases after which a job never runs again — polling stops and a result view
 *  replaces the active-job view. */
export const TERMINAL_PHASES: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>([
  'done',
  'failed',
  'rolled-back',
  'abandoned',
])

export type UpdateKind = 'plugin-set' | 'runtime'

export interface UpdateJobProgress {
  /** 0..100 when the phase has a meaningful percentage; null otherwise. */
  percent: number | null
  bytesDone?: number
  bytesTotal?: number
  bytesPerSecond?: number
  etaSeconds?: number
}

export interface UpdateStep {
  name: string
  state: 'pending' | 'running' | 'installed' | 'skipped' | 'failed'
  percent?: number
  message?: string
}

export interface UpdateJobResult {
  ok: boolean
  installedVersion: string | null
  errorCode?: string
  message?: string
  rolledBack: boolean
  finishedAt: string
}

/**
 * One durable update job, as hq-edge reports it (`GET /status` and
 * `/status/:id`). The UI is a projection of this job: opening the panel
 * resumes whatever the server says is active, rather than owning the
 * lifecycle in a DOM closure.
 */
export interface UpdateJob {
  id: string
  kind: UpdateKind
  targetVersion: string
  previousVersion: string | null
  startedAt: string
  updatedAt: string
  phase: UpdatePhase
  message?: string
  progress: UpdateJobProgress
  steps?: UpdateStep[]
  result?: UpdateJobResult
  logHint?: string
}

/** `GET /status`: the current active job plus a bounded list of recent ones. */
export interface UpdateJobStatus {
  activeJob: UpdateJob | null
  recentJobs: UpdateJob[]
}

const PHASE_VALUES: ReadonlySet<string> = new Set<string>([
  'queued',
  'resolving',
  'downloading',
  'verifying',
  'staging',
  'activating',
  'awaiting-host',
  'restarting',
  'verifying-after-restart',
  'done',
  'failed',
  'rolled-back',
  'abandoned',
])

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === 'string')
  return out.length > 0 ? out : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Defensively normalize one job payload from the wire into {@link UpdateJob}.
 *  Unknown/older servers may omit fields; a malformed `phase` falls back to
 *  `queued` rather than crashing the view. */
export function normalizeJob(raw: unknown): UpdateJob | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  const phase = typeof r.phase === 'string' && PHASE_VALUES.has(r.phase)
    ? (r.phase as UpdatePhase)
    : 'queued'
  const progressRaw = (r.progress ?? {}) as Record<string, unknown>
  const percentRaw = asFiniteNumber(progressRaw.percent)
  const progress: UpdateJobProgress = {
    percent: percentRaw === undefined ? null : Math.min(100, Math.max(0, percentRaw)),
  }
  const bytesDone = asFiniteNumber(progressRaw.bytesDone)
  const bytesTotal = asFiniteNumber(progressRaw.bytesTotal)
  const bytesPerSecond = asFiniteNumber(progressRaw.bytesPerSecond)
  const etaSeconds = asFiniteNumber(progressRaw.etaSeconds)
  if (bytesDone !== undefined) progress.bytesDone = bytesDone
  if (bytesTotal !== undefined) progress.bytesTotal = bytesTotal
  if (bytesPerSecond !== undefined) progress.bytesPerSecond = bytesPerSecond
  if (etaSeconds !== undefined) progress.etaSeconds = etaSeconds

  const job: UpdateJob = {
    id: r.id,
    kind: r.kind === 'runtime' ? 'runtime' : 'plugin-set',
    targetVersion: typeof r.targetVersion === 'string' ? r.targetVersion : '',
    previousVersion:
      typeof r.previousVersion === 'string' ? r.previousVersion : null,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    phase,
    progress,
  }
  if (typeof r.message === 'string' && r.message.length > 0) job.message = r.message
  if (typeof r.logHint === 'string' && r.logHint.length > 0) job.logHint = r.logHint

  if (Array.isArray(r.steps)) {
    const steps: UpdateStep[] = []
    for (const entry of r.steps) {
      if (entry === null || typeof entry !== 'object') continue
      const s = entry as Record<string, unknown>
      if (typeof s.name !== 'string') continue
      const state =
        s.state === 'running' || s.state === 'installed' || s.state === 'skipped' || s.state === 'failed'
          ? s.state
          : 'pending'
      const step: UpdateStep = { name: s.name, state }
      const pct = asFiniteNumber(s.percent)
      if (pct !== undefined) step.percent = pct
      if (typeof s.message === 'string' && s.message.length > 0) step.message = s.message
      steps.push(step)
    }
    if (steps.length > 0) job.steps = steps
  }

  if (r.result !== null && typeof r.result === 'object') {
    const res = r.result as Record<string, unknown>
    const result: UpdateJobResult = {
      ok: res.ok === true,
      installedVersion:
        typeof res.installedVersion === 'string' ? res.installedVersion : null,
      rolledBack: res.rolledBack === true,
      finishedAt: typeof res.finishedAt === 'string' ? res.finishedAt : '',
    }
    if (typeof res.errorCode === 'string' && res.errorCode.length > 0) result.errorCode = res.errorCode
    if (typeof res.message === 'string' && res.message.length > 0) result.message = res.message
    job.result = result
  }
  return job
}

/** Normalize a `GET /status` payload; an empty/absent body degrades to "no
 *  active job" rather than throwing. */
export function normalizeJobStatus(raw: unknown): UpdateJobStatus {
  if (raw === null || typeof raw !== 'object') return { activeJob: null, recentJobs: [] }
  const r = raw as Record<string, unknown>
  const activeJob = normalizeJob(r.activeJob)
  const recentJobs = Array.isArray(r.recentJobs)
    ? r.recentJobs.map(normalizeJob).filter((j): j is UpdateJob => j !== null)
    : []
  return { activeJob, recentJobs }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${UPDATE_BASE}${path}`, {
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  })
  const body = (await res.json().catch(() => null)) as T | null
  if (!res.ok) {
    const err = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new Error(err)
  }
  if (body === null) throw new Error('empty response')
  return body
}

/** GET the cached (or empty-shell) plugin-update report. */
export function fetchReport(): Promise<PluginUpdateReport> {
  return request<PluginUpdateReport>('/report').then(normalizePluginUpdateReport)
}

/** POST an explicit refresh; returns the freshly computed report. */
export function checkUpdates(): Promise<PluginUpdateReport> {
  return request<PluginUpdateReport>('/check', { method: 'POST' }).then(normalizePluginUpdateReport)
}

export interface InstallResult {
  /**
   * New durable contract: `202 { jobId, state: 'accepted' }`. The install is
   * now an async job — poll `/status/:jobId` for progress, don't read success
   * off this response. Legacy boolean fields are kept for older hq-edge.
   */
  jobId?: string
  state?: string
  ok?: boolean
  installedSetVersion?: string
  installed?: number
  skipped?: number
  restarting?: boolean
  error?: string
}

/** POST the install transaction for the confirmed set version. */
export function installSet(setVersion: string, pluginNames?: string[]): Promise<InstallResult> {
  return request<InstallResult>('/install', {
    method: 'POST',
    body: JSON.stringify({ setVersion, ...(pluginNames ? { pluginNames } : {}) }),
  })
}

/** Persist a per-plugin decision for this release set. */
export function ignorePlugin(setVersion: string, name: string): Promise<unknown> {
  return request<unknown>('/plugin-ignore', { method: 'POST', body: JSON.stringify({ setVersion, name }) })
}

export function unignorePlugin(setVersion: string, name: string): Promise<unknown> {
  return request<unknown>('/plugin-unignore', { method: 'POST', body: JSON.stringify({ setVersion, name }) })
}

/** POST ignore for the current offer (set-scoped, persists across restarts). */
export function ignoreOffer(setVersion: string): Promise<unknown> {
  return request<unknown>('/ignore', { method: 'POST', body: JSON.stringify({ setVersion }) })
}

/**
 * The outcome of a user-confirmed HQ Edge runtime update.
 *
 * hq-edge answers `202 { requestId, targetVersion, state: 'accepted' }` and
 * then shuts itself down for the EDA host to swap the runtime, so a success
 * here means "accepted", not "installed". Failures arrive as 409 (already
 * updating → `busy`), 422 (preflight/manifest/download refused) or 503.
 */
export interface RuntimeUpdateRequestResult {
  /** Durable job id — poll `/status/:jobId` for the accepted job's progress. */
  jobId?: string
  requestId?: string
  targetVersion?: string
  state?: string
  ok?: boolean
  error?: string
  busy?: boolean
}

/** POST the user-confirmed HQ Edge runtime update for one target version. */
export function requestRuntimeUpdate(
  targetVersion: string,
): Promise<RuntimeUpdateRequestResult> {
  return request<RuntimeUpdateRequestResult>('/runtime-request', {
    method: 'POST',
    body: JSON.stringify({ targetVersion }),
  })
}

/** POST unignore for the set version (reverses an ignore). */
export function unignoreOffer(setVersion: string): Promise<unknown> {
  return request<unknown>('/unignore', { method: 'POST', body: JSON.stringify({ setVersion }) })
}

/**
 * GET the runtime-update manifest source: the URL in effect, its origin
 * (`override` | `config` | `unset`) and the configured URL behind it.
 *
 * Read-only upstream, so this is open like `/report` — only the mutation
 * below is loopback-guarded (and reaches it same-origin anyway).
 */
export function getRuntimeUpdateSource(): Promise<RuntimeUpdateSource> {
  return request<RuntimeUpdateSource>('/runtime-source')
}

/**
 * POST a new runtime-update manifest URL, or `""` to clear a user override
 * and fall back to the configured URL.
 *
 * hq-edge validates the URL itself (`https` required except for loopback, no
 * embedded credentials) and answers 422 with a message meant for a person —
 * this client surfaces it verbatim rather than pre-validating, so the rule
 * lives in exactly one place. A successful answer is the NEW source; the
 * caller must then re-run discovery, because the cached report still names
 * the old manifest's offer.
 */
export function setRuntimeUpdateSource(url: string): Promise<RuntimeUpdateSource> {
  return request<RuntimeUpdateSource>('/runtime-source', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

/**
 * GET the plugin release-manifest source: the URL discovery reads, its origin
 * (`override` | `config` | `unset`) and the configured URL behind it. Same
 * open/read-only contract as the runtime source.
 */
export function getPluginUpdateSource(): Promise<PluginUpdateSource> {
  return request<PluginUpdateSource>('/plugin-source')
}

/**
 * POST a new plugin release-manifest URL, or `""` to clear a user override.
 *
 * hq-edge persists the override per host AND re-runs discovery in the
 * background, so the next report (and the sidebar badge) already reflect the
 * new manifest. This client still re-checks explicitly after a save — the
 * background pass is a safety net for other consumers, not a substitute.
 */
export function setPluginUpdateSource(url: string): Promise<PluginUpdateSource> {
  return request<PluginUpdateSource>('/plugin-source', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

/**
 * GET the durable job status: the currently active job (if any) plus a bounded
 * list of recent jobs. This is what the panel reads BEFORE running discovery
 * on open, so an in-flight install/runtime update is resumed instead of
 * forgotten. An older hq-edge without the status route 404s — callers catch
 * that and degrade to "no active job".
 */
export function fetchJobStatus(): Promise<UpdateJobStatus> {
  return request<unknown>('/status').then(normalizeJobStatus)
}

/** GET one job by id; rejects (upstream 404 `unknown job`) for an unknown id. */
export function fetchJob(id: string): Promise<UpdateJob> {
  return request<unknown>(`/status/${encodeURIComponent(id)}`).then((raw) => {
    const job = normalizeJob(raw)
    if (job === null) throw new Error('malformed job payload')
    return job
  })
}
