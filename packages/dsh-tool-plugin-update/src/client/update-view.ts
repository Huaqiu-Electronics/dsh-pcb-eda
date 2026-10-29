/**
 * Plugin-update review view (browser half) — the "更新中心" panel.
 *
 * Plain-DOM (no React tree) so it can never disturb the DSH shell's
 * reconciliation — the same rule as the sidebar entry rows. The layout follows
 * `docs/prototype/plugin_update_ui_ux_prototype.html`; the reasoning behind the
 * order is in `docs/report/plugin-update-ui-ux-baseline.md`.
 *
 * Information architecture, top to bottom, and why:
 *
 *   1. **header** — brand, title, `版本集 vX · N 分钟前`, and the four icon
 *      actions (refresh · sources · job log · close). The set version and the
 *      relative check time live here exactly once; the body never repeats them.
 *   2. **settings strip** (gear) — the two manifest URLs, editable in place.
 *   3. **check-failed banner** — an error, never the silent empty state.
 *   4. **active job card** — pulsing title + percent + bar + telemetry +
 *      4-step pipeline, resumed on open and polled to its end.
 *   5. **failed-result banner** — error code + Retry + 查看日志. The full log
 *      lives in the header's drawer; the *outcome* must not hide behind it.
 *   6. **decision band** — one line: how many plugins, and whether the runtime
 *      is separately upgradable. This is the "what do I have to decide" row.
 *   7. **actionable cards** — 单独更新 / 忽略 promoted onto each card; the
 *      collapsible drawer keeps only the changelog.
 *   8. **runtime card** — amber, because a swap is not a plugin install.
 *   9. **已忽略 / 已是最新 / 版本说明** — collapsed by default: nothing that
 *      needs no action may sit above something that does.
 *  10. **footer** — the primary CTA plus its honest meta line, both reactive to
 *      every state (idle / installing / failed check / up to date).
 *
 * The job log is a drawer inside the panel (`.hqpu-log`), not an inline block:
 * a full set lists one row per component, which as inline content pushed every
 * actionable card below the fold.
 *
 * @module
 */
import {
  checkUpdates,
  ignoreOffer,
  ignorePlugin,
  installSet,
  requestRuntimeUpdate,
  runtimeLatestVersion,
  runtimeUpdateOffered,
  setPluginUpdateSource,
  setRuntimeUpdateSource,
  unignoreOffer,
  unignorePlugin,
  TERMINAL_PHASES,
  type PluginUpdateItem,
  type PluginUpdateReport,
  type ReleaseInfo,
  type RuntimeUpdateSource,
  type UpdateJob,
  type UpdateStep,
} from './api.js'
import { formatMb, type UpdateCopy } from './copy.js'
import { actionableUpdateCount } from './version.js'
import {
  BOLT_ICON,
  CHECK_CIRCLE_ICON,
  CHEVRON_RIGHT_ICON,
  CLOSE_ICON,
  COPY_ICON,
  EYE_OFF_ICON,
  LOG_ICON,
  REFRESH_ICON,
  WARNING_ICON,
} from './icons.js'

export interface UpdateStoreLike {
  report(): PluginUpdateReport | null
  installing(): boolean
  /** Mark the installing footer state (set by the panel before the restart). */
  setInstalling(flag: boolean): void
  /** The durable job the server currently reports as active (resumed). */
  activeJob(): UpdateJob | null
  /** Bounded recent jobs (newest first), for the log drawer. */
  recentJobs(): UpdateJob[]
  refresh(): Promise<PluginUpdateReport | null>
  /** Force a fresh update check (used by the failed-check Retry action). */
  check(): Promise<PluginUpdateReport | null>
  /** Re-read `/status` (resume an active job immediately after submitting). */
  fetchStatus(): Promise<void>
  /**
   * Follow a job by id after an accept response. Optional so a minimal store
   * (tests, older hosts) still satisfies the contract; the real store uses it
   * to keep asking about THIS job across a DSH restart.
   */
  watchJob?(id: string | null): void
  /** Server-reported "the active job stopped advancing". */
  stalled?(): boolean
  /** Milliseconds since the active job last advanced (server clock). */
  phaseAgeMs?(): number
  subscribe(listener: () => void): () => void
}

/** How long the outcome toast stays up, in milliseconds. */
const TOAST_HOLD_MS = 4000

/** Which manifest an editor belongs to — drives data attributes + CSS hook. */
export type SourceKind = 'runtime' | 'plugin'

// ── Small DOM helpers ──────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className.length > 0) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A button carrying inline SVG artwork (the icon modules emit markup). */
function iconButton(
  className: string,
  markup: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = el('button', className)
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.title = label
  button.innerHTML = markup
  button.addEventListener('click', onClick)
  return button
}

/** A text-link button (重新尝试, 展开版本日志, 忽略此版本 …). */
function linkButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', className, label)
  button.type = 'button'
  button.addEventListener('click', onClick)
  return button
}

/**
 * Compact a package name to what a person calls it — the shell plugin
 * manager's own rule (`presentation.ts` `shortName`), so both UIs read the
 * same plugin by the same name.
 */
export function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

/** Two-letter avatar initials for a card (CJK-safe). */
function avatarInitials(item: PluginUpdateItem): string {
  const src =
    typeof item.displayName === 'string' && item.displayName.trim().length > 0
      ? item.displayName.trim()
      : shortName(item.name)
  if (/[\u2E80-\u9FFF]/.test(src)) return src.slice(0, 2)
  const words = src.split(/[\s_\-./@]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return src.replace(/^@/, '').slice(0, 2).toUpperCase()
}

/** The name a card shows: the manifest's displayName, else the short name. */
function displayNameOf(item: PluginUpdateItem): string {
  return typeof item.displayName === 'string' && item.displayName.trim().length > 0
    ? item.displayName.trim()
    : shortName(item.name)
}

function isActionable(item: PluginUpdateItem): boolean {
  return item.state === 'update' || item.state === 'install'
}

// ── Time / size formatting ────────────────────────────────────────────────

/** Format a byte count for the progress line, or null when unknown. */
function formatBytes(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** "N 分钟前" — relative time from an ISO timestamp. */
function relativeAgo(iso: string | null | undefined, copy: UpdateCopy): string | null {
  if (typeof iso !== 'string' || iso.length === 0) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const diffMin = Math.round((Date.now() - then) / 60_000)
  if (diffMin < 1) return copy.ui.agoJust
  if (diffMin < 60) return copy.ui.agoMinutes(diffMin)
  const hours = Math.round(diffMin / 60)
  if (hours < 24) return copy.ui.agoHours(hours)
  return copy.ui.agoDays(Math.round(hours / 24))
}

/** Short absolute time for log rows: "10/29 14:34". */
function shortWhen(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.length === 0) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function jobKindLabel(job: UpdateJob, copy: UpdateCopy): string {
  return job.kind === 'runtime' ? copy.job.kindRuntime : copy.job.kindPluginSet
}

/** The phase in human words, falling back to the raw code. */
function phaseLabel(job: UpdateJob, copy: UpdateCopy): string {
  return copy.job.phase[job.phase] ?? job.phase
}

/** Map a job phase onto the 4-step indicator index (下载/校验/替换/重启). */
function stepIndex(phase: UpdateJob['phase']): number {
  switch (phase) {
    case 'downloading':
    case 'resolving':
      return 0
    case 'verifying':
      return 1
    case 'staging':
    case 'activating':
    case 'awaiting-host':
      return 2
    case 'restarting':
    case 'verifying-after-restart':
      return 3
    case 'queued':
    default:
      return -1
  }
}

// ── Section pieces ────────────────────────────────────────────────────────

/**
 * A collapsible section: chevron + title + count, an optional right-hand note,
 * and a body that only exists in the DOM while open.
 *
 * Native `<details>` was the alternative, but it cannot express the
 * "collapsed by default, opened by state" rule the 已是最新 group needs without
 * a JS patch anyway, and its summary cannot host the trailing note in one row.
 */
function disclosure(opts: {
  id: string
  title: string
  count?: string
  note?: string
  open: boolean
  onToggle: () => void
  build: () => HTMLElement[]
}): HTMLElement {
  const section = el('section', 'hqpu-disc')
  // The title doubles as the group hook (`[data-group="已是最新"]`), matching
  // the actionable group's convention so callers need one selector style.
  section.dataset.group = opts.title
  const head = el('button', 'hqpu-disc-head')
  head.type = 'button'
  head.setAttribute('aria-expanded', opts.open ? 'true' : 'false')
  head.setAttribute('aria-controls', opts.id)

  const left = el('span', 'hqpu-disc-left')
  const chevron = el('span', 'hqpu-disc-chevron')
  chevron.innerHTML = CHEVRON_RIGHT_ICON(12)
  left.append(chevron, el('span', 'hqpu-disc-title', opts.title))
  if (opts.count !== undefined) left.append(el('span', 'hqpu-disc-count', opts.count))
  head.append(left)
  if (opts.note !== undefined && opts.note.length > 0) {
    head.append(el('span', 'hqpu-disc-note', opts.note))
  }
  head.addEventListener('click', opts.onToggle)
  section.append(head)

  if (opts.open) {
    const body = el('div', 'hqpu-disc-body')
    body.id = opts.id
    for (const node of opts.build()) body.append(node)
    section.append(body)
  }
  return section
}

/** One muted row in a collapsed group (current or ignored plugin). */
function pluginRow(
  item: PluginUpdateItem,
  copy: UpdateCopy,
  onToggleIgnore: () => void,
): HTMLLIElement {
  const row = el('li', 'hqpu-row')
  row.dataset.pluginName = item.name
  row.dataset.state = item.state
  row.append(el('span', 'hqpu-row-name', displayNameOf(item)))
  const end = el('span', 'hqpu-row-end')
  const version = item.currentVersion ?? item.availableVersion
  end.append(el('span', 'hqpu-row-meta', copy.ui.upToDateRow(version)))
  if (item.state === 'ignored') {
    end.append(
      linkButton('hqpu-link hqpu-link--tiny', copy.unignore, onToggleIgnore),
    )
  }
  row.append(end)
  return row
}

/**
 * One actionable plugin card.
 *
 * Actions live on the card, not inside the changelog drawer: the drawer is for
 * content (what changed), and hiding 单独更新 / 忽略 behind a disclosure made
 * the set-level footer CTA the only discoverable action.
 */
function pluginCard(
  item: PluginUpdateItem,
  copy: UpdateCopy,
  opts: { changesOpen: boolean; onToggleChanges: () => void; onInstall: () => void; onIgnore: () => void; busy: boolean },
): HTMLLIElement {
  const card = el('li', 'hqpu-card')
  card.dataset.pluginName = item.name
  card.dataset.state = item.state

  const head = el('div', 'hqpu-card-head')
  const id = el('div', 'hqpu-card-id')
  const avatar = el('span', 'hqpu-avatar', avatarInitials(item))
  avatar.setAttribute('aria-hidden', 'true')
  const main = el('div', 'hqpu-card-main')
  main.append(el('span', 'hqpu-card-title', displayNameOf(item)))
  main.append(el('span', 'hqpu-card-sub', shortName(item.name)))
  id.append(avatar, main)

  const end = el('div', 'hqpu-card-end')
  const install = el(
    'button',
    'hqpu-card-action hqpu-card-action--install',
    item.state === 'install' ? copy.ui.singleInstall : copy.ui.singleUpdate,
  )
  install.type = 'button'
  install.title = copy.ui.singleUpdateTip
  install.disabled = opts.busy
  install.addEventListener('click', opts.onInstall)
  const ignore = iconButton(
    'hqpu-icon-btn hqpu-icon-btn--sm',
    EYE_OFF_ICON(14),
    copy.ui.ignorePlugin,
    opts.onIgnore,
  )
  ignore.disabled = opts.busy
  end.append(install, ignore)
  head.append(id, end)
  card.append(head)

  // Version row + the changelog toggle, on one line.
  const foot = el('div', 'hqpu-card-foot')
  const ver = el('div', 'hqpu-version-row')
  if (item.currentVersion !== null && item.currentVersion !== undefined) {
    ver.append(el('span', 'hqpu-ver-old', item.currentVersion))
    ver.append(el('span', 'hqpu-ver-arrow', '→'))
  }
  ver.append(el('span', 'hqpu-ver-new', item.availableVersion))
  const size = formatMb(item.sizeBytes ?? 0)
  if (size.length > 0) ver.append(el('span', 'hqpu-ver-size', `(${size})`))
  foot.append(ver)

  const changes = Array.isArray(item.changes)
    ? item.changes.filter((c) => typeof c === 'string' && c.length > 0)
    : []
  if (changes.length > 0) {
    const toggle = el('button', 'hqpu-toggle')
    toggle.type = 'button'
    toggle.dataset.changesToggle = ''
    toggle.dataset.open = opts.changesOpen ? 'true' : 'false'
    toggle.setAttribute('aria-expanded', opts.changesOpen ? 'true' : 'false')
    toggle.append(el('span', '', copy.ui.changesToggle))
    const chevron = el('span', 'hqpu-toggle-chevron')
    chevron.innerHTML = CHEVRON_RIGHT_ICON(12)
    toggle.append(chevron)
    toggle.addEventListener('click', opts.onToggleChanges)
    foot.append(toggle)
  }
  card.append(foot)

  if (changes.length > 0 && opts.changesOpen) {
    const drawer = el('div', 'hqpu-changes')
    drawer.append(el('p', 'hqpu-changes-title', copy.ui.changesTitle(item.availableVersion)))
    const ul = el('ul')
    for (const change of changes) ul.append(el('li', '', change))
    drawer.append(ul)
    card.append(drawer)
  }
  return card
}

/** The "what do I actually have to decide" band, above every list. */
function decisionBand(report: PluginUpdateReport, copy: UpdateCopy): HTMLElement | null {
  const plugins = actionableUpdateCount(report)
  const runtime = runtimeUpdateOffered(report.runtime)
  if (plugins === 0 && !runtime) return null
  const band = el('div', 'hqpu-decision')
  band.dataset.role = 'decision-band'
  if (plugins > 0) band.append(el('span', 'hqpu-decision-main', copy.ui.summaryPlugins(plugins)))
  if (plugins > 0 && runtime) {
    const dot = el('span', 'hqpu-decision-dot')
    dot.setAttribute('aria-hidden', 'true')
    band.append(dot)
  }
  if (runtime) band.append(el('span', 'hqpu-decision-sub', copy.ui.summaryRuntime))
  return band
}

/**
 * Check-status banner. A FAILED check is a red alert with its reason and a
 * retry — never the silent "no updates" empty state, which reads as success.
 */
function checkBanner(
  report: PluginUpdateReport,
  copy: UpdateCopy,
  onRetry: () => void,
): HTMLElement | null {
  const failed = typeof report.lastError === 'string' && report.lastError.length > 0
  if (!failed) return null
  const section = el('section', 'hqpu-group')
  section.dataset.group = 'check-status'
  const card = el('div', 'hqpu-error')
  card.dataset.tone = 'danger'
  const head = el('div', 'hqpu-error-head')
  const icon = el('span', 'hqpu-error-icon')
  icon.innerHTML = WARNING_ICON(14)
  const text = el('div', 'hqpu-error-text')
  text.append(el('p', 'hqpu-error-title', copy.checkFailedTitle))
  text.append(el('p', 'hqpu-error-body', report.lastError as string))
  head.append(icon, text)
  card.append(head)

  const foot = el('div', 'hqpu-error-foot')
  if (report.items.length > 0) foot.append(el('span', '', copy.staleNote))
  foot.append(linkButton('hqpu-link', copy.retryNow, onRetry))
  card.append(foot)
  section.append(card)
  return section
}

/**
 * The active job card: title (with the target version) + percent, a
 * determinate bar when the server publishes one, phase + telemetry, the honest
 * "closing does not cancel" note, and the 4-step pipeline.
 *
 * `stalled` marks a job the server has stopped advancing. That is the normal
 * shape of "the set being installed contains this very plugin": activating it
 * restarts DSH, so the process that owned the job is gone and the last thing
 * the page saw was 100 % on the final step. Instead of animating a bar that
 * will never move, the card says it is confirming the outcome and offers a
 * retry — and the next `/activity` read settles it from the installed set.
 */
function activeJobView(
  job: UpdateJob,
  copy: UpdateCopy,
  opts: { stalled?: boolean; onRecheck?: () => void } = {},
): HTMLElement {
  const section = el('section', 'hqpu-group')
  section.dataset.group = 'active-job'
  const card = el('div', 'hqpu-active')
  if (opts.stalled === true) card.dataset.stalled = '1'

  const top = el('div', 'hqpu-active-top')
  const titleWrap = el('div', 'hqpu-active-title')
  const pulse = el('span', 'hqpu-pulse-dot')
  pulse.append(el('span', 'hqpu-pulse-ring'))
  const title =
    job.kind === 'runtime'
      ? copy.ui.jobRuntimeTitle(job.targetVersion)
      : copy.ui.jobPluginTitle(job.targetVersion)
  titleWrap.append(pulse, el('span', 'hqpu-active-label', title))
  top.append(titleWrap)
  const pct = job.progress.percent
  if (pct !== null) top.append(el('span', 'hqpu-active-percent', `${Math.round(pct)}%`))
  card.append(top)

  if (pct !== null) {
    const bar = el('div', 'hqpu-progress')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    bar.setAttribute('aria-valuenow', String(Math.round(pct)))
    const fill = el('div', 'hqpu-progress-fill')
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`
    bar.append(fill)
    card.append(bar)
  }

  const meta = el('div', 'hqpu-active-meta')
  const phaseText =
    typeof job.message === 'string' && job.message.length > 0 ? job.message : phaseLabel(job, copy)
  meta.append(el('span', '', phaseText))
  const speed = formatBytes(job.progress.bytesPerSecond)
  const done = formatBytes(job.progress.bytesDone)
  const total = formatBytes(job.progress.bytesTotal)
  const telemetry =
    speed !== null && done !== null && total !== null
      ? `${speed}/s (${done} / ${total})`
      : speed !== null
        ? `${speed}/s`
        : done !== null && total !== null
          ? copy.job.bytes(done, total)
          : ''
  if (telemetry.length > 0) meta.append(el('span', 'hqpu-num', telemetry))
  card.append(meta)

  // previous → target on its own line (mono), then what happens next. A
  // plugin set keeps the "closing does not cancel" note; a runtime swap has a
  // stronger one of its own (HQ Edge exits, the host swaps it out).
  card.append(
    el(
      'div',
      'hqpu-active-versions',
      job.previousVersion !== null && job.previousVersion.length > 0
        ? `${job.previousVersion} → ${job.targetVersion}`
        : job.targetVersion,
    ),
  )
  card.append(
    el(
      'p',
      'hqpu-active-note',
      job.kind === 'runtime' ? copy.job.willSwapRuntime : copy.ui.activeCloseNote,
    ),
  )

  if (opts.stalled === true) {
    const stalled = el('div', 'hqpu-active-stalled')
    stalled.append(el('span', '', copy.ui.stalledNote))
    const recheck = linkButton('hqpu-link', copy.ui.stalledAction, () => opts.onRecheck?.())
    recheck.setAttribute('data-stalled-recheck', '')
    stalled.append(recheck)
    card.append(stalled)
  }

  const current = stepIndex(job.phase)
  const stepsRow = el('div', 'hqpu-job-steps4')
  copy.ui.jobSteps.forEach((label: string, index: number) => {
    const cls =
      current === -1
        ? 'hqpu-job-step--todo'
        : index < current
          ? 'hqpu-job-step--done'
          : index === current
            ? 'hqpu-job-step--active'
            : 'hqpu-job-step--todo'
    // Numbered like the prototype's pipeline ("1. 下载"): the count is the
    // only cue for how much is left when the active step blinks.
    stepsRow.append(el('div', cls, `${index + 1}. ${label}`))
  })
  card.append(stepsRow)

  section.append(card)
  return section
}

/** Phase → the word the log rows use for a component. */
function stepWord(state: UpdateStep['state'], copy: UpdateCopy): string {
  switch (state) {
    case 'installed':
      return copy.job.phase.done ?? ''
    case 'skipped':
      return copy.ui.stepSkipped
    case 'failed':
      return copy.job.phase.failed ?? ''
    case 'running':
      return copy.job.phase.downloading ?? ''
    default:
      return copy.ui.stepPending
  }
}

/** Dot tone for one step row. */
function stepDotState(state: UpdateStep['state']): string {
  switch (state) {
    case 'installed':
      return 'done'
    case 'failed':
      return 'error'
    case 'running':
      return 'warning'
    default:
      return 'idle'
  }
}

/**
 * The terminal-result banner for a job that did NOT succeed.
 *
 * A successful install needs no banner — the list and the footer already say
 * "everything is current". A failure does: the error code and the retry must be
 * on screen, not one drawer-click away.
 */
function jobResultBanner(
  job: UpdateJob,
  copy: UpdateCopy,
  onRetry: () => void,
  onOpenLog: () => void,
): HTMLElement {
  const section = el('section', 'hqpu-group')
  section.dataset.group = 'job-result'
  const tone = job.phase === 'failed' ? 'danger' : 'warning'
  const card = el('div', 'hqpu-error')
  card.dataset.tone = tone

  const head = el('div', 'hqpu-error-head')
  const icon = el('span', 'hqpu-error-icon')
  icon.innerHTML = WARNING_ICON(14)
  const text = el('div', 'hqpu-error-text')
  const title =
    job.phase === 'rolled-back' ? copy.job.resultRolledBack : copy.job.resultFailed
  text.append(el('p', 'hqpu-error-title', title))
  const res = job.result
  const from = job.previousVersion ?? res?.installedVersion ?? '—'
  const to = res?.installedVersion ?? job.targetVersion
  const when = res !== undefined && res.finishedAt.length > 0 ? ` · ${shortWhen(res.finishedAt)}` : ''
  text.append(el('p', 'hqpu-error-body', `${from} → ${to}${when}`))
  if (res?.message !== undefined && res.message.length > 0) {
    text.append(el('p', 'hqpu-error-body', res.message))
  }
  if (res?.errorCode !== undefined && res.errorCode.length > 0) {
    text.append(el('code', 'hqpu-error-code', res.errorCode))
  }
  head.append(icon, text)
  card.append(head)

  const foot = el('div', 'hqpu-error-foot')
  foot.append(el('span', '', jobKindLabel(job, copy)))
  const actions = el('span', 'hqpu-error-actions')
  actions.append(linkButton('hqpu-link', copy.ui.viewLog, onOpenLog))
  actions.append(linkButton('hqpu-link', copy.job.retry, onRetry))
  foot.append(actions)
  card.append(foot)
  section.append(card)
  return section
}

/**
 * The host's own report of the last runtime swap. Rolled-back / failed renders
 * as an AMBER alert card; succeeded renders as a quiet green line. The plugin
 * has no log-open affordance for this, so none is invented.
 */
function runtimeResultAlert(
  report: PluginUpdateReport,
  copy: UpdateCopy,
  dismissed: boolean,
  onDismiss: () => void,
): HTMLElement | null {
  const lastResult = report.runtime.lastResult
  if (lastResult === null || lastResult === undefined) return null

  if (lastResult.state === 'succeeded') {
    const line = el('p', 'hqpu-alert-green')
    line.dataset.role = 'runtime-success'
    line.textContent = copy.ui.successInline
    return line
  }
  if (dismissed) return null

  const section = el('section', 'hqpu-group')
  section.dataset.group = 'runtime-alert'
  const card = el('div', 'hqpu-alert hqpu-alert--amber')
  const icon = el('span', 'hqpu-alert-icon')
  icon.innerHTML = WARNING_ICON(14)
  card.append(icon)

  const body = el('div', 'hqpu-alert-main')
  body.append(
    el(
      'div',
      'hqpu-alert-title',
      lastResult.state === 'failed' ? copy.ui.failedTitle : copy.ui.rollbackTitle,
    ),
  )
  const oldVer = lastResult.installedVersion ?? lastResult.targetVersion ?? '—'
  const bodyP = el('p', 'hqpu-alert-body')
  bodyP.append(
    document.createTextNode(
      lastResult.state === 'failed'
        ? copy.ui.failedBody(oldVer, '')
        : copy.ui.rollbackBody(oldVer, ''),
    ),
  )
  if (typeof lastResult.errorCode === 'string' && lastResult.errorCode.length > 0) {
    bodyP.append(el('code', '', lastResult.errorCode))
  }
  if (typeof lastResult.message === 'string' && lastResult.message.length > 0) {
    bodyP.append(el('br'), document.createTextNode(lastResult.message))
  }
  body.append(bodyP)
  const actions = el('div', 'hqpu-alert-actions')
  actions.append(linkButton('hqpu-alert-dismiss', copy.ui.dismiss, onDismiss))
  body.append(actions)
  card.append(body)
  section.append(card)
  return section
}

/**
 * The HQ Edge runtime card: current chip, the offered version with its size and
 * summary, and the 升级核心 action — arm → confirm, because a runtime swap
 * shuts HQ Edge down and is not undoable from here.
 */
function runtimeEngineCard(
  report: PluginUpdateReport,
  copy: UpdateCopy,
  actions: RuntimeActions,
): HTMLElement | null {
  const runtime = report.runtime
  const latestVersion = runtimeLatestVersion(runtime)
  const card = el('section', 'hqpu-engine')
  card.dataset.group = 'runtime'

  const head = el('div', 'hqpu-engine-head')
  const titleWrap = el('div', 'hqpu-engine-title')
  const bolt = el('span', 'hqpu-engine-bolt')
  bolt.innerHTML = BOLT_ICON(14)
  titleWrap.append(bolt, el('span', '', copy.ui.runtimeEngine))
  head.append(titleWrap)
  if (typeof runtime.currentVersion === 'string' && runtime.currentVersion.length > 0) {
    head.append(el('span', 'hqpu-chip', copy.ui.currentChip(runtime.currentVersion)))
  }
  card.append(head)

  const offered = runtime.updateAvailable && latestVersion !== null
  if (!offered && typeof runtime.lastError === 'string' && runtime.lastError.length > 0) {
    card.append(el('p', 'hqpu-engine-error', `${copy.lastError}: ${runtime.lastError}`))
    return card
  }
  if (!offered) return card

  const latestEntry = runtime.latest
  const row = el('div', 'hqpu-engine-row')
  const info = el('div', 'hqpu-engine-info')
  const newLine = el('div', 'hqpu-engine-new')
  newLine.append(el('span', 'hqpu-ver-new hqpu-ver-new--lg', copy.ui.newVersion(latestVersion as string)))
  const hasCritical =
    (Array.isArray(latestEntry?.breaking) && (latestEntry?.breaking?.length ?? 0) > 0) ||
    (Array.isArray(latestEntry?.notes) && (latestEntry?.notes?.length ?? 0) > 0)
  if (hasCritical) newLine.append(el('span', 'hqpu-tag--brand', copy.ui.breakingTag))
  info.append(newLine)
  const size = typeof latestEntry?.sizeBytes === 'number' ? formatMb(latestEntry.sizeBytes) : ''
  const summary = typeof latestEntry?.summary === 'string' ? latestEntry.summary : ''
  if (size.length > 0 || summary.length > 0) {
    info.append(el('p', 'hqpu-engine-size', copy.ui.sizeLine(size, summary)))
  }
  row.append(info)

  if (actions.accepted) {
    row.append(el('span', 'hqpu-engine-state', copy.runtime.updateAccepted))
  } else if (actions.busy) {
    row.append(el('span', 'hqpu-engine-state', copy.runtime.updating))
  } else if (!actions.armed) {
    const start = el('button', 'hqpu-btn--engine', copy.ui.upgradeCore)
    start.type = 'button'
    start.dataset.runtimeUpdate = ''
    start.addEventListener('click', actions.onArm)
    row.append(start)
  }
  card.append(row)

  // Confirm replaces the action: a full-width block, never a 150 px column.
  if (actions.armed && !actions.busy && !actions.accepted) {
    const confirm = el('div', 'hqpu-engine-confirm')
    confirm.append(
      el('p', 'hqpu-engine-confirm-text', copy.runtime.updateConfirm(latestVersion as string)),
    )
    const buttons = el('div', 'hqpu-engine-confirm-actions')
    const no = el('button', 'hqpu-btn hqpu-btn--ghost hqpu-btn--sm', copy.cancel)
    no.type = 'button'
    no.addEventListener('click', actions.onCancel)
    const yes = el('button', 'hqpu-btn--engine hqpu-btn--engine-solid', copy.ui.confirmRuntime)
    yes.type = 'button'
    yes.dataset.runtimeConfirm = ''
    yes.addEventListener('click', actions.onConfirm)
    buttons.append(no, yes)
    confirm.append(buttons)
    card.append(confirm)
  }

  const note = el('p', 'hqpu-engine-note')
  note.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2L14.4 13.4H1.6L8 2Z"/><path d="M8 6.4V9.2"/><path d="M8 10.6V11.6"/></svg>`
  note.append(el('span', '', copy.ui.runtimeRestartNote))
  card.append(note)
  return card
}

/** Set-level release metadata (v2 manifest): summary, notes, breaking, link. */
function releaseBody(release: ReleaseInfo, copy: UpdateCopy): HTMLElement[] {
  const out: HTMLElement[] = []
  const notes = Array.isArray(release.notes)
    ? release.notes.filter((n) => typeof n === 'string' && n.length > 0)
    : []
  const breaking = Array.isArray(release.breaking)
    ? release.breaking.filter((n) => typeof n === 'string' && n.length > 0)
    : []
  if (typeof release.summary === 'string' && release.summary.length > 0) {
    out.push(el('p', 'hqpu-release-summary', release.summary))
  }
  if (notes.length > 0) {
    const ul = el('ul', 'hqpu-release-notes')
    for (const note of notes) ul.append(el('li', '', note as string))
    out.push(ul)
  }
  if (breaking.length > 0) {
    const banner = el('div', 'hqpu-banner')
    banner.dataset.tone = 'danger'
    const icon = el('span')
    icon.innerHTML = WARNING_ICON(14)
    banner.append(icon)
    const inner = el('span')
    inner.append(el('strong', '', `${copy.release.breakingTitle}: `))
    inner.append(document.createTextNode(breaking.join(' · ')))
    banner.append(inner)
    out.push(banner)
  }
  if (typeof release.publishedAt === 'string' && release.publishedAt.length > 0) {
    out.push(
      el('p', 'hqpu-release-meta', copy.release.publishedAt(new Date(release.publishedAt).toLocaleString())),
    )
  }
  if (release.requiresRestart === true) {
    out.push(el('p', 'hqpu-release-meta', copy.job.willRestartDsh))
  }
  if (typeof release.notesUrl === 'string' && release.notesUrl.length > 0) {
    const link = el('a', 'hqpu-release-link', copy.release.notesLink)
    link.href = release.notesUrl
    link.target = '_blank'
    link.rel = 'noreferrer'
    out.push(link)
  }
  return out
}

function hasReleaseContent(release: ReleaseInfo | null | undefined): boolean {
  if (release === null || release === undefined) return false
  return (
    (typeof release.summary === 'string' && release.summary.length > 0) ||
    (Array.isArray(release.notes) && release.notes.length > 0) ||
    (Array.isArray(release.breaking) && release.breaking.length > 0) ||
    typeof release.notesUrl === 'string' ||
    typeof release.publishedAt === 'string'
  )
}

/**
 * The job log drawer: title + outcome tag, the mono component list with a
 * JOB_ID header, the result detail, older runs, and 复制日志 ID / 关闭.
 */
function buildLogDrawer(
  job: UpdateJob,
  recent: UpdateJob[],
  copy: UpdateCopy,
  onCopy: (id: string) => void,
  onClose: () => void,
): HTMLElement[] {
  const out: HTMLElement[] = []

  const head = el('div', 'hqpu-log-head')
  const titleWrap = el('div', 'hqpu-log-title')
  titleWrap.append(el('span', 'hqpu-log-name', copy.ui.logTitle))
  const tag = el('span', 'hqpu-tag')
  tag.dataset.tone =
    job.phase === 'done' ? 'success' : job.phase === 'failed' ? 'danger' : 'warning'
  tag.textContent =
    job.phase === 'done'
      ? copy.job.resultDone
      : job.phase === 'failed'
        ? copy.job.resultFailed
        : job.phase === 'rolled-back'
          ? copy.job.resultRolledBack
          : copy.job.resultAbandoned
  titleWrap.append(tag)
  const closeBtn = iconButton('hqpu-icon-btn hqpu-icon-btn--sm', CLOSE_ICON(14), copy.close, onClose)
  head.append(titleWrap, closeBtn)
  out.push(head)

  const body = el('div', 'hqpu-log-body')
  const block = el('div', 'hqpu-log-block')
  const meta = el('div', 'hqpu-log-meta')
  const logId = job.logHint !== undefined && job.logHint.length > 0 ? job.logHint : job.id
  meta.append(el('span', '', `${copy.ui.jobIdLabel}: ${logId}`))
  meta.append(el('span', '', shortWhen(job.result?.finishedAt ?? job.updatedAt)))
  block.append(meta)

  const steps = Array.isArray(job.steps) ? job.steps : []
  if (steps.length > 0) {
    for (const step of steps) {
      const line = el('div', 'hqpu-log-line')
      const dot = el('span', 'hqpu-log-dot')
      dot.dataset.state = stepDotState(step.state)
      line.append(dot)
      const word = stepWord(step.state, copy)
      const text =
        step.message !== undefined && step.message.length > 0
          ? `${step.name} — ${step.message}`
          : step.name
      line.append(el('span', 'hqpu-log-line-text', word.length > 0 ? `${text} (${word})` : text))
      block.append(line)
    }
  } else {
    block.append(el('div', 'hqpu-log-line hqpu-log-line--empty', copy.job.stepsTitle))
  }
  body.append(block)

  // Result detail: the transition, the error code, the server's own message.
  const res = job.result
  const from = job.previousVersion ?? res?.installedVersion ?? '—'
  const to = res?.installedVersion ?? job.targetVersion
  const detail = el('div', 'hqpu-log-detail')
  detail.append(el('p', '', `${from} → ${to}`))
  if (res?.errorCode !== undefined && res.errorCode.length > 0) {
    detail.append(el('code', 'hqpu-error-code', res.errorCode))
  }
  if (res?.message !== undefined && res.message.length > 0) {
    detail.append(el('p', '', res.message))
  }
  body.append(detail)

  const older = recent.filter((entry) => entry.id !== job.id).slice(0, 4)
  if (older.length > 0) {
    const list = el('div', 'hqpu-log-recent')
    list.append(el('p', 'hqpu-log-recent-title', copy.job.recentTitle))
    for (const entry of older) {
      const row = el('div', 'hqpu-log-recent-row')
      row.append(el('span', '', `${jobKindLabel(entry, copy)} ${entry.targetVersion}`))
      row.append(el('span', 'hqpu-log-recent-meta', `${phaseLabel(entry, copy)} · ${shortWhen(entry.updatedAt)}`))
      list.append(row)
    }
    body.append(list)
  }
  out.push(body)

  const foot = el('div', 'hqpu-log-foot')
  const copyBtn = el('button', 'hqpu-link hqpu-link--icon')
  copyBtn.type = 'button'
  copyBtn.dataset.copyLog = ''
  const copyIcon = el('span')
  copyIcon.innerHTML = COPY_ICON(12)
  copyBtn.append(copyIcon, el('span', '', copy.ui.copyLogId))
  copyBtn.addEventListener('click', () => onCopy(logId))
  const closeFoot = el('button', 'hqpu-btn hqpu-btn--sm', copy.close)
  closeFoot.type = 'button'
  closeFoot.addEventListener('click', onClose)
  foot.append(copyBtn, closeFoot)
  out.push(foot)

  return out
}

// ── The runtime action contract ────────────────────────────────────────────

/**
 * The runtime-update action row's state and callbacks.
 *
 * Installing the runtime is destructive in a way a plugin install is not:
 * hq-edge shuts itself down so the EDA host can swap the runtime directory. So
 * the row is a two-step confirm (arm → confirm), never a single click.
 */
export interface RuntimeActions {
  /** A request is in flight (hq-edge accepted it and is restarting). */
  busy: boolean
  /** The confirm step is armed for the version the row names. */
  armed: boolean
  /**
   * hq-edge answered `202 Accepted`: from here on the outcome belongs to the
   * EDA host, and this process is about to be replaced. Terminal — the row
   * must never re-offer the button once this is true.
   */
  accepted: boolean
  onArm(): void
  onConfirm(): void
  onCancel(): void
}

/**
 * Normalize a report's source field to the full shape.
 *
 * An older hq-edge predates the feature and sends no `source` at all — that
 * must degrade to no editor, not crash the render. A future server may add
 * fields; unknown extras are dropped here rather than trusted.
 */
function normalizeSource(raw: unknown): RuntimeUpdateSource | null {
  if (raw === null || typeof raw !== 'object') return null
  const candidate = raw as Partial<RuntimeUpdateSource>
  if (typeof candidate.origin !== 'string') return null
  return {
    url: typeof candidate.url === 'string' ? candidate.url : '',
    origin: candidate.origin as RuntimeUpdateSource['origin'],
    configuredUrl: typeof candidate.configuredUrl === 'string' ? candidate.configuredUrl : '',
    override: candidate.override === true,
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────

/** The single live toast; a new message replaces the one on screen. */
let toastHost: HTMLElement | null = null
let toastTimer: number | null = null
/** Copy for the toast's close affordance; set when the panel mounts. */
let activeCopy: UpdateCopy | null = null

function showToast(message: string, tone: 'success' | 'error'): void {
  if (toastHost === null) return
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  toastHost.textContent = ''
  const toast = el('div', 'hqpu-toast')
  // An error must interrupt; a success may wait for a pause.
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  const icon = el('span', 'hqpu-toast-icon')
  icon.dataset.tone = tone
  icon.innerHTML = tone === 'success' ? CHECK_CIRCLE_ICON(16) : WARNING_ICON(16)
  toast.append(icon, el('span', 'hqpu-toast-text', message))
  const close = iconButton(
    'hqpu-toast-close',
    CLOSE_ICON(12),
    activeCopy?.close ?? 'Close',
    () => {
      toastHost?.replaceChildren()
      if (toastTimer !== null) window.clearTimeout(toastTimer)
      toastTimer = null
    },
  )
  toast.append(close)
  toastHost.append(toast)
  toastTimer = window.setTimeout(() => {
    toastHost?.replaceChildren()
    toastTimer = null
  }, TOAST_HOLD_MS)
}

// ── Panel ─────────────────────────────────────────────────────────────────

/**
 * Open (or focus) the update panel. Re-renders from the store; when the store
 * is stale the panel first refreshes the report.
 */
export function openUpdateView(store: UpdateStoreLike, copy: UpdateCopy): void {
  const existing = document.querySelector<HTMLElement>('[data-hq-plugin-update-view]')
  if (existing !== null) {
    existing.style.display = ''
    return
  }

  const previouslyFocused = document.activeElement as HTMLElement | null

  const overlay = el('div', 'hqpu-overlay')
  overlay.setAttribute('data-hq-plugin-update-view', '')
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) onClose()
  })

  const scrim = el('div', 'hqpu-scrim')
  const panel = el('div', 'hqpu-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', copy.ui.title)
  panel.tabIndex = -1

  // ── Header ──
  const head = el('header', 'hqpu-head')
  const headMain = el('div', 'hqpu-head-main')
  const brandIcon = el('span', 'hqpu-brand-icon')
  brandIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.8 8.6A5.8 5.8 0 012.2 6.4"/><path d="M13.8 4.4V8.6H9.6"/><path d="M2.2 7.4A5.8 5.8 0 0113.8 9.6"/><path d="M2.2 11.6V7.4H6.4"/></svg>`
  const titleBlock = el('div', 'hqpu-title-block')
  titleBlock.append(el('h1', 'hqpu-title', copy.ui.title))
  const sub = el('p', 'hqpu-sub')
  titleBlock.append(sub)
  headMain.append(brandIcon, titleBlock)

  const toolbar = el('div', 'hqpu-toolbar')
  const refreshBtn = iconButton('hqpu-icon-btn', REFRESH_ICON(15), copy.refresh, () => {
    void store.check()
  })
  const gearBtn = iconButton(
    'hqpu-icon-btn',
    `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M13.5 9.2v-2.4l-1.8-.6a4.4 4.4 0 00-.5-1.2l.9-1.7-1.7-1.7-1.7.9a4.4 4.4 0 00-1.2-.5L7.2 2.5H4.8l-.6 1.8a4.4 4.4 0 00-1.2.5l-1.7-.9-1.7 1.7.9 1.7a4.4 4.4 0 00-.5 1.2L2.5 7.2v2.4l1.8.6a4.4 4.4 0 00.5 1.2l-.9 1.7 1.7 1.7 1.7-.9a4.4 4.4 0 001.2.5l.6 1.8h2.4l.6-1.8a4.4 4.4 0 001.2-.5l1.7.9 1.7-1.7-.9-1.7a4.4 4.4 0 00.5-1.2l1.8-.6z"/></svg>`,
    copy.ui.gearTooltip,
    () => {
      toggleSettings()
    },
  )
  gearBtn.dataset.settingsToggle = ''
  gearBtn.setAttribute('aria-pressed', 'false')
  const logBtn = iconButton('hqpu-icon-btn', LOG_ICON(15), copy.ui.logShow, () => {
    toggleLog()
  })
  logBtn.dataset.logToggle = ''
  logBtn.setAttribute('aria-pressed', 'false')
  const closeBtn = iconButton('hqpu-icon-btn hqpu-icon-btn--close', CLOSE_ICON(15), copy.close, () => {
    onClose()
  })
  toolbar.append(refreshBtn, gearBtn, logBtn, closeBtn)
  head.append(headMain, toolbar)
  panel.append(head)

  // ── Settings strip (gear-toggled, above the body so it never shrinks it) ──
  const settingsEl = el('div', 'hqpu-settings')
  settingsEl.hidden = true
  panel.append(settingsEl)

  // ── Body + footer + log drawer share one positioned box, so the drawer can
  //    cover the body without covering the header ──
  const main = el('div', 'hqpu-main')
  const scroll = el('div', 'hqpu-scroll')
  const column = el('div', 'hqpu-column')
  const jobSection = el('div', 'hqpu-stack')
  const bannerSection = el('div', 'hqpu-stack')
  const bandSection = el('div', 'hqpu-stack')
  const listSection = el('div', 'hqpu-stack')
  const extraSection = el('div', 'hqpu-stack')
  column.append(jobSection, bannerSection, bandSection, listSection, extraSection)
  scroll.append(column)

  const footer = el('footer', 'hqpu-footer')
  const cta = el('button', 'hqpu-btn--block')
  cta.type = 'button'
  const ctaSpinner = el('span', 'hqpu-cta-spinner')
  ctaSpinner.hidden = true
  const ctaLabel = el('span', 'hqpu-cta-label')
  cta.append(ctaSpinner, ctaLabel)
  const footMeta = el('div', 'hqpu-foot-meta')
  const footCount = el('span', '')
  const ignoreBtn = el('button', 'hqpu-link')
  ignoreBtn.type = 'button'
  footMeta.append(footCount, ignoreBtn)
  footer.append(cta, footMeta, el('p', 'hqpu-footnote', copy.ui.footnote))

  const logDrawer = el('div', 'hqpu-log')
  logDrawer.dataset.logDrawer = ''
  logDrawer.hidden = true

  const toastSection = el('div', 'hqpu-toast-host')
  main.append(scroll, footer, logDrawer, toastSection)
  panel.append(main)

  overlay.append(scrim, panel)
  document.body.appendChild(overlay)
  toastHost = toastSection
  activeCopy = copy
  panel.focus()

  const disposers: Array<() => void> = []

  // ── Panel-closure UI state (survives store refreshes) ──
  let runtimeArmed = false
  let runtimeBusy = false
  let runtimeAccepted = false
  let settingsOpen = false
  let settingsBuilt = false
  let logOpen = false
  let dismissedAlert = false
  let changesAllOpen = false
  const changesOpen = new Set<string>()
  let upToDateOpen = false
  let ignoredOpen = false
  let releaseOpen = false
  let saving = false
  let pluginDraft = ''
  let runtimeDraft = ''

  const runtimeActions: RuntimeActions = {
    get busy() {
      return runtimeBusy
    },
    get armed() {
      return runtimeArmed
    },
    get accepted() {
      return runtimeAccepted
    },
    onArm: () => {
      runtimeArmed = true
      render()
    },
    onCancel: () => {
      runtimeArmed = false
      render()
    },
    onConfirm: () => {
      void requestRuntime()
    },
  }

  /** Fill both drafts from the report's URLs in effect. */
  function syncDrafts(): void {
    const report = store.report()
    pluginDraft = normalizeSource(report?.pluginSource)?.url ?? ''
    runtimeDraft = normalizeSource(report?.runtime.source)?.url ?? ''
  }

  function toggleSettings(): void {
    settingsOpen = !settingsOpen
    if (settingsOpen) {
      syncDrafts()
      settingsBuilt = false
    }
    render()
  }

  /**
   * Save both manifest sources, then re-run discovery and close the strip.
   *
   * The re-check is not optional: the report is cached, so without a fresh
   * `POST /check` the list would keep naming the OLD manifest's offer after the
   * source changed. hq-edge answers 422 with a message meant for a person on
   * refusal (bad scheme, credentials, …), which the toast shows verbatim —
   * and the strip stays open with the draft intact so it can be fixed.
   */
  async function saveSources(): Promise<void> {
    const report = store.report()
    const pluginSource = normalizeSource(report?.pluginSource)
    const runtimeSource = normalizeSource(report?.runtime.source)
    saving = true
    settingsBuilt = false
    render()
    try {
      const calls: Array<Promise<unknown>> = []
      if (pluginSource !== null && pluginDraft !== pluginSource.url) {
        calls.push(setPluginUpdateSource(pluginDraft))
      }
      if (runtimeSource !== null && runtimeDraft !== runtimeSource.url) {
        calls.push(setRuntimeUpdateSource(runtimeDraft))
      }
      await Promise.all(calls)
      settingsOpen = false
      showToast(copy.pluginSource.saved, 'success')
      try {
        await checkUpdates()
        await store.refresh()
      } catch {
        // The source IS saved; a failed re-check only leaves the previous
        // offer on screen until the next refresh — the toolbar re-runs it.
      }
    } catch (err: unknown) {
      showToast(
        `${copy.pluginSource.saveFailed}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      saving = false
      settingsBuilt = false
      render()
    }
  }

  /** Clear one user override so the configured URL applies again. */
  async function resetSource(kind: SourceKind): Promise<void> {
    saving = true
    settingsBuilt = false
    render()
    try {
      if (kind === 'runtime') await setRuntimeUpdateSource('')
      else await setPluginUpdateSource('')
      showToast(kind === 'runtime' ? copy.runtime.saved : copy.pluginSource.saved, 'success')
      try {
        await checkUpdates()
        await store.refresh()
      } catch {
        /* saved anyway */
      }
      syncDrafts()
    } catch (err: unknown) {
      showToast(
        `${copy.pluginSource.saveFailed}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      saving = false
      settingsBuilt = false
      render()
    }
  }

  async function requestRuntime(): Promise<void> {
    const version = runtimeLatestVersion(store.report()?.runtime)
    if (version === null) {
      showToast(copy.checkFailed, 'error')
      return
    }
    runtimeArmed = false
    runtimeBusy = true
    render()
    try {
      const result = await requestRuntimeUpdate(version)
      if (result?.error !== undefined) {
        showToast(`${copy.installError}: ${result.error}`, 'error')
        return
      }
      // 202 Accepted: hq-edge exits to let the EDA host swap the runtime and
      // relaunch. Latch it, so a store refresh cannot re-offer the button for
      // a server that is already gone.
      runtimeAccepted = true
      // The runtime swap restarts HQ Edge itself; follow the job it accepted so
      // the panel can report the outcome after the runtime is back.
      store.watchJob?.(result.jobId ?? null)
      showToast(copy.runtime.updateAccepted, 'success')
      void store.fetchStatus()
    } catch (err: unknown) {
      showToast(
        `${copy.installError}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      runtimeBusy = false
      render()
    }
  }

  /** Retry a failed/abandoned job: plugin-set → a fresh install; runtime →
   *  re-arm the runtime confirm flow. Always a NEW job, never re-clicking the
   *  settled job id. */
  function retryJob(kind: 'plugin-set' | 'runtime'): void {
    if (kind === 'runtime') {
      runtimeArmed = true
      render()
    } else {
      void runInstall(store, copy)
    }
  }

  /** The newest settled job — what the log drawer is about. */
  function settledJob(): UpdateJob | null {
    const latest = store.recentJobs()[0]
    return latest !== undefined && TERMINAL_PHASES.has(latest.phase) ? latest : null
  }

  function toggleLog(): void {
    logOpen = !logOpen
    render()
  }

  async function copyLogId(id: string): Promise<void> {
    try {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) throw new Error('clipboard unavailable')
      await clipboard.writeText(id)
      showToast(copy.ui.logCopied, 'success')
    } catch {
      showToast(copy.ui.logCopyFailed, 'error')
    }
  }

  // ── Section renderers ──

  function renderSettings(): void {
    if (!settingsOpen) {
      settingsEl.hidden = true
      settingsEl.textContent = ''
      return
    }
    settingsEl.hidden = false
    // Rebuilding on every store emit would blow away the caret of whoever is
    // typing, so the DOM is built once per open (or per explicit force).
    if (settingsBuilt) return
    settingsBuilt = true
    settingsEl.textContent = ''

    const report = store.report()
    const pluginSource = normalizeSource(report?.pluginSource)
    const runtimeSource = normalizeSource(report?.runtime.source)

    const row = el('div', 'hqpu-settings-row')
    row.append(el('span', 'hqpu-settings-title', copy.ui.settingsTitle))
    const overridden = (pluginSource?.override ?? false) || (runtimeSource?.override ?? false)
    const badge = el('span', 'hqpu-origin-badge', overridden ? copy.ui.originCustom : copy.ui.originDefault)
    badge.dataset.origin = overridden ? 'override' : 'config'
    row.append(badge)
    settingsEl.append(row)

    const field = (
      kind: SourceKind,
      source: RuntimeUpdateSource | null,
      label: string,
      ariaLabel: string,
      placeholder: string,
      draft: string,
      onDraft: (value: string) => void,
    ): void => {
      if (source === null) return
      const wrap = el('div', 'hqpu-field')
      const labelRow = el('div', 'hqpu-field-head')
      const id = `hqpu-source-${kind}`
      const labelEl = el('label', '', label)
      labelEl.htmlFor = id
      labelRow.append(labelEl)
      if (source.override) {
        const reset = linkButton('hqpu-link hqpu-link--tiny', copy.ui.resetSource, () => {
          void resetSource(kind)
        })
        reset.setAttribute(`data-${kind}-source-reset`, '')
        labelRow.append(reset)
      }
      wrap.append(labelRow)
      const input = el('input', 'hqpu-source-input')
      input.id = id
      input.type = 'url'
      input.value = draft
      input.placeholder = placeholder
      input.setAttribute('aria-label', ariaLabel)
      input.setAttribute(`data-${kind}-source-input`, '')
      input.disabled = saving
      input.spellcheck = false
      input.addEventListener('input', () => {
        // Draft-only: no re-render, so the caret and IME stay untouched.
        onDraft(input.value)
      })
      // Enter saves both; Escape closes the strip without saving.
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          void saveSources()
        } else if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          settingsOpen = false
          syncDrafts()
          render()
        }
      })
      wrap.append(input)
      settingsEl.append(wrap)
    }

    field(
      'plugin',
      pluginSource,
      copy.ui.pluginUrlLabel,
      copy.pluginSource.inputLabel,
      copy.pluginSource.placeholder,
      pluginDraft,
      (value) => {
        pluginDraft = value
      },
    )
    field(
      'runtime',
      runtimeSource,
      copy.ui.runtimeUrlLabel,
      copy.runtime.sourceInputLabel,
      copy.runtime.sourcePlaceholder,
      runtimeDraft,
      (value) => {
        runtimeDraft = value
      },
    )
    if (pluginSource === null && runtimeSource === null) {
      settingsEl.append(el('p', 'hqpu-status', copy.runtime.notConfigured))
    }

    const actions = el('div', 'hqpu-settings-actions')
    const cancel = el('button', 'hqpu-btn hqpu-btn--ghost hqpu-btn--sm', copy.cancel)
    cancel.type = 'button'
    cancel.addEventListener('click', () => {
      settingsOpen = false
      syncDrafts()
      render()
    })
    const save = el('button', 'hqpu-btn hqpu-btn--brand hqpu-btn--sm', copy.ui.saveAndRefresh)
    save.type = 'button'
    save.disabled = saving
    save.setAttribute('data-source-save', '')
    save.addEventListener('click', () => {
      void saveSources()
    })
    actions.append(cancel, save)
    settingsEl.append(actions)
  }

  function renderJobSection(): void {
    jobSection.textContent = ''
    const active = store.activeJob()
    if (active !== null && !TERMINAL_PHASES.has(active.phase)) {
      jobSection.append(
        activeJobView(active, copy, {
          stalled: store.stalled?.() === true,
          onRecheck: () => {
            void store.fetchStatus()
          },
        }),
      )
    }
  }

  function renderBanners(report: PluginUpdateReport | null, jobActive: boolean): void {
    bannerSection.textContent = ''
    if (report !== null) {
      const banner = checkBanner(report, copy, () => {
        void store.check()
      })
      if (banner !== null) bannerSection.append(banner)
    }
    // A terminal non-success job leads the body; the full log is one click away
    // in the drawer, but the outcome itself must not hide there.
    if (jobActive) return
    const settled = settledJob()
    if (settled !== null && settled.phase !== 'done') {
      bannerSection.append(
        jobResultBanner(
          settled,
          copy,
          () => retryJob(settled.kind),
          () => {
            logOpen = true
            render()
          },
        ),
      )
    }
  }

  function renderList(report: PluginUpdateReport | null, busy: boolean): void {
    listSection.textContent = ''
    bandSection.textContent = ''
    if (report === null) {
      listSection.append(skeleton(copy))
      return
    }
    const band = decisionBand(report, copy)
    if (band !== null) bandSection.append(band)

    const actionable = report.items.filter(isActionable)
    if (actionable.length > 0) {
      const section = el('section', 'hqpu-group')
      section.dataset.group = copy.group.actionable
      const head = el('div', 'hqpu-sec-head')
      const titleWrap = el('div', 'hqpu-sec-title')
      titleWrap.append(el('span', '', copy.group.actionable))
      titleWrap.append(el('span', 'hqpu-count-pill', String(actionable.length)))
      head.append(titleWrap)
      const anyChanges = actionable.some((i) => Array.isArray(i.changes) && i.changes.length > 0)
      if (anyChanges) {
        head.append(
          linkButton(
            'hqpu-link',
            changesAllOpen ? copy.ui.collapseLogs : copy.ui.expandLogs,
            () => {
              changesAllOpen = !changesAllOpen
              if (!changesAllOpen) changesOpen.clear()
              render()
            },
          ),
        )
      }
      section.append(head)
      const list = el('ul', 'hqpu-cards')
      for (const item of actionable) {
        list.append(
          pluginCard(item, copy, {
            changesOpen: changesAllOpen || changesOpen.has(item.name),
            onToggleChanges: () => {
              if (changesOpen.has(item.name)) changesOpen.delete(item.name)
              else changesOpen.add(item.name)
              render()
            },
            onInstall: () => {
              void runInstall(store, copy, [item.name])
            },
            onIgnore: () => {
              void togglePluginIgnore(item)
            },
            busy,
          }),
        )
      }
      section.append(list)
      listSection.append(section)
    }
  }

  function renderExtras(report: PluginUpdateReport | null): void {
    extraSection.textContent = ''
    if (report === null) return

    const alert = runtimeResultAlert(report, copy, dismissedAlert, () => {
      dismissedAlert = true
      render()
    })
    if (alert !== null) extraSection.append(alert)

    const engine = runtimeEngineCard(report, copy, runtimeActions)
    if (engine !== null) extraSection.append(engine)

    const byState = (state: PluginUpdateItem['state']): PluginUpdateItem[] =>
      report.items.filter((item) => item.state === state)

    const ignored = byState('ignored')
    if (ignored.length > 0) {
      extraSection.append(
        disclosure({
          id: 'hqpu-disc-ignored',
          title: copy.group.ignored,
          count: `(${ignored.length})`,
          note: copy.ui.ignoredNote,
          open: ignoredOpen,
          onToggle: () => {
            ignoredOpen = !ignoredOpen
            render()
          },
          build: () => {
            const ul = el('ul', 'hqpu-rows')
            for (const item of ignored) {
              ul.append(
                pluginRow(item, copy, () => {
                  void togglePluginIgnore(item)
                }),
              )
            }
            return [ul]
          },
        }),
      )
    }

    const current = byState('current')
    if (current.length > 0) {
      extraSection.append(
        disclosure({
          id: 'hqpu-disc-current',
          title: copy.group.current,
          count: `(${current.length})`,
          note: copy.ui.upToDateNote,
          open: upToDateOpen,
          onToggle: () => {
            upToDateOpen = !upToDateOpen
            render()
          },
          build: () => {
            const ul = el('ul', 'hqpu-rows')
            for (const item of current) ul.append(pluginRow(item, copy, () => undefined))
            return [ul]
          },
        }),
      )
    }

    if (hasReleaseContent(report.release)) {
      extraSection.append(
        disclosure({
          id: 'hqpu-disc-release',
          title: copy.ui.releaseTitle,
          note: report.manifestVersion !== null ? `v${report.manifestVersion}` : undefined,
          open: releaseOpen,
          onToggle: () => {
            releaseOpen = !releaseOpen
            render()
          },
          build: () => releaseBody(report.release as ReleaseInfo, copy),
        }),
      )
    }

    if (report.items.length === 0 && typeof report.lastError !== 'string') {
      extraSection.append(el('div', 'hqpu-empty', copy.empty))
    }
  }

  function renderFooter(report: PluginUpdateReport | null, busy: boolean): void {
    const actionable = report === null ? 0 : actionableUpdateCount(report)
    const setVersion = report?.manifestVersion ?? null
    const failed = typeof report?.lastError === 'string' && (report?.lastError ?? '').length > 0
    const runtimePending = report !== null && runtimeUpdateOffered(report.runtime)
    const anything = actionable > 0 || runtimePending

    ctaSpinner.hidden = !busy
    cta.dataset.busy = busy ? 'true' : 'false'
    cta.setAttribute('aria-busy', busy ? 'true' : 'false')

    if (busy) {
      ctaLabel.textContent = copy.ui.ctaInstalling
      cta.disabled = true
      // A stalled job is still "busy" — the install may have completed and only
      // the report is missing — so the footer must not promise progress it
      // cannot see. The card above carries the retry.
      footCount.textContent =
        store.stalled?.() === true ? copy.ui.footerConfirming : copy.ui.footerBusy
    } else if (report === null) {
      ctaLabel.textContent = copy.ui.ctaNoSet
      cta.disabled = true
      footCount.textContent = ''
    } else if (failed) {
      // Installing against a stale manifest is the one path that can only end
      // in a 422 — say so instead of offering a button that cannot work.
      ctaLabel.textContent = copy.ui.ctaFailed
      cta.disabled = true
      footCount.textContent = copy.ui.footerFailed
    } else if (setVersion === null) {
      ctaLabel.textContent = copy.ui.ctaNoSet
      cta.disabled = true
      footCount.textContent = copy.ui.checkedNever
    } else if (actionable === 0 && runtimePending) {
      // The plugin set is done; the only remaining offer is the runtime, which
      // needs its own confirm — the CTA must not imply it would install it.
      ctaLabel.textContent = copy.ui.ctaNoPlugins
      cta.disabled = true
      footCount.textContent = copy.ui.footerRuntimeOnly
    } else if (actionable === 0 && !runtimePending) {
      ctaLabel.textContent = copy.ui.ctaUpToDate
      cta.disabled = true
      footCount.textContent = copy.ui.footerAllGood
    } else {
      ctaLabel.textContent = copy.ui.cta(actionable)
      cta.disabled = false
      footCount.textContent = copy.ui.footerCount(actionable)
    }
    cta.onclick = () => {
      void runInstall(store, copy)
    }

    // Set-level mute: only with an evaluated set and something to mute.
    const canMute = setVersion !== null && report !== null && !busy
    ignoreBtn.hidden = !canMute || (!anything && !report?.ignoredSet)
    ignoreBtn.textContent = report?.ignoredSet === true ? copy.ui.unignoreBtn : copy.ui.ignoreBtn
    ignoreBtn.onclick = () => {
      if (setVersion === null) return
      const ignored = report?.ignoredSet === true
      const action = ignored ? unignoreOffer(setVersion) : ignoreOffer(setVersion)
      // `check()`, never `refresh()`: ignoring only writes the decision to
      // hq-edge's state file, and its cached report keeps every item at
      // `update` until discovery runs again.
      void action
        .then(() => store.check())
        .catch((err: unknown) => {
          showToast(
            `${copy.ignoreError}: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          )
        })
    }
  }

  function renderLogDrawer(jobActive: boolean): void {
    const job = settledJob()
    const available = !jobActive && job !== null
    logBtn.disabled = !available
    logBtn.setAttribute('aria-pressed', logOpen && available ? 'true' : 'false')
    const label =
      jobActive ? copy.ui.logBusy : job === null ? copy.ui.logNone : logOpen ? copy.ui.logHide : copy.ui.logShow
    logBtn.title = label
    logBtn.setAttribute('aria-label', label)

    // A running job (or none at all) cannot have a log; drop the open flag so
    // the drawer does not snap back open once the job settles.
    if (!available || !logOpen) {
      if (!available) logOpen = false
      logDrawer.hidden = true
      logDrawer.textContent = ''
      main.dataset.logOpen = '0'
      return
    }
    logDrawer.hidden = false
    logDrawer.textContent = ''
    // The drawer is absolutely positioned, so it cannot size its own box: on a
    // short body (nothing left to update) it would be squeezed between the
    // header and the panel edge. The flag gives `.hqpu-main` a floor while it
    // is open, and nothing at all once it closes.
    main.dataset.logOpen = '1'
    for (const node of buildLogDrawer(
      job,
      store.recentJobs(),
      copy,
      (id) => {
        void copyLogId(id)
      },
      () => {
        logOpen = false
        render()
      },
    )) {
      logDrawer.append(node)
    }
  }

  function render(): void {
    const report = store.report()
    const active = store.activeJob()
    const jobActive = active !== null && !TERMINAL_PHASES.has(active.phase)
    const busy = store.installing() || jobActive

    refreshBtn.disabled = report === null
    gearBtn.setAttribute('aria-pressed', settingsOpen ? 'true' : 'false')
    gearBtn.title = copy.ui.gearTooltip

    // Header sub-line: the set version and the relative check time, once.
    const ago = relativeAgo(report?.checkedAt, copy)
    const setLabel =
      report?.manifestVersion !== null && report?.manifestVersion !== undefined
        ? copy.ui.setVersion(report.manifestVersion)
        : null
    if (setLabel !== null && ago !== null) sub.textContent = copy.ui.subJoined(setLabel, ago)
    else sub.textContent = setLabel ?? ago ?? copy.ui.checkedUnknown

    renderSettings()
    renderJobSection()
    renderBanners(report, jobActive)
    renderList(report, busy)
    renderExtras(report)
    renderFooter(report, busy)
    renderLogDrawer(jobActive)
  }

  /** Flip one plugin's per-item ignore flag, then re-run discovery. */
  async function togglePluginIgnore(item: PluginUpdateItem): Promise<void> {
    const setVersion = store.report()?.manifestVersion ?? null
    if (setVersion === null) return
    const action =
      item.state === 'ignored'
        ? unignorePlugin(setVersion, item.name)
        : ignorePlugin(setVersion, item.name)
    try {
      await action
      // Discovery must re-run for the item to come back as `ignored`; a
      // refusal has to be visible, never silently swallowed.
      await store.check()
    } catch (err: unknown) {
      showToast(
        `${copy.ignoreError}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const unsubscribe = store.subscribe(render)
  disposers.push(unsubscribe)

  // Refresh on open (bounded; never block the shell).
  void store.refresh()

  // Escape peels one layer at a time; the shell-wide contract still holds.
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      if (logOpen) {
        logOpen = false
        render()
        return
      }
      if (settingsOpen) {
        settingsOpen = false
        syncDrafts()
        render()
        return
      }
      onClose()
      return
    }
    if (ev.key === 'Tab') trapFocus(ev)
  }

  /** Keep Tab inside the dialog — it declares `aria-modal="true"`. */
  function trapFocus(ev: KeyboardEvent): void {
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((node) => node.closest('[hidden]') === null)
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const activeEl = document.activeElement
    if (ev.shiftKey && (activeEl === first || activeEl === panel)) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && activeEl === last) {
      ev.preventDefault()
      first.focus()
    }
  }

  document.addEventListener('keydown', onKeyDown)
  disposers.push(() => document.removeEventListener('keydown', onKeyDown))

  function onClose(): void {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = null
    if (toastHost === toastSection) toastHost = null
    if (activeCopy === copy) activeCopy = null
    overlay.remove()
    // Focus goes back where it came from — the sidebar row that opened this.
    if (previouslyFocused !== null && previouslyFocused.isConnected) previouslyFocused.focus()
  }

  render()
}

/**
 * Run the install transaction (a new durable job), then let the store poll it.
 *
 * @param pluginNames - omit for the whole set (the footer CTA), or pass one
 *   name for a card's 单独更新. hq-edge honours the subset.
 */
async function runInstall(
  store: UpdateStoreLike,
  copy: UpdateCopy,
  pluginNames?: string[],
): Promise<void> {
  const report = store.report()
  if (report === null) return
  // Without an evaluated set there is nothing to install: hq-edge has not read
  // a manifest yet, so the report is still its empty shell.
  if (report.manifestVersion === null) {
    showToast(copy.checkFailed, 'error')
    return
  }
  // Flip the installing flag BEFORE the request: this is what disables the
  // action buttons and shows the in-flight footer state.
  store.setInstalling(true)
  try {
    const result = await installSet(report.manifestVersion, pluginNames)
    if (result.error !== undefined) {
      store.setInstalling(false)
      showToast(`${copy.installError}: ${result.error}`, 'error')
      return
    }
    // 202 accepted: a durable job now owns the lifecycle. Follow it BY ID —
    // that is what survives the restart when this very plugin is in the set
    // being installed (the server then has no "active job" to hand back, only
    // the record of the id we asked about).
    store.watchJob?.(result.jobId ?? null)
    showToast(copy.installSuccess, 'success')
    void store.fetchStatus()
  } catch (err: unknown) {
    store.setInstalling(false)
    showToast(
      `${copy.installError}: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  }
}

/** First-read placeholders, sharing the card layout. */
function skeleton(copy: UpdateCopy): HTMLElement {
  const section = el('section', 'hqpu-group')
  section.setAttribute('role', 'status')
  section.dataset.loading = ''
  section.setAttribute('aria-label', copy.loading)
  const list = el('ul', 'hqpu-cards')
  list.setAttribute('aria-hidden', 'true')
  for (let index = 0; index < 3; index += 1) {
    const card = el('li', 'hqpu-card')
    const head = el('div', 'hqpu-card-head')
    const id = el('div', 'hqpu-card-id')
    id.append(el('span', 'hqpu-avatar hqpu-skeleton-fill'))
    const main = el('div', 'hqpu-card-main')
    const title = el('span', 'hqpu-card-title hqpu-skeleton-fill hqpu-skeleton-title')
    const sub = el('span', 'hqpu-card-sub hqpu-skeleton-fill hqpu-skeleton-sub')
    main.append(title, sub)
    id.append(main)
    head.append(id)
    card.append(head)
    list.append(card)
  }
  section.append(list)
  return section
}
