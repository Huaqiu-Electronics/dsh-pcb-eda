/**
 * Client-side toolchain state: one controller, shared by every surface.
 *
 * The wizard step and the Settings section must never disagree about what is
 * configured (§10.5), so nothing here is duplicated per surface: both read this
 * controller, which is the only thing that polls the Host, starts a download,
 * or opens a native chooser. The controller holds no React state — it exposes a
 * `useSyncExternalStore`-shaped snapshot — so it can live for the lifetime of
 * the plugin, survive the settings dialog closing, and keep a download running
 * while the user navigates away.
 *
 * Two kinds of fact arrive from the Host and are kept apart deliberately:
 *   - `status` is authoritative (the Host resolves paths with the same parser a
 *     manual save uses), and is re-read after every write;
 *   - `job` is a mirror of one install run, polled only while it is running.
 *
 * Everything the surfaces show about a tool is a projection of those two; none
 * of them decides "configured" on its own.
 *
 * @module @huaqiu/dsh-hardware-ui/client/toolchain
 */
import { COPY } from './copy.js'
import { messageOf } from './transport.js'
import {
  browseToolchain, cancelToolchain, installToolchain, loadToolchainStatus,
  saveToolchain, startToolchainDiscovery, validateToolchain,
} from './transport.js'

export type ToolchainId = 'kicad' | 'solidcraft'

/** §10.3 status semantics: green only ever follows a successful validation. */
export type ToolState = 'unconfigured' | 'validating' | 'configured' | 'invalid'

export type ToolSource = 'manual' | 'browse' | 'download' | 'detected'

export type InstallPhase =
  | 'download' | 'verify' | 'extract' | 'layout' | 'promote' | 'done' | 'failed' | 'cancelled'

/** One directory discovery looked at, and what it found there. */
export interface DiscoveryCandidate {
  readonly path: string
  readonly origin: 'managed' | 'system' | 'user-local'
  readonly valid: boolean
  readonly version?: string
  readonly cli?: string
  readonly error?: string
}

/** Background discovery state for one tool (§4.2 — never blocks the UI). */
export interface ToolDiscoveryView {
  readonly tool: ToolchainId
  readonly state: 'idle' | 'running' | 'done' | 'failed'
  readonly candidates: readonly DiscoveryCandidate[]
  readonly selected?: DiscoveryCandidate
  readonly error?: string
  readonly finishedAt?: number
}

/** One tool's row in the two cards. */
export interface ToolStatus {
  readonly tool: ToolchainId
  readonly state: ToolState
  readonly installPath?: string
  readonly cliPath?: string
  readonly appPath?: string
  readonly version?: string
  readonly source?: ToolSource
  readonly validatedAt?: number
  readonly error?: string
  readonly discovery: ToolDiscoveryView
  readonly download?: { readonly version: string; readonly url: string }
}

/**
 * The executable picker the card's Browse opens (prototype §"SIMULATED OS SYSTEM
 * FILE EXPLORER DIALOG"): the detected executables as a list, a path field, and a
 * link that hands the choice to the real OS dialog.
 */
export interface ToolchainPicker {
  readonly tool: ToolchainId
  /** Row the user clicked; mirrored into the footer's path field. */
  readonly chosen?: string
  /** The real OS chooser is open; the modal waits for it. */
  readonly nativePending: boolean
  /** Rows on offer, from the last discovery answer (invalid ones included, disabled). */
  readonly candidates: readonly DiscoveryCandidate[]
  readonly refreshing: boolean
}

/** Everything both surfaces need, from one poll. */
export interface ToolchainStatus {
  readonly kicad: ToolStatus
  readonly solidcraft: ToolStatus
  readonly manifest:
    | { readonly state: 'unknown' | 'loading' }
    | { readonly state: 'ready'; readonly schemaVersion: number; readonly url: string }
    | { readonly state: 'unavailable'; readonly code: string; readonly message: string }
  readonly target: { readonly platform: string; readonly arch: string; readonly downloadsSupported: boolean }
  readonly official: Readonly<Record<ToolchainId, string>>
  /** Jobs the poll asked about, one per tool (both tools may install at once). */
  readonly jobs?: readonly InstallJob[]
  /** First of `jobs`; kept for callers that only ever watch one run. */
  readonly job?: InstallJob
}

/** One install run, as the Host reports it. */
export interface InstallJob {
  readonly id: string
  readonly tool: ToolchainId
  readonly version: string
  readonly phase: InstallPhase
  readonly received: number
  readonly total?: number
  readonly percent?: number
  readonly message: string
  readonly errorCode?: string
  readonly error?: string
  readonly installPath?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Verdict of a validate / save round trip. */
export interface ValidationOutcome {
  readonly ok: boolean
  readonly installPath?: string
  readonly cliPath?: string
  readonly appPath?: string
  readonly version?: string
  readonly error?: string
}

/** Result of a native browse request (§6.2). */
export interface BrowseOutcome {
  readonly kind: 'picked' | 'cancelled' | 'unsupported'
  readonly path?: string
  readonly mechanism?: string
  readonly message?: string
}

/** Tone of one transient notice (§11 — never a modal for an ordinary failure). */
export type ToastTone = 'ok' | 'warn' | 'error' | 'info'

export interface ToastItem {
  readonly id: number
  readonly tone: ToastTone
  readonly text: string
}

/** Immutable render state; identity changes only when something changed. */
export interface ToolchainSnapshot {
  readonly status?: ToolchainStatus
  readonly loading: boolean
  readonly error?: string
  /** Tool whose save round trip is in flight, for per-card button state. */
  readonly saving?: ToolchainId
  /**
   * Install jobs by tool. Keyed by tool, not "the current job": both tools can
   * download at the same time, and each card owns its own bar.
   */
  readonly jobs: Readonly<Partial<Record<ToolchainId, InstallJob>>>
  /** Path currently held in each card's input, kept here so both surfaces agree. */
  readonly drafts: Readonly<Record<ToolchainId, string>>
  readonly toasts: readonly ToastItem[]
  /** Open executable picker (Browse), if any. */
  readonly picker?: ToolchainPicker
}

/** The Host calls the controller needs; injectable so tests need no HTTP. */
export interface ToolchainTransport {
  status(jobIds?: readonly string[]): Promise<ToolchainStatus>
  validate(tool: ToolchainId, path: string): Promise<ValidationOutcome>
  save(tool: ToolchainId, path: string, source: ToolSource): Promise<ValidationOutcome>
  browse(tool: ToolchainId): Promise<BrowseOutcome>
  install(tool: ToolchainId): Promise<InstallJob | undefined>
  cancel(id: string): Promise<boolean>
  discover(tool?: ToolchainId): Promise<void>
}

/** Real transport: the plugin's own route prefix, via `transport.ts`. */
export const HOST_TRANSPORT: ToolchainTransport = {
  status: jobIds => loadToolchainStatus(jobIds),
  validate: (tool, path) => validateToolchain(tool, path),
  save: (tool, path, source) => saveToolchain(tool, path, source),
  browse: tool => browseToolchain(tool),
  install: tool => installToolchain(tool),
  cancel: id => cancelToolchain(id),
  discover: tool => startToolchainDiscovery(tool),
}

/** How long one toast stays before it fades on its own. */
const TOAST_MS = 7000
/** Poll cadence while a job or a discovery run is live. */
const POLL_MS = 700

const EMPTY_DRAFTS: Readonly<Record<ToolchainId, string>> = { kicad: '', solidcraft: '' }

/** Is this job still doing work? */
export function jobRunning(job: InstallJob | undefined): boolean {
  if (job === undefined) return false
  return job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled'
}

/**
 * Merge the jobs a poll returned into the per-tool map.
 *
 * The Host answers only about the ids we asked for, so anything it omits is kept
 * from the previous snapshot — a poll that races the end of a run must not blank
 * the other card's bar. Incoming jobs win for their own tool.
 */
function collectJobs(
  status: ToolchainStatus,
  previous: Readonly<Partial<Record<ToolchainId, InstallJob>>>,
): Readonly<Partial<Record<ToolchainId, InstallJob>>> {
  const incoming = status.jobs ?? (status.job === undefined ? [] : [status.job])
  if (incoming.length === 0) return previous
  const next = { ...previous }
  for (const job of incoming) next[job.tool] = job
  return next
}

/** Whole-percent progress, derived when the Host has no reliable total. */
export function jobPercent(job: InstallJob | undefined): number | undefined {
  if (job === undefined) return undefined
  if (job.percent !== undefined) return job.percent
  if (job.total === undefined || job.total <= 0) return undefined
  return Math.min(100, Math.round((job.received / job.total) * 100))
}

/** Both tools configured and validated — the condition that ends the nudges. */
export function setupComplete(status: ToolchainStatus | undefined): boolean {
  return status?.kicad.state === 'configured' && status.solidcraft.state === 'configured'
}

/** True while any tool still needs the user (§10.4 sidebar dot). */
export function setupIncomplete(status: ToolchainStatus | undefined): boolean {
  if (status === undefined) return false
  return status.kicad.state !== 'configured' || status.solidcraft.state !== 'configured'
}

/** One status line for the sidebar indicator's tooltip. */
export function setupSummary(status: ToolchainStatus | undefined): string {
  if (status === undefined) return COPY.toolchain.checking
  const kicad = status.kicad.state === 'configured' ? `KiCad v${status.kicad.version ?? '?'}` : COPY.toolchain.kicadMissing
  const solidcraft = status.solidcraft.state === 'configured'
    ? `SolidCraft v${status.solidcraft.version ?? '?'}`
    : COPY.toolchain.solidcraftMissing
  return `${kicad} · ${solidcraft}`
}

type Listener = () => void

/**
 * The one toolchain state machine of the browser half.
 *
 * Writes are serialised by the Host (validate/save/install each answer before
 * the next poll), so the controller keeps no queue: it refreshes after every
 * write it issues and lets the poll be the arbiter. Polling stops as soon as
 * nothing is running, which keeps an idle settings panel free of requests.
 */
export class ToolchainController {
  private snapshot: ToolchainSnapshot = { loading: true, jobs: {}, drafts: EMPTY_DRAFTS, toasts: [] }
  private readonly listeners = new Set<Listener>()
  private toastSeq = 0
  private timer?: ReturnType<typeof setTimeout>
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>()
  private stopped = false
  private started = false
  /** §11 notices fire once per phase *per tool*, so two downloads cannot mute each other. */
  private readonly phases = new Map<ToolchainId, InstallPhase>()
  /** The job id each tool's card is watching; the poll asks for all of them at once. */
  private readonly watched = new Map<ToolchainId, string>()

  constructor(
    private readonly transport: ToolchainTransport = HOST_TRANSPORT,
    private readonly pollMs = POLL_MS,
  ) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): ToolchainSnapshot => this.snapshot

  private set(patch: Partial<ToolchainSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /**
   * Boot the capability once per client session: read the status, then start
   * discovery in the background (§4.2 — the wizard opens first, discovery
   * answers later). Safe to call twice: the second call is a no-op.
   */
  start(): void {
    if (this.started) return
    this.started = true
    void this.refresh()
    void this.transport.discover().catch(() => { /* discovery failure is a state, not an error */ })
  }

  /** Stop polling and drop timers (plugin unload). */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.listeners.clear()
  }

  /** Read the Host status, asking about every job a card is watching. */
  async refresh(jobIds?: readonly string[]): Promise<void> {
    if (this.stopped) return
    const asked = jobIds ?? [...this.watched.values()]
    try {
      const status = await this.transport.status(asked.length === 0 ? undefined : asked)
      if (this.stopped) return
      // Keep the drafts in step with authoritative paths, but never overwrite
      // text the user is typing: only a changed stored root moves the input.
      let drafts = this.snapshot.drafts
      const kicad = this.syncDraft('kicad', status.kicad.installPath)
      if (kicad !== undefined) drafts = { ...drafts, kicad }
      const solidcraft = this.syncDraft('solidcraft', status.solidcraft.installPath)
      if (solidcraft !== undefined) drafts = { ...drafts, solidcraft }
      const jobs = collectJobs(status, this.snapshot.jobs)
      this.set({ status, loading: false, error: undefined, drafts, jobs })
      for (const job of Object.values(jobs)) {
        if (job !== undefined) this.noteJob(job)
      }
      // Stop asking about runs that are over — but only when we actually know
      // that. A poll that arrives before the Host reports a just-started job (or
      // answers nothing about it) must not silently drop the bar it is drawing.
      for (const [tool, id] of this.watched) {
        const seen = jobs[tool]
        if (seen !== undefined && seen.id === id && jobRunning(seen)) continue
        if (seen !== undefined && seen.id !== id && jobRunning(seen)) {
          this.watched.set(tool, seen.id)
          continue
        }
        this.watched.delete(tool)
      }
      this.scheduleIfBusy()
    } catch (error) {
      if (this.stopped) return
      this.set({ loading: false, error: messageOf(error) })
    }
  }

  /** Last authoritative root seen per tool; the draft follows it, not the other way round. */
  private roots: Record<ToolchainId, string> = { kicad: '', solidcraft: '' }

  /**
   * Move the input with the authoritative root, unless the user owns the text.
   *
   * The input follows a changed stored root only while it is empty or still shows
   * the previous root. Anything the user typed — or picked in the executable
   * picker — is theirs until they save it, so a poll (or the rescan the picker
   * itself triggers) cannot erase it.
   */
  private syncDraft(tool: ToolchainId, installPath: string | undefined): string | undefined {
    const next = installPath ?? ''
    const previous = this.roots[tool]
    if (next === previous) return undefined
    this.roots[tool] = next
    const draft = this.snapshot.drafts[tool]
    if (draft !== '' && draft !== previous) return undefined
    return next
  }

  /** One card's input text, with the other tool's text untouched. */
  private withDraft(tool: ToolchainId, value: string): Readonly<Record<ToolchainId, string>> {
    return tool === 'kicad'
      ? { ...this.snapshot.drafts, kicad: value }
      : { ...this.snapshot.drafts, solidcraft: value }
  }


  /** Poll again while anything is live; sleep otherwise. */
  private scheduleIfBusy(): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const busy = Object.values(this.snapshot.jobs).some(jobRunning)
      || jobRunning(this.snapshot.status?.job)
      || this.snapshot.status?.kicad.discovery.state === 'running'
      || this.snapshot.status?.solidcraft.discovery.state === 'running'
    if (!busy) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh()
    }, this.pollMs)
  }

  /** One notice, deduplicated by text so a poll cannot spam the overlay. */
  toast(tone: ToastTone, text: string): void {
    if (this.snapshot.toasts.some(item => item.text === text)) return
    this.toastSeq += 1
    const id = this.toastSeq
    this.set({ toasts: [...this.snapshot.toasts, { id, tone, text }].slice(-3) })
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id)
      this.dismiss(id)
    }, TOAST_MS))
  }

  /** Drop one notice (the overlay's own close button). */
  dismiss(id: number): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    if (!this.snapshot.toasts.some(item => item.id === id)) return
    this.set({ toasts: this.snapshot.toasts.filter(item => item.id !== id) })
  }

  /** Fire the transitions §11 allows; nothing else notifies. */
  private noteJob(job: InstallJob): void {
    const previous = this.phases.get(job.tool)
    if (previous === job.phase) return
    this.phases.set(job.tool, job.phase)
    const name = job.tool === 'kicad' ? 'KiCad' : 'SolidCraft'
    if (job.phase === 'verify') this.toast('info', COPY.toolchain.toastDownloaded(name, job.version))
    else if (job.phase === 'extract' || job.phase === 'layout' || job.phase === 'promote') {
      if (previous !== 'extract' && previous !== 'layout' && previous !== 'promote') {
        this.toast('info', COPY.toolchain.toastExtracting(name))
      }
    } else if (job.phase === 'done') {
      this.toast('ok', COPY.toolchain.toastInstalled(name, job.version))
    } else if (job.phase === 'failed') {
      this.toast('error', job.errorCode === 'checksum-mismatch'
        ? COPY.toolchain.toastChecksum(name)
        : COPY.toolchain.toastFailed(name, job.error ?? job.message))
    } else if (job.phase === 'cancelled') {
      this.toast('warn', COPY.toolchain.toastCancelled(name))
    }
  }

  /** Start the manifest-provided download for one tool (§7.4). */
  async install(tool: ToolchainId): Promise<void> {
    const name = tool === 'kicad' ? 'KiCad' : 'SolidCraft'
    try {
      const job = await this.transport.install(tool)
      if (job === undefined) {
        this.toast('warn', COPY.toolchain.downloadUnavailable(name))
        return
      }
      // Watch this tool's job; the other card keeps watching its own, so two
      // simultaneous downloads both keep a live bar.
      this.watched.set(tool, job.id)
      this.phases.delete(tool)
      // Record it locally even when no status is known yet: the bar has to exist
      // between the `install` answer and the first poll that mentions the job.
      const current = this.snapshot.status
      this.set({
        jobs: { ...this.snapshot.jobs, [tool]: job },
        ...(current === undefined ? {} : { status: { ...current, job } }),
      })
      this.toast('info', COPY.toolchain.toastStarted(name, job.version))
      this.scheduleIfBusy()
      void this.refresh([...this.watched.values()])
    } catch (error) {
      this.toast('warn', COPY.toolchain.downloadUnavailableWith(name, messageOf(error)))
    }
  }

  /** Stop a running download or extraction. */
  async cancel(id: string): Promise<void> {
    try {
      await this.transport.cancel(id)
    } catch (error) {
      this.toast('error', messageOf(error))
    }
    for (const [tool, jobId] of this.watched) {
      if (jobId === id) this.watched.delete(tool)
    }
    await this.refresh()
  }

  /** Native chooser; a picked path lands in that card's input, not in config. */
  async browse(tool: ToolchainId): Promise<string | undefined> {
    try {
      const outcome = await this.transport.browse(tool)
      if (outcome.kind === 'picked' && outcome.path !== undefined) {
        this.set({ drafts: this.withDraft(tool, outcome.path) })
        return outcome.path
      }
      if (outcome.kind === 'unsupported') {
        this.toast('warn', COPY.toolchain.browseUnsupported(outcome.message ?? ''))
      }
      return undefined
    } catch (error) {
      this.toast('error', messageOf(error))
      return undefined
    }
  }

  /** Open the executable picker for one tool (the card's Browse). */
  openPicker(tool: ToolchainId): void {
    const discovery = this.snapshot.status?.[tool].discovery
    this.set({
      picker: {
        tool,
        candidates: discovery?.candidates ?? [],
        nativePending: false,
        refreshing: false,
      },
    })
    // A fresh profile may still be scanning, and an all-invalid list is worth
    // re-checking: the picker opens at once and fills in as the scan answers.
    if (discovery === undefined || discovery.state !== 'done' || discovery.candidates.length === 0) {
      void this.refreshPicker()
    }
  }

  closePicker(): void {
    if (this.snapshot.picker === undefined) return
    this.set({ picker: undefined })
  }

  /** Highlight one row (the footer path field follows it). */
  choosePick(path: string): void {
    const picker = this.snapshot.picker
    if (picker === undefined) return
    this.set({ picker: { ...picker, chosen: path } })
  }

  /** Re-run discovery from inside the picker, then re-list what it found. */
  async refreshPicker(): Promise<void> {
    const picker = this.snapshot.picker
    if (picker === undefined) return
    this.set({ picker: { ...picker, refreshing: true } })
    try {
      await this.transport.discover(picker.tool)
    } catch (error) {
      this.toast('warn', messageOf(error))
    }
    await this.refresh()
    const current = this.snapshot.picker
    if (current === undefined || current.tool !== picker.tool) return
    this.set({
      picker: {
        ...current,
        candidates: this.snapshot.status?.[picker.tool].discovery.candidates ?? current.candidates,
        refreshing: false,
      },
    })
  }

  /** Take the highlighted row into the card's input and close the picker. */
  confirmPick(): void {
    const picker = this.snapshot.picker
    if (picker === undefined || picker.chosen === undefined) return
    this.setDraft(picker.tool, picker.chosen)
    this.set({ picker: undefined })
  }

  /** The picker's "Open Native OS Picker" link: the real dialog decides. */
  async nativePick(): Promise<void> {
    const picker = this.snapshot.picker
    if (picker === undefined || picker.nativePending) return
    this.set({ picker: { ...picker, nativePending: true } })
    const picked = await this.browse(picker.tool)
    const current = this.snapshot.picker
    if (current === undefined) return
    this.set({ picker: picked === undefined ? { ...current, nativePending: false } : undefined })
  }

  /** Type a path without persisting it. */
  setDraft(tool: ToolchainId, value: string): void {
    this.set({ drafts: this.withDraft(tool, value) })
  }

  /** Validate and persist one path through the Host (§6.3). */
  async save(tool: ToolchainId, path: string, source: ToolSource = 'manual'): Promise<ValidationOutcome> {
    const name = tool === 'kicad' ? 'KiCad' : 'SolidCraft'
    this.set({ saving: tool })
    try {
      const outcome = await this.transport.save(tool, path, source)
      if (outcome.ok) {
        this.toast('ok', COPY.toolchain.toastSaved(name, outcome.version ?? '?'))
      } else {
        this.toast('warn', COPY.toolchain.toastInvalid(name, outcome.error ?? COPY.toolchain.notDetected))
      }
      await this.refresh()
      return outcome
    } catch (error) {
      this.toast('error', messageOf(error))
      return { ok: false, error: messageOf(error) }
    } finally {
      this.set({ saving: undefined })
    }
  }

  /** Check a path without persisting anything (the input's own verdict). */
  async validate(tool: ToolchainId, path: string): Promise<ValidationOutcome> {
    try {
      return await this.transport.validate(tool, path)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** Re-run discovery on demand (the card's "check again"). */
  async discover(tool?: ToolchainId): Promise<void> {
    try {
      await this.transport.discover(tool)
    } catch (error) {
      this.toast('warn', messageOf(error))
    }
    await this.refresh()
  }

  /** Adopt a discovered candidate into that card's input (§4.3). */
  adopt(tool: ToolchainId, path: string): void {
    this.setDraft(tool, path)
  }
}
