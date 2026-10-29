/**
 * Plugin-update review view (browser half).
 *
 * Plain-DOM panel (no React tree) so it can never disturb the DSH shell's
 * reconciliation — same rule as the sidebar entry rows. Rendered content:
 *
 *   - head: title + intro + refresh toolbar (the shell plugin-manager head row)
 *   - state-grouped sections, each a group head + package cards
 *     (48px hairline-framed glyph, title row with a state tag, one-line
 *     version transition, end actions) — the shell's card geometry
 *   - a facts group for the independent HQ Edge runtime report
 *   - footer actions (install / ignore / show again), with a toast that
 *     reports the outcome of an install the way the shell's Toast does
 *
 * Every surface rides a `--dsw-alias-*` design token (see VIEW_CSS_TEXT), so
 * the panel follows the shell's light/dark theme and its focus-ring contract.
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
} from './api.js'
import { formatMb, type UpdateCopy } from './copy.js'
import { actionableUpdateCount } from './version.js'
import {
  CHECK_CIRCLE_ICON,
  CLOSE_ICON,
  DOWNLOAD_ICON,
  INFO_ICON,
  LOG_ICON,
  PLUGIN_ICON,
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
  /** Bounded recent jobs (newest first), for the result/history view. */
  recentJobs(): UpdateJob[]
  refresh(): Promise<PluginUpdateReport | null>
  /** Force a fresh update check (used by the failed-check Retry action). */
  check(): Promise<PluginUpdateReport | null>
  /** Re-read `/status` (resume an active job immediately after submitting). */
  fetchStatus(): Promise<void>
  subscribe(listener: () => void): () => void
}

/** How long the outcome toast stays up, in milliseconds. */
const TOAST_HOLD_MS = 4000

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

/**
 * Compact a package name to what a person calls it — the shell plugin
 * manager's own rule (`presentation.ts` `shortName`), so both UIs read the
 * same plugin by the same name.
 */
export function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

/** The one-line version transition under a card's title. */
function versionLine(item: PluginUpdateItem): string {
  switch (item.state) {
    case 'current':
      return item.currentVersion ?? item.availableVersion
    case 'install':
      return item.availableVersion
    default:
      // An absent plugin names only the version it would gain.
      return item.currentVersion === null
        ? item.availableVersion
        : `${item.currentVersion} → ${item.availableVersion}`
  }
}

/** Two-letter avatar initials for a card (CJK-safe). */
function avatarInitials(item: PluginUpdateItem): string {
  const src =
    typeof item.displayName === 'string' && item.displayName.trim().length > 0
      ? item.displayName.trim()
      : shortName(item.name)
  if (/[⺀-鿿]/.test(src)) return src.slice(0, 2)
  const words = src.split(/[\s_\-./@]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return src.replace(/^@/, '').slice(0, 2).toUpperCase()
}

/** Shared per-card changelog toggle drawer (the per-plugin changes[] list). */
function changelogDrawer(
  item: PluginUpdateItem,
  copy: UpdateCopy,
  open: boolean,
  onInstall: () => void,
  onIgnore: () => void,
): HTMLElement {
  const drawer = el('div', 'hqpu-changelog-drawer')
  drawer.style.display = open ? '' : 'none'
  drawer.append(el('div', 'hqpu-changelog-drawer-title', copy.ui.changelogTitle))
  const ul = el('ul')
  for (const change of item.changes ?? []) {
    if (typeof change === 'string' && change.length > 0) ul.append(el('li', '', change))
  }
  if (ul.childElementCount > 0) drawer.append(ul)
  const actions = el('div', 'hqpu-changelog-actions')
  if (item.state === 'update' || item.state === 'install') {
    const install = el('button', 'hqpu-card-action hqpu-card-action--install', copy.installOnePlugin)
    install.type = 'button'
    install.title = copy.installOneTip
    install.addEventListener('click', onInstall)
    const ignore = el('button', 'hqpu-card-action', copy.ignore)
    ignore.type = 'button'
    ignore.addEventListener('click', onIgnore)
    actions.append(install, ignore)
  } else if (item.state === 'ignored') {
    const show = el('button', 'hqpu-card-action hqpu-card-action--install', copy.unignore)
    show.type = 'button'
    show.addEventListener('click', onIgnore)
    actions.append(show)
  }
  if (actions.childElementCount > 0) drawer.append(actions)
  return drawer
}

/** One package card per the mockup: avatar initials, display name + package
 *  subtitle, old→new version row (new in emerald), a 日志 toggle expanding the
 *  inline changelog. */
function packageCard(
  item: PluginUpdateItem,
  copy: UpdateCopy,
  open: boolean,
  onToggle: () => void,
  onInstall: () => void,
  onIgnore: () => void,
): HTMLLIElement {
  const card = el('li', 'hqpu-card')
  card.dataset.pluginName = item.name
  card.dataset.state = item.state

  const head = el('div', 'hqpu-card-head')
  const left = el('div')
  const avatar = el('span', 'hqpu-avatar', avatarInitials(item))
  avatar.setAttribute('aria-hidden', 'true')

  const main = el('div', 'hqpu-card-main')
  const titleText =
    typeof item.displayName === 'string' && item.displayName.trim().length > 0
      ? item.displayName.trim()
      : shortName(item.name)
  main.append(el('span', 'hqpu-card-title', titleText))
  main.append(el('span', 'hqpu-card-sub', shortName(item.name)))

  // old → new version row; the NEW version renders in emerald.
  const ver = el('div', 'hqpu-version-row')
  if (item.currentVersion !== null && item.currentVersion !== undefined) {
    ver.append(el('span', 'hqpu-ver-old', item.currentVersion))
    ver.append(el('span', 'hqpu-ver-arrow', '→'))
  }
  const size = formatMb(item.sizeBytes ?? 0)
  ver.append(
    el('span', 'hqpu-ver-new', size.length > 0 ? `${item.availableVersion} (${size})` : item.availableVersion),
  )
  main.append(ver)
  left.append(avatar, main)

  const right = el('div', 'hqpu-card-end')
  const hasDetails = (Array.isArray(item.changes) && item.changes.length > 0) ||
    item.state === 'update' || item.state === 'install' || item.state === 'ignored'
  if (hasDetails) {
    const toggle = el('button', 'hqpu-log-toggle')
    toggle.type = 'button'
    toggle.dataset.open = open ? 'true' : 'false'
    toggle.innerHTML = `${copy.ui.changelogBtn}<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"/></svg>`
    toggle.addEventListener('click', onToggle)
    right.append(toggle)
  }
  head.append(left, right)
  card.append(head)

  // The actions live in the expanded changelog/details drawer so cards keep
  // their compact layout until a person asks for more information.
  if (hasDetails) {
    card.append(changelogDrawer(item, copy, open, onInstall, onIgnore))
  }
  return card
}

/** A section: head (title + count pill + expand-all toggle) then its cards. */
function group(
  heading: string,
  items: PluginUpdateItem[],
  copy: UpdateCopy,
  changelogOpen: Set<string>,
  allOpen: boolean,
  onToggle: (name: string) => void,
  onToggleAll: () => void,
  onInstall: (name: string) => void,
  onIgnore: (item: PluginUpdateItem) => void,
): HTMLElement | null {
  if (items.length === 0) return null
  const section = el('section', 'hqpu-group')
  section.dataset.group = heading

  const head = el('div', 'hqpu-section-head')
  const titleWrap = el('div', 'hqpu-section-title')
  titleWrap.append(el('span', '', heading))
  titleWrap.append(el('span', 'hqpu-count-pill', String(items.length)))
  head.append(titleWrap)
  // Expand-all only makes sense over actionable, changelog-bearing cards.
  const actionable = items.some((i) => Array.isArray(i.changes) && i.changes.length > 0)
  if (actionable) {
    const all = el('button', 'hqpu-all-changelog', copy.ui.allChangelog)
    all.type = 'button'
    all.addEventListener('click', onToggleAll)
    head.append(all)
  }

  const list = el('ul', 'hqpu-cards')
  for (const item of items) {
    list.append(packageCard(item, copy, allOpen || changelogOpen.has(item.name), () => onToggle(item.name), () => onInstall(item.name), () => onIgnore(item)))
  }

  section.append(head, list)
  return section
}

/** First-read placeholders, sharing the card and text-line layout. */
function skeleton(copy: UpdateCopy): HTMLElement {
  const section = el('section', 'hqpu-group')
  section.setAttribute('role', 'status')
  section.dataset.loading = ''
  const head = el('div', 'hqpu-group-head')
  head.setAttribute('aria-hidden', 'true')
  const heading = el('span', 'hqpu-group-title hqpu-skeleton-text hqpu-skeleton-heading')
  const headingBar = el('span', 'hqpu-skeleton-fill hqpu-skeleton-bar')
  heading.append(headingBar)
  head.append(heading)

  const list = el('ul', 'hqpu-cards')
  list.setAttribute('aria-hidden', 'true')
  for (let index = 0; index < 3; index += 1) {
    const card = el('li', 'hqpu-card')
    const cardHead = el('div', 'hqpu-card-head')
    const glyph = el('span', 'hqpu-card-icon hqpu-skeleton-fill hqpu-skeleton-icon')
    const main = el('div', 'hqpu-card-main')
    const titleRow = el('div', 'hqpu-title-row')
    const title = el('span', 'hqpu-card-title hqpu-skeleton-text hqpu-skeleton-title')
    title.append(el('span', 'hqpu-skeleton-fill hqpu-skeleton-bar'))
    titleRow.append(title)
    const desc = el('span', 'hqpu-card-desc hqpu-skeleton-text hqpu-skeleton-desc')
    desc.append(el('span', 'hqpu-skeleton-fill hqpu-skeleton-bar'))
    main.append(titleRow, desc)
    cardHead.append(glyph, main)
    const end = el('div', 'hqpu-card-end')
    end.setAttribute('aria-hidden', 'true')
    cardHead.append(end)
    card.append(cardHead)
    list.append(card)
  }
  section.append(head, list)
  // The skeleton replaces the whole column, so label it for screen readers.
  section.setAttribute('aria-label', copy.loading)
  return section
}

// ── Durable job views (active / result / recent) ───────────────────────────

/** Format a byte count for the progress line, or null when unknown. */
function formatBytes(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** Format an ETA in seconds to a short human string, or null when unknown. */
function formatEta(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** "上次检查: N 分钟前" — relative time from an ISO timestamp. */
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

function jobKindLabel(job: UpdateJob, copy: UpdateCopy): string {
  return job.kind === 'runtime' ? copy.job.kindRuntime : copy.job.kindPluginSet
}

/** The phase in human words, falling back to the raw code. */
function phaseLabel(job: UpdateJob, copy: UpdateCopy): string {
  return copy.job.phase[job.phase] ?? job.phase
}

/** One per-step line for plugin-set installs (and any job that reports steps). */
function stepsList(job: UpdateJob, copy: UpdateCopy): HTMLElement | null {
  if (!Array.isArray(job.steps) || job.steps.length === 0) return null
  const wrap = el('div', 'hqpu-job-steps')
  wrap.append(el('p', 'hqpu-group-count', copy.job.stepsTitle))
  const ol = el('ol', 'hqpu-steps')
  for (const step of job.steps) {
    const li = el('li', `hqpu-step hqpu-step--${step.state}`)
    const dot = el('span', 'hqpu-dot')
    dot.dataset.state =
      step.state === 'installed'
        ? 'done'
        : step.state === 'failed'
          ? 'error'
          : step.state === 'running'
            ? 'warning'
            : 'idle'
    li.append(dot)
    const text = step.message && step.message.length > 0 ? `${step.name} — ${step.message}` : step.name
    li.append(el('span', '', text))
    ol.append(li)
  }
  wrap.append(ol)
  return wrap
}

/** Map a job phase onto the 4-step indicator index (下载/校验/替换/重启). */
function stepIndex(phase: UpdateJob['phase']): number {
  switch (phase) {
    case 'downloading':
      return 0
    case 'verifying':
    case 'resolving':
      return 1
    case 'staging':
    case 'activating':
    case 'awaiting-host':
      return 2
    case 'restarting':
    case 'verifying-after-restart':
      return 3
    case 'queued':
      return -1
    default:
      return -1
  }
}

/**
 * The ACTIVE-JOB banner per the mockup: pulsing brand dot + job title with the
 * target version, mono percentage, a gradient bar only when `percent != null`,
 * phase + speed line ("3.1 MB/s (286MB / 450MB)"), and a 4-step indicator row
 * (done=emerald, active=pulsing brand, upcoming=muted).
 */
function activeJobView(job: UpdateJob, copy: UpdateCopy): HTMLElement {
  const section = el('section', 'hqpu-group')
  section.dataset.group = 'active-job'

  const card = el('div', 'hqpu-active')

  // Top row: pulse dot + title, mono percent.
  const top = el('div', 'hqpu-active-top')
  const titleWrap = el('div', 'hqpu-active-title')
  const pulse = el('span', 'hqpu-pulse-dot')
  pulse.append(el('span', 'hqpu-pulse-ring'))
  const title =
    job.kind === 'runtime'
      ? copy.ui.jobRuntimeTitle(job.targetVersion)
      : copy.ui.jobPluginTitle(job.targetVersion)
  titleWrap.append(pulse, el('span', '', title))
  const pct = job.progress.percent
  if (pct !== null) {
    top.append(el('span', 'hqpu-active-percent', `${Math.round(pct)}%`))
  }
  card.append(top)

  // Gradient bar — only when the server publishes a real percentage.
  if (pct !== null) {
    const bar = el('div', 'hqpu-progress')
    const fill = el('div', 'hqpu-progress-fill')
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`
    bar.append(fill)
    card.append(bar)
  }

  // Phase text + telemetry line: "3.1 MB/s (286MB / 450MB)".
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
  if (telemetry.length > 0) meta.append(el('span', '', telemetry))
  card.append(meta)

  // previous → target transition + what happens next (restart / elevation),
  // and the honest "closing does not cancel" note.
  const transition = el('div', 'hqpu-active-meta')
  transition.append(
    el(
      'span',
      '',
      job.previousVersion !== null && job.previousVersion.length > 0
        ? `${job.previousVersion} → ${job.targetVersion}`
        : job.targetVersion,
    ),
  )
  transition.append(
    el('span', '', job.kind === 'runtime' ? copy.job.willSwapRuntime : copy.job.willRestartDsh),
  )
  card.append(transition)
  card.append(el('p', 'hqpu-job-meta', copy.job.closeNote))

  // 4-step indicator: done=emerald, active=pulsing brand, upcoming=muted.
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
    stepsRow.append(el('div', cls, label))
  })
  card.append(stepsRow)

  section.append(card)
  return section
}

/**
 * The RESULT view for a terminal job: success / failed / rolled-back /
 * abandoned, previous→installed, per-package steps, errorCode + message, a log
 * correlation hint, and retry guidance (a retry starts a NEW job).
 */
function resultView(job: UpdateJob, copy: UpdateCopy, onRetry: () => void): HTMLElement {
  const section = el('section', 'hqpu-group')
  section.dataset.group = 'job-result'

  const tone =
    job.phase === 'done' ? 'success' : job.phase === 'failed' ? 'danger' : 'warning'
  const titleText =
    job.phase === 'done'
      ? copy.job.resultDone
      : job.phase === 'failed'
        ? copy.job.resultFailed
        : job.phase === 'rolled-back'
          ? copy.job.resultRolledBack
          : copy.job.resultAbandoned

  const head = el('div', 'hqpu-group-head')
  const tag = el('span', 'hqpu-tag')
  tag.dataset.tone = tone
  tag.textContent = titleText
  head.append(el('h3', 'hqpu-group-title', `${jobKindLabel(job, copy)} ${job.targetVersion}`), tag)
  section.append(head)

  const card = el('div', 'hqpu-job')
  const res = job.result
  const from = job.previousVersion ?? res?.installedVersion ?? '—'
  const to = res?.installedVersion ?? job.targetVersion
  const finished =
    res !== undefined && res.finishedAt.length > 0
      ? ` · ${new Date(res.finishedAt).toLocaleString()}`
      : ''
  card.append(el('p', 'hqpu-status', `${from} → ${to}${finished}`))
  if (res !== undefined && res.message !== undefined && res.message.length > 0) {
    card.append(el('p', 'hqpu-status', res.message))
  }
  if (res !== undefined && res.errorCode !== undefined && res.errorCode.length > 0) {
    card.append(el('p', 'hqpu-status', res.errorCode))
  }
  if (typeof job.logHint === 'string' && job.logHint.length > 0) {
    card.append(el('p', 'hqpu-status hqpu-job-meta', copy.job.logHint(job.logHint)))
  }

  const steps = stepsList(job, copy)
  if (steps !== null) card.append(steps)

  // Retry starts a NEW update job — never re-click the settled job id.
  if (job.phase === 'failed' || job.phase === 'abandoned') {
    const retry = el('button', 'hqpu-btn hqpu-btn--outline hqpu-btn--sm', copy.job.retry)
    retry.type = 'button'
    retry.addEventListener('click', onRetry)
    card.append(retry)
  }
  section.append(card)
  return section
}

/** A one-line row for older recent jobs (newest already shown as the card). */
function recentJobsList(jobs: UpdateJob[], copy: UpdateCopy): HTMLElement | null {
  const older = jobs.slice(1, 5)
  if (older.length === 0) return null
  const wrap = el('div', 'hqpu-group')
  wrap.dataset.group = 'recent-jobs'
  wrap.append(el('h3', 'hqpu-group-count', copy.job.recentTitle))
  const ul = el('ul', 'hqpu-cards')
  for (const job of older) {
    const li = el('li', 'hqpu-status')
    const when = job.updatedAt.length > 0 ? ` · ${new Date(job.updatedAt).toLocaleString()}` : ''
    li.textContent = `${jobKindLabel(job, copy)} ${job.targetVersion} · ${phaseLabel(job, copy)}${when}`
    ul.append(li)
  }
  wrap.append(ul)
  return wrap
}

/**
 * Check-status banner: a FAILED check shows a clear error row + Retry (never
 * the silent "no updates" empty state); a successful check shows the time;
 * when a check failed but a prior report exists it is labelled stale.
 */
function checkBanner(
  report: PluginUpdateReport,
  copy: UpdateCopy,
  onRetry: () => void,
): HTMLElement | null {
  const failed = typeof report.lastError === 'string' && report.lastError.length > 0
  const checked = typeof report.checkedAt === 'string' && report.checkedAt.length > 0
  if (!failed && !checked) return null

  const wrap = el('section', 'hqpu-group')
  wrap.dataset.group = 'check-status'
  if (failed) {
    const banner = el('div', 'hqpu-banner')
    banner.dataset.tone = 'danger'
    banner.innerHTML = WARNING_ICON(14)
    banner.append(el('span', '', copy.checkFailedBanner(report.lastError as string)))
    wrap.append(banner)
    if (report.items.length > 0) {
      wrap.append(el('p', 'hqpu-status', copy.staleNote))
    }
    const row = el('div', 'hqpu-actions')
    const retry = el('button', 'hqpu-btn hqpu-btn--primary hqpu-btn--sm', copy.retry)
    retry.type = 'button'
    retry.addEventListener('click', onRetry)
    row.append(retry)
    wrap.append(row)
    return wrap
  }
  wrap.append(
    el('p', 'hqpu-status', copy.checkedAt(new Date(report.checkedAt as string).toLocaleString())),
  )
  return wrap
}

/** Set-level release metadata (v2 manifest): summary, notes, breaking, link. */
function releaseHeader(release: ReleaseInfo | null | undefined, copy: UpdateCopy): HTMLElement | null {
  if (release === null || release === undefined) return null
  const notes = Array.isArray(release.notes) ? release.notes.filter((n) => typeof n === 'string' && n.length > 0) : []
  const breaking = Array.isArray(release.breaking)
    ? release.breaking.filter((n) => typeof n === 'string' && n.length > 0)
    : []
  const hasContent =
    (typeof release.summary === 'string' && release.summary.length > 0) ||
    notes.length > 0 ||
    breaking.length > 0 ||
    typeof release.notesUrl === 'string' ||
    typeof release.publishedAt === 'string'
  if (!hasContent) return null

  const section = el('section', 'hqpu-group')
  section.dataset.group = 'release'
  section.append(el('h3', 'hqpu-group-title', copy.release.summaryTitle))
  if (typeof release.summary === 'string' && release.summary.length > 0) {
    section.append(el('p', 'hqpu-status', release.summary))
  }
  if (typeof release.publishedAt === 'string' && release.publishedAt.length > 0) {
    section.append(el('p', 'hqpu-status', copy.release.publishedAt(new Date(release.publishedAt).toLocaleString())))
  }
  if (release.requiresRestart === true) {
    section.append(el('p', 'hqpu-status', copy.job.willRestartDsh))
  }
  if (notes.length > 0) {
    const ul = el('ul', 'hqpu-release-notes')
    for (const note of notes) ul.append(el('li', '', note as string))
    section.append(ul)
  }
  if (breaking.length > 0) {
    const banner = el('div', 'hqpu-banner')
    banner.dataset.tone = 'danger'
    banner.innerHTML = WARNING_ICON(14)
    const inner = el('span')
    inner.append(el('strong', '', `${copy.release.breakingTitle}: `))
    inner.append(document.createTextNode(breaking.join(' · ')))
    banner.append(inner)
    section.append(banner)
  }
  if (typeof release.notesUrl === 'string' && release.notesUrl.length > 0) {
    const link = el('a', 'hqpu-status hqpu-release-link', copy.release.notesLink)
    link.href = release.notesUrl
    link.target = '_blank'
    link.rel = 'noreferrer'
    section.append(link)
  }
  return section
}

/** Native disclosure that hides the developer-facing source editors by
 *  default (end users should never need to type a manifest URL). */
function advancedBlock(copy: UpdateCopy, nodes: Array<HTMLElement | null>): HTMLElement {
  const details = el('details', 'hqpu-advanced')
  details.append(el('summary', '', copy.release.advanced))
  for (const node of nodes) {
    if (node !== null) details.append(node)
  }
  return details
}

/** Mutable editor state for one manifest source (lives in the panel closure). */
interface SourceState {
  editing: boolean
  saving: boolean
  draft: string
}

/**
 * Shared state + callbacks for one update-source editor.
 *
 * hq-edge serves both manifest sources from one shape (plugin release
 * manifest, runtime-update manifest), and both are editable from this panel:
 * an override is persisted per host, so pointing discovery at a staging
 * channel (or a local test rig) needs no env var and no restart. The editor
 * state lives in the panel closure for the same reason `armed` does — a store
 * refresh must not discard a half-typed URL or silently close the editor.
 */
export interface SourceEditorActions {
  /** The source editor is open (input shown instead of the read-only row). */
  sourceEditing: boolean
  /** A save is in flight. */
  sourceSaving: boolean
  /** The URL being edited (what the input shows). */
  sourceDraft: string
  onSourceEdit(): void
  onSourceDraft(value: string): void
  onSourceSave(): void
  onSourceCancel(): void
  /** Clear the user override, falling back to the configured URL. */
  onSourceReset(): void
}

/**
 * The runtime-update action row's state and callbacks.
 *
 * Installing the runtime is destructive in a way a plugin install is not: hq-edge
 * shuts itself down so the EDA host can swap the runtime directory. So the row
 * is a two-step confirm (arm → confirm), never a single fire-and-forget click.
 */
export interface RuntimeActions extends SourceEditorActions {
  /** A request is in flight (hq-edge accepted it and is restarting). */
  busy: boolean
  /** The confirm step is armed for the version the row names. */
  armed: boolean
  /**
   * hq-edge answered `202 Accepted`: from here on the outcome belongs to the
   * EDA host, and this process is about to be replaced. Terminal — the row
   * must never re-offer the button once this is true, because hq-edge is
   * already gone and a second request could only fail.
   */
  accepted: boolean
  onArm(): void
  onConfirm(): void
  onCancel(): void
}

/**
 * Normalize the report's `runtime.source` to the full shape.
 *
 * An older hq-edge predates the feature and sends no `source` at all — that
 * must degrade to a read-only panel, not crash the render. A future server
 * may add fields; unknown extras are dropped here rather than trusted.
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

/** The tag naming where the URL in effect came from. */
function originLabel(origin: RuntimeUpdateSource['origin'], copy: UpdateCopy): string {
  switch (origin) {
    case 'override':
      return copy.originOverride
    case 'config':
      return copy.originConfig
    default:
      return copy.originUnset
  }
}

/** The 更新源 fact row: the URL in effect plus an origin tag. */
function sourceFactRow(
  facts: HTMLElement,
  source: RuntimeUpdateSource,
  copy: UpdateCopy,
): void {
  const wrap = el('div')
  wrap.append(el('dt', '', copy.runtime.source))
  const dd = el('dd')
  const line = el('div', 'hqpu-source-line')
  const code = el(
    'code',
    'hqpu-source-url',
    source.url.length > 0 ? source.url : copy.runtime.notConfigured,
  )
  const tag = el('span', 'hqpu-tag')
  tag.dataset.tone = source.override ? 'info' : source.origin === 'config' ? 'success' : 'neutral'
  tag.textContent = originLabel(source.origin, copy)
  line.append(code, tag)
  dd.append(line)
  wrap.append(dd)
  facts.append(wrap)
}

/** Which manifest an editor belongs to — drives data attributes + CSS hook. */
export type SourceKind = 'runtime' | 'plugin'

/** The localized strings one source editor needs (both kinds share the flow). */
interface SourceEditorLabels {
  hint: string
  edit: string
  save: string
  reset: string
  inputLabel: string
  placeholder: string
}

/** Pick the labels for one kind out of the copy table. */
function sourceLabels(copy: UpdateCopy, kind: SourceKind): SourceEditorLabels {
  return kind === 'runtime'
    ? {
        hint: copy.runtime.sourceHint,
        edit: copy.runtime.sourceEdit,
        save: copy.runtime.sourceSave,
        reset: copy.runtime.sourceReset,
        inputLabel: copy.runtime.sourceInputLabel,
        placeholder: copy.runtime.sourcePlaceholder,
      }
    : {
        hint: copy.pluginSource.hint,
        edit: copy.pluginSource.edit,
        save: copy.pluginSource.save,
        reset: copy.pluginSource.reset,
        inputLabel: copy.pluginSource.inputLabel,
        placeholder: copy.pluginSource.placeholder,
      }
}

/**
 * One update-source editor, shared by the plugin manifest and the runtime
 * manifest (the only differences are the labels and the data-attribute
 * prefix, so tests and CSS can target each).
 *
 * Read mode is a hint plus a 修改 button; edit mode is the URL field with
 * 保存 / 取消 — plus 恢复默认 while a user override shadows the configured
 * URL. The draft lives in {@link SourceEditorActions} (the panel closure), so
 * a background store refresh re-renders the typed URL instead of discarding it.
 */
function sourceEditor(
  kind: SourceKind,
  source: RuntimeUpdateSource,
  copy: UpdateCopy,
  actions: SourceEditorActions,
): HTMLElement {
  const labels = sourceLabels(copy, kind)
  const block = el('div', `hqpu-source-editor hqpu-source-editor--${kind}`)
  if (!actions.sourceEditing) {
    // Read mode: show the URL currently in effect (mono, muted), then edit.
    const urlLine = el('p', 'hqpu-source-current-url', source.url)
    urlLine.style.cssText =
      'margin:2px 0 6px;font-size:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary);word-break:break-all;'
    block.append(urlLine)
    block.append(el('p', 'hqpu-status hqpu-source-hint', labels.hint))
    const edit = el('button', 'hqpu-btn hqpu-btn--outline hqpu-btn--sm', labels.edit)
    edit.type = 'button'
    edit.setAttribute(`data-${kind}-source-edit`, '')
    edit.disabled = actions.sourceSaving
    edit.addEventListener('click', actions.onSourceEdit)
    block.append(edit)
    return block
  }
  const input = el('input', 'hqpu-source-input')
  input.type = 'url'
  input.value = actions.sourceDraft
  input.placeholder = labels.placeholder
  input.setAttribute('aria-label', labels.inputLabel)
  input.setAttribute(`data-${kind}-source-input`, '')
  input.disabled = actions.sourceSaving
  input.addEventListener('input', () => {
    // Draft-only: no re-render, so the caret and IME stay untouched.
    actions.onSourceDraft(input.value)
  })
  // Enter saves, Escape cancels — the field is the whole editor, and Escape
  // must not fall through to the panel-wide close handler.
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      actions.onSourceSave()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      actions.onSourceCancel()
    }
  })
  const save = el('button', 'hqpu-btn hqpu-btn--primary hqpu-btn--sm', labels.save)
  save.type = 'button'
  save.setAttribute(`data-${kind}-source-save`, '')
  save.disabled = actions.sourceSaving
  save.addEventListener('click', actions.onSourceSave)
  const cancel = el('button', 'hqpu-btn hqpu-btn--outline hqpu-btn--sm', copy.cancel)
  cancel.type = 'button'
  cancel.setAttribute(`data-${kind}-source-cancel`, '')
  cancel.disabled = actions.sourceSaving
  cancel.addEventListener('click', actions.onSourceCancel)
  const controls = el('div', 'hqpu-actions hqpu-source-controls')
  controls.append(input, save, cancel)
  if (source.override) {
    const reset = el('button', 'hqpu-btn hqpu-btn--ghost hqpu-btn--sm', labels.reset)
    reset.type = 'button'
    reset.setAttribute(`data-${kind}-source-reset`, '')
    reset.disabled = actions.sourceSaving
    reset.addEventListener('click', actions.onSourceReset)
    controls.append(reset)
  }
  block.append(controls)
  // Focus on open — and on any re-render while editing, which is exactly what
  // a rejected save wants (the user is dropped back into the field to fix it).
  input.focus()
  return block
}

/**
 * The plugin release-manifest source, as its own group above the plugin
 * groups: it says where the whole list comes from, so it belongs above the
 * list rather than inside it. Absent on an older hq-edge (no `pluginSource`
 * in the report) — then nothing is rendered at all.
 */
function pluginSourceGroup(
  report: PluginUpdateReport,
  copy: UpdateCopy,
  actions: SourceEditorActions,
): HTMLElement | null {
  const source = normalizeSource(report.pluginSource)
  if (source === null) return null
  const section = el('section', 'hqpu-group')
  section.dataset.group = 'plugin-source'
  const head = el('div', 'hqpu-group-head')
  head.append(el('h3', 'hqpu-group-title', copy.pluginSource.title))
  section.append(head)

  const facts = el('dl', 'hqpu-facts')
  sourceFactRow(facts, source, copy)
  section.append(facts)
  section.append(sourceEditor('plugin', source, copy, actions))
  return section
}

/**
 * The host's own report of the last runtime swap. Rolled-back / failed renders
 * as an AMBER alert card (title, old→new body, errorCode chip, 忽略 dismiss);
 * succeeded renders as a subtle green inline line — not a loud banner. The
 * plugin has NO log-open affordance, so "查看诊断日志" is omitted (never faked).
 */
function runtimeResultAlert(
  report: PluginUpdateReport,
  copy: UpdateCopy,
  dismissed: boolean,
  onDismiss: () => void,
): HTMLElement | null {
  const lastResult = report.runtime.lastResult
  if (lastResult === null || lastResult === undefined) return null

  // Green inline confirmation — quiet by design.
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
  card.innerHTML = WARNING_ICON(14)

  const body = el('div')
  const title = el('div', 'hqpu-alert-title')
  title.textContent = lastResult.state === 'failed' ? copy.ui.failedTitle : copy.ui.rollbackTitle
  body.append(title)

  const oldVer = lastResult.installedVersion ?? lastResult.targetVersion ?? '—'
  const code = typeof lastResult.errorCode === 'string' && lastResult.errorCode.length > 0
    ? lastResult.errorCode
    : '—'
  const text =
    lastResult.state === 'failed'
      ? copy.ui.failedBody(oldVer, code)
      : copy.ui.rollbackBody(oldVer, code)
  // Build the body as text + an inline <code> chip for the error code.
  const bodyP = el('p', 'hqpu-alert-body')
  const textOnly =
    lastResult.state === 'failed'
      ? copy.ui.failedBody(oldVer, '')
      : copy.ui.rollbackBody(oldVer, '')
  // Strip the trailing "code" placeholder we appended; re-add as a chip.
  bodyP.append(document.createTextNode(textOnly.replace(/\s*$/, '')))
  if (typeof lastResult.errorCode === 'string' && lastResult.errorCode.length > 0) {
    bodyP.append(document.createTextNode(' '))
    const chip = el('code', '', lastResult.errorCode)
    bodyP.append(chip)
  }
  if (typeof lastResult.message === 'string' && lastResult.message.length > 0) {
    bodyP.append(el('br'), document.createTextNode(lastResult.message))
  }
  body.append(bodyP)

  // Dismiss action (no log button — the plugin has no log-open affordance).
  const actions = el('div', 'hqpu-alert-actions')
  const dismiss = el('button', 'hqpu-alert-dismiss', copy.ui.dismiss)
  dismiss.type = 'button'
  dismiss.addEventListener('click', onDismiss)
  actions.append(dismiss)
  body.append(actions)

  card.append(body)
  section.append(card)
  return section
}

/** The HQ Edge runtime engine card per the mockup: current chip, "新版本 vY
 *  可用" with a 关键修复 tag when breaking/notes exist, size+summary line, a
 *  升级核心 button (existing arm→confirm flow), and the amber restart note. */
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
  titleWrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.33333 2L4.66667 8H8L6.66667 14L11.33333 8H8L9.33333 2Z"/></svg>`
  titleWrap.append(el('span', '', copy.ui.runtimeEngine))
  head.append(titleWrap)
  if (typeof runtime.currentVersion === 'string' && runtime.currentVersion.length > 0) {
    head.append(el('span', 'hqpu-chip', copy.ui.currentChip(runtime.currentVersion)))
  }
  card.append(head)

  // Update row (only when a newer distribution is known).
  if (runtime.updateAvailable && latestVersion !== null) {
    const row = el('div', 'hqpu-engine-update-row')
    const left = el('div')
    const newLine = el('div', 'hqpu-engine-new-line')
    newLine.append(el('span', '', copy.ui.newVersion(latestVersion)))
    const latestEntry = runtime.latest
    const hasCritical =
      (Array.isArray(latestEntry?.breaking) && (latestEntry?.breaking?.length ?? 0) > 0) ||
      (Array.isArray(latestEntry?.notes) && (latestEntry?.notes?.length ?? 0) > 0)
    if (hasCritical) newLine.append(el('span', 'hqpu-tag--brand', copy.ui.breakingTag))
    left.append(newLine)
    const size = typeof latestEntry?.sizeBytes === 'number' ? formatMb(latestEntry.sizeBytes) : ''
    const summary = typeof latestEntry?.summary === 'string' ? latestEntry.summary : ''
    if (size.length > 0 || summary.length > 0) {
      left.append(el('p', 'hqpu-engine-size', copy.ui.sizeLine(size, summary)))
    }
    row.append(left)

    // Upgrade action: arm → confirm, accepted/busy states preserved.
    if (actions.accepted) {
      row.append(el('span', 'hqpu-status', copy.runtime.updateAccepted))
    } else if (actions.busy) {
      row.append(el('span', 'hqpu-status', copy.runtime.updating))
    } else if (actions.armed) {
      const confirmWrap = el('div')
      confirmWrap.append(el('p', 'hqpu-status', copy.runtime.updateConfirm(latestVersion)))
      const yes = el('button', 'hqpu-btn hqpu-btn--engine', copy.confirmInstall)
      yes.type = 'button'
      yes.dataset.runtimeConfirm = ''
      yes.addEventListener('click', actions.onConfirm)
      const no = el('button', 'hqpu-btn hqpu-btn--engine', copy.cancel)
      no.type = 'button'
      no.addEventListener('click', actions.onCancel)
      confirmWrap.append(yes, no)
      row.append(confirmWrap)
    } else {
      const start = el('button', 'hqpu-btn hqpu-btn--engine', copy.ui.upgradeCore)
      start.type = 'button'
      start.dataset.runtimeUpdate = ''
      start.addEventListener('click', actions.onArm)
      row.append(start)
    }
    card.append(row)
    const note = el('p', 'hqpu-engine-note')
    note.innerHTML =
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5L14 13H2L8 2.5Z"/></svg><span>${copy.ui.runtimeRestartNote}</span>`
    card.append(note)
  } else if (typeof runtime.lastError === 'string' && runtime.lastError.length > 0) {
    card.append(el('p', 'hqpu-status', `${copy.lastError}: ${runtime.lastError}`))
  }
  return card
}

function renderList(
  section: HTMLElement,
  report: PluginUpdateReport | null,
  copy: UpdateCopy,
  changelogOpen: Set<string>,
  allOpen: boolean,
  onToggleCard: (name: string) => void,
  onToggleAll: () => void,
  onRetryCheck: () => void,
  onInstall: (name: string) => void,
  onIgnore: (item: PluginUpdateItem) => void,
): void {
  section.textContent = ''
  if (report === null) {
    section.append(skeleton(copy))
    return
  }
  // Check-status banner: a failed check shows an error row + Retry (never the
  // silent "no updates" empty state); a successful check shows the time.
  const banner = checkBanner(report, copy, onRetryCheck)
  if (banner !== null) section.append(banner)
  // Set-level release metadata (v2 manifest): summary, notes, breaking.
  const release = releaseHeader(report.release, copy)
  if (release !== null) section.append(release)
  if (report.items.length === 0) {
    // A successful check with zero updates — distinct from a failed check,
    // which already rendered its error row above.
    if (typeof report.lastError !== 'string' || report.lastError.length === 0) {
      section.append(el('div', 'hqpu-empty', copy.empty))
    }
    return
  }

  const byState = (state: PluginUpdateItem['state']): PluginUpdateItem[] =>
    report.items.filter((item) => item.state === state)

  // Most important first: what can be acted on, then what was muted, then what
  // is already settled. Blocked plugins are intentionally skipped — the server
  // still reports them, but they carry no user-actionable offer, so surfacing
  // them only adds noise without a path forward.
  const order: Array<[string, PluginUpdateItem[]]> = [
    [copy.group.actionable, [...byState('update'), ...byState('install')]],
    [copy.group.ignored, byState('ignored')],
    [copy.group.current, byState('current')],
  ]
  for (const [heading, items] of order) {
    const node = group(heading, items, copy, changelogOpen, allOpen, onToggleCard, onToggleAll, onInstall, onIgnore)
    if (node !== null) section.append(node)
  }
}

function renderRuntime(
  section: HTMLElement,
  report: PluginUpdateReport | null,
  copy: UpdateCopy,
  actions: RuntimeActions,
  dismissedAlert: boolean,
  onDismissAlert: () => void,
): void {
  section.textContent = ''
  if (report === null) return
  const alert = runtimeResultAlert(report, copy, dismissedAlert, onDismissAlert)
  if (alert !== null) section.append(alert)
  const engine = runtimeEngineCard(report, copy, actions)
  if (engine !== null) section.append(engine)
}

/** The plugin-source group, above the plugin groups, hidden behind an advanced
 *  disclosure (manifest-URL editing is a developer affordance). No-op without
 *  the field. */
function renderPluginSource(
  section: HTMLElement,
  report: PluginUpdateReport | null,
  copy: UpdateCopy,
  actions: SourceEditorActions,
): void {
  section.textContent = ''
  if (report === null) return
  const node = pluginSourceGroup(report, copy, actions)
  if (node !== null) section.append(advancedBlock(copy, [node]))
}

/** Run the install transaction (a new durable job), then let the store poll it. */
async function runInstall(store: UpdateStoreLike, copy: UpdateCopy, pluginNames?: string[]): Promise<void> {
  const report = store.report()
  if (report === null) return
  // Without an evaluated set there is nothing to install: hq-edge has not read
  // a manifest yet, so the report is still its empty shell.
  if (report.manifestVersion === null) {
    showToast(copy.checkFailed, 'error')
    return
  }
  // Flip the installing flag BEFORE the request: this is what disables the
  // action buttons and shows the "DSH will restart" footer state (previously
  // dead code — runInstall never called it).
  store.setInstalling(true)
  try {
    const result = await installSet(report.manifestVersion, pluginNames)
    if (result.error !== undefined) {
      store.setInstalling(false)
      showToast(`${copy.installError}: ${result.error}`, 'error')
      return
    }
    // 202 accepted: a durable job now owns the lifecycle. The store's /status
    // poller renders progress and clears the flag when the job settles.
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

/** The single live toast; a new message replaces the one on screen. */
let toastHost: HTMLElement | null = null
let toastTimer: number | null = null

function showToast(message: string, tone: 'success' | 'error'): void {
  if (toastHost === null) return
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  toastHost.textContent = ''
  const toast = el('div', 'hqpu-toast')
  toast.setAttribute('role', 'status')
  const icon = el('span', 'hqpu-toast-icon')
  icon.dataset.tone = tone
  icon.innerHTML = tone === 'success' ? CHECK_CIRCLE_ICON(16) : WARNING_ICON(16)
  toast.append(icon, el('span', 'hqpu-toast-text', message))
  toastHost.append(toast)
  toastTimer = window.setTimeout(() => {
    toastHost?.replaceChildren()
    toastTimer = null
  }, TOAST_HOLD_MS)
}

/**
 * The collapsible "更新源配置 (高级)" panel (gear-toggled). It hosts the
 * EXISTING plugin-source and runtime-source editors (POST /plugin-source,
 * POST /runtime-source, save→check→refresh already wired). No new endpoints:
 * if a manifest source has no data, that field is omitted rather than faked.
 */
function renderSettingsPanel(
  panel: HTMLElement,
  report: PluginUpdateReport | null,
  copy: UpdateCopy,
  open: boolean,
  pluginActions: SourceEditorActions,
  runtimeActions: SourceEditorActions,
): void {
  panel.textContent = ''
  panel.style.display = open ? '' : 'none'
  if (!open || report === null) return

  const row = el('div', 'hqpu-settings-row')
  row.append(el('div', 'hqpu-settings-title', copy.ui.settingsTitle))
  // Origin badge: custom override (amber) vs the default configured source (green).
  const pluginSource = normalizeSource(report.pluginSource)
  const runtimeSource = normalizeSource(report.runtime.source)
  const overridden = (pluginSource?.override ?? false) || (runtimeSource?.override ?? false)
  const badge = el('span', 'hqpu-origin-badge', overridden ? copy.ui.originCustom : copy.ui.originDefault)
  badge.dataset.origin = overridden ? 'override' : 'config'
  row.append(badge)
  panel.append(row)

  if (pluginSource !== null) {
    panel.append(el('label', '', copy.ui.pluginUrlLabel))
    panel.append(sourceEditor('plugin', pluginSource, copy, pluginActions))
  }
  if (runtimeSource !== null) {
    panel.append(el('label', '', copy.ui.runtimeUrlLabel))
    panel.append(sourceEditor('runtime', runtimeSource, copy, runtimeActions))
  }
}

/**
 * The sticky footer: left meta ("准备安装 N 项兼容插件" / "版本集: vX"), a
 * full-width primary "一键更新全套插件 (vX)" (install = one durable job),
 * a secondary 忽略 wired to the existing ignore/unignore affordance, and the
 * footnote. The count EXCLUDES ignored / already-current entries.
 */
function renderFooter(
  footer: HTMLElement,
  installBtn: HTMLButtonElement,
  ignoreBtn: HTMLButtonElement,
  countEl: HTMLElement,
  setEl: HTMLElement,
  report: PluginUpdateReport | null,
  copy: UpdateCopy,
  installing: boolean,
  store: UpdateStoreLike,
): void {
  if (report === null) {
    countEl.textContent = ''
    setEl.textContent = ''
    installBtn.disabled = true
    ignoreBtn.style.display = 'none'
    return
  }

  const actionable = actionableUpdateCount(report)
  const hasSet = report.manifestVersion !== null
  const setVersion: string = report.manifestVersion ?? ''

  countEl.textContent = copy.ui.footerCount(actionable)
  setEl.textContent = hasSet ? copy.ui.footerSet(setVersion) : ''

  // Install-all: honest set-level label; disabled while busy or nothing to do.
  installBtn.textContent = hasSet
    ? copy.ui.installAllSet(setVersion)
    : copy.ui.installAllSet('—')
  installBtn.disabled = installing || actionable === 0 || !hasSet || report.ignoredSet
  installBtn.dataset.busy = installing ? 'true' : 'false'
  installBtn.onclick = () => {
    void runInstall(store, copy)
  }

  // Secondary ignore button: only when there is an evaluated set to ignore.
  ignoreBtn.style.display = hasSet ? '' : 'none'
  ignoreBtn.textContent = report.ignoredSet ? copy.unignore : copy.ui.ignoreBtn
  ignoreBtn.onclick = () => {
    const version = report.manifestVersion as string
    const action = report.ignoredSet ? unignoreOffer(version) : ignoreOffer(version)
    // `check()`, never `refresh()`: ignoring only writes the decision to
    // hq-edge's state file, and its cached report keeps every item at `update`
    // until discovery runs again. A plain `/report` read therefore changed
    // nothing on screen — the count stayed where it was and the click looked
    // dead. A failed call (e.g. an older hq-edge without the route) is surfaced
    // instead of swallowed, so a mute that did not stick is never mistaken for
    // one that did.
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

  const overlay = el('div', 'hqpu-overlay')
  overlay.setAttribute('data-hq-plugin-update-view', '')
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) onClose()
  })

  const scrim = el('div', 'hqpu-scrim')
  const panel = el('div', 'hqpu-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', copy.viewTitle)
  panel.tabIndex = -1

  // ── Sticky header: brand icon + title + relative checked time, refresh +
  //    gear (advanced source settings) + close ──
  const head = el('div', 'hqpu-head')
  const headMain = el('div', 'hqpu-head-main')
  const brandIcon = el('span', 'hqpu-brand-icon')
  brandIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.6 2.6a6 6 0 015.6 1.6M12.4 13.4a6 6 0 01-5.6-1.6M10.6 2V5.4H7.2M5.4 14V10.6H8.8"/></svg>`
  const titleBlock = el('div', 'hqpu-title-block')
  titleBlock.append(el('h1', 'hqpu-title', copy.ui.title))
  const sub = el('p', 'hqpu-sub')
  titleBlock.append(sub)
  headMain.append(brandIcon, titleBlock)

  const toolbar = el('div', 'hqpu-toolbar')
  const refreshBtn = iconButton('hqpu-icon-btn', REFRESH_ICON(16), copy.refresh, () => {
    void store.check()
  })
  toolbar.append(refreshBtn)
  const gearBtn = iconButton(
    'hqpu-icon-btn',
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M13.5 9.2v-2.4l-1.8-.6a4.4 4.4 0 00-.5-1.2l.9-1.7-1.7-1.7-1.7.9a4.4 4.4 0 00-1.2-.5L7.2 2.5H4.8l-.6 1.8a4.4 4.4 0 00-1.2.5l-1.7-.9-1.7 1.7.9 1.7a4.4 4.4 0 00-.5 1.2L2.5 7.2v2.4l1.8.6a4.4 4.4 0 00.5 1.2l-.9 1.7 1.7 1.7 1.7-.9a4.4 4.4 0 001.2.5l.6 1.8h2.4l.6-1.8a4.4 4.4 0 001.2-.5l1.7.9 1.7-1.7-.9-1.7a4.4 4.4 0 00.5-1.2l1.8-.6z"/></svg>`,
    copy.ui.gearTooltip,
    () => {
      settingsOpen = !settingsOpen
      render()
    },
  )
  toolbar.append(gearBtn)
  // Log toggle: sits between the advanced (gear) and close actions and owns
  // the last-update log — the panel no longer renders that block unconditionally.
  const logBtn = iconButton('hqpu-icon-btn', LOG_ICON(16), copy.ui.logShow, () => {
    toggleLog()
  })
  logBtn.setAttribute('aria-pressed', 'false')
  logBtn.dataset.logToggle = ''
  toolbar.append(logBtn)
  const closeBtn = iconButton('hqpu-icon-btn', CLOSE_ICON(16), copy.close, () => {
    onClose()
  })
  toolbar.append(closeBtn)
  head.append(headMain, toolbar)
  panel.append(head)

  // ── Collapsible advanced settings panel (gear-toggled) ──
  const settingsPanel = el('div', 'hqpu-settings')
  panel.append(settingsPanel)

  // ── Scrolling body: the narrow column ──
  const scroll = el('div', 'hqpu-scroll')
  const column = el('div', 'hqpu-column')
  // The durable-job view leads: an active install/runtime update is resumed on
  // open BEFORE anything else. A settled job's log only appears when the header
  // toggle says so (see `logMode`) — it is one row per plugin, so leaving it
  // always-on pushed the actionable cards below the fold.
  const jobSection = el('div', 'hqpu-stack')
  const listSection = el('div', 'hqpu-stack')
  const runtimeSection = el('div', 'hqpu-stack')
  const toastSection = el('div', 'hqpu-toast-host')
  column.append(jobSection, listSection, runtimeSection, toastSection)
  scroll.append(column)
  panel.append(scroll)

  // ── Sticky footer ──
  const footer = el('div', 'hqpu-footer')
  const footMeta = el('div', 'hqpu-foot-meta')
  const footCount = el('span', '')
  const footSet = el('span', 'hqpu-foot-set')
  footMeta.append(footCount, footSet)
  const footActions = el('div', 'hqpu-foot-actions')
  const installAllBtn = el('button', 'hqpu-btn hqpu-btn--block')
  installAllBtn.type = 'button'
  const ignoreBtn = el('button', 'hqpu-btn--ignore', copy.ui.ignoreBtn)
  ignoreBtn.type = 'button'
  footActions.append(installAllBtn, ignoreBtn)
  const footnote = el('p', 'hqpu-footnote', copy.ui.footnote)
  footer.append(footMeta, footActions, footnote)
  panel.append(footer)

  overlay.append(scrim, panel)
  document.body.appendChild(overlay)
  toastHost = toastSection
  panel.focus()

  const disposers: Array<() => void> = []

  // ── Runtime update: arm → confirm, then hand off to hq-edge ──
  // Live in the panel's closure (not the report) because they are UI state, and
  // a store refresh must not silently disarm a confirm the user just armed.
  let runtimeArmed = false
  let runtimeBusy = false
  let runtimeAccepted = false

  // ── Panel-closure UI state (survive store refreshes) ──
  const changelogOpen = new Set<string>()
  let allOpen = false
  let settingsOpen = false
  let dismissedAlert = false

  /**
   * Last-update log drawer.
   *
   * `auto` keeps the log COLLAPSED for a routine successful install — its
   * per-component list is one row per plugin, so a full set was ~20 rows of
   * "ignored"/"blocked" sitting above every actionable card — but expands it on
   * its own when the last job failed, rolled back or was abandoned: that result
   * carries the error code and the Retry action, which must never hide behind a
   * click nobody knows to make. Once the person toggles the button their choice
   * wins for the rest of the panel's life.
   */
  let logMode: 'auto' | 'open' | 'closed' = 'auto'

  // Source-editor state, same reasoning: a background refresh must not discard
  // a half-typed URL or silently close either editor.
  const runtimeSourceState: SourceState = { editing: false, saving: false, draft: '' }
  const pluginSourceState: SourceState = { editing: false, saving: false, draft: '' }

  // Delegated, not spread: `...sourceActionsFor(...)` would evaluate the
  // getters once and freeze `sourceEditing: false` — the editor would never
  // open. Read every member through the live object instead.
  const runtimeSourceActions = sourceActionsFor('runtime', runtimeSourceState)
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
    get sourceEditing() {
      return runtimeSourceActions.sourceEditing
    },
    get sourceSaving() {
      return runtimeSourceActions.sourceSaving
    },
    get sourceDraft() {
      return runtimeSourceActions.sourceDraft
    },
    onSourceEdit: () => runtimeSourceActions.onSourceEdit(),
    onSourceDraft: (value: string) => runtimeSourceActions.onSourceDraft(value),
    onSourceSave: () => runtimeSourceActions.onSourceSave(),
    onSourceCancel: () => runtimeSourceActions.onSourceCancel(),
    onSourceReset: () => runtimeSourceActions.onSourceReset(),
  }

  const pluginActions: SourceEditorActions = sourceActionsFor('plugin', pluginSourceState)

  /** Build the {@link SourceEditorActions} half for one manifest source. */
  function sourceActionsFor(
    kind: SourceKind,
    state: SourceState,
  ): SourceEditorActions {
    return {
      get sourceEditing() {
        return state.editing
      },
      get sourceSaving() {
        return state.saving
      },
      get sourceDraft() {
        return state.draft
      },
      onSourceEdit: () => {
        // Prefill with the URL in effect, so 保存 is a no-op unless edited.
        const report = store.report()
        const source =
          kind === 'runtime' ? normalizeSource(report?.runtime.source) : normalizeSource(report?.pluginSource)
        state.draft = source?.url ?? ''
        state.editing = true
        render()
      },
      onSourceDraft: (value: string) => {
        state.draft = value
      },
      onSourceSave: () => {
        void submitSource(kind, state)
      },
      onSourceCancel: () => {
        state.editing = false
        render()
      },
      onSourceReset: () => {
        void submitSource(kind, state, '')
      },
    }
  }

  /**
   * Save one manifest source — or clear the override with an empty URL —
   * then re-run discovery.
   *
   * The re-check is not optional: the report is cached, so without a fresh
   * `POST /check` the facts and the update button would keep naming the OLD
   * manifest's offer after the source changed. hq-edge answers 422 with a
   * message meant for a person on refusal (bad scheme, credentials, …), which
   * the toast shows verbatim.
   */
  async function submitSource(
    kind: SourceKind,
    state: SourceState,
    url: string = state.draft,
  ): Promise<void> {
    state.saving = true
    render()
    const labels = kind === 'runtime' ? copy.runtime : copy.pluginSource
    try {
      if (kind === 'runtime') await setRuntimeUpdateSource(url)
      else await setPluginUpdateSource(url)
      state.editing = false
      showToast(labels.saved, 'success')
      try {
        await checkUpdates()
        await store.refresh()
      } catch {
        // The source IS saved; a failed re-check only leaves the previous
        // offer on screen until the next refresh — the toolbar re-runs it.
      }
    } catch (err: unknown) {
      showToast(
        `${labels.saveFailed}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      state.saving = false
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
      // relaunch. This panel is about to go away with the restart, so say so —
      // and latch it, so a store refresh cannot re-offer the button for a
      // server that is already gone.
      runtimeAccepted = true
      showToast(copy.runtime.updateAccepted, 'success')
      // Adopt the new durable job immediately so the active-job view renders
      // (it polls from here; this process is about to be swapped away anyway).
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
  const retryJob = (kind: 'plugin-set' | 'runtime'): void => {
    if (kind === 'runtime') {
      runtimeArmed = true
      render()
    } else {
      void runInstall(store, copy)
    }
  }

  /**
   * The settled job whose log the header toggle controls.
   *
   * Null in two cases, and both mean "the button has nothing to reveal": no job
   * has finished yet, or one is still running — a live job owns the panel with
   * its progress view, and its log only exists once it settles.
   */
  function logJob(): UpdateJob | null {
    const active = store.activeJob()
    if (active !== null && !TERMINAL_PHASES.has(active.phase)) return null
    const latest = store.recentJobs()[0]
    return latest !== undefined && TERMINAL_PHASES.has(latest.phase) ? latest : null
  }

  /** Is the log drawer expanded? The explicit choice first, then the auto rule. */
  function logVisible(job: UpdateJob | null): boolean {
    if (job === null) return false
    if (logMode === 'open') return true
    if (logMode === 'closed') return false
    return job.phase !== 'done'
  }

  function toggleLog(): void {
    const job = logJob()
    if (job === null) return
    logMode = logVisible(job) ? 'closed' : 'open'
    render()
  }

  const renderJobSection = (): void => {
    jobSection.textContent = ''
    const active = store.activeJob()
    if (active !== null && !TERMINAL_PHASES.has(active.phase)) {
      // An active job leads the panel — resumed on open, polled to its end.
      jobSection.append(activeJobView(active, copy))
      return
    }
    const log = logJob()
    if (log === null || !logVisible(log)) return
    jobSection.append(resultView(log, copy, () => retryJob(log.kind)))
    const older = recentJobsList(store.recentJobs(), copy)
    if (older !== null) jobSection.append(older)
  }

  const render = (): void => {
    const report = store.report()
    // The footer "installing" state is owned by the store flag OR any active
    // durable job — buttons stay disabled while either is true.
    const jobActive =
      store.activeJob() !== null && !TERMINAL_PHASES.has(store.activeJob()!.phase)
    const installing = store.installing() || jobActive
    const stale = report === null
    refreshBtn.disabled = stale
    refreshBtn.title = copy.refresh

    // Log toggle: enabled only when a settled job left a log to show, and
    // always labelled with what the NEXT click does.
    const log = logJob()
    const logShown = logVisible(log)
    logBtn.disabled = log === null
    logBtn.setAttribute('aria-pressed', logShown ? 'true' : 'false')
    const logLabel =
      log === null
        ? jobActive
          ? copy.ui.logBusy
          : copy.ui.logNone
        : logShown
          ? copy.ui.logHide
          : copy.ui.logShow
    logBtn.title = logLabel
    logBtn.setAttribute('aria-label', logLabel)

    // Header sub-line: "上次检查: N 分钟前" (from report.checkedAt).
    const ago = relativeAgo(report?.checkedAt, copy)
    sub.textContent = ago !== null ? copy.ui.checkedAgo(ago) : copy.ui.checkedUnknown

    // Collapsible advanced settings panel (gear-toggled): existing source
    // editors — plugin + runtime manifest URL override, save→check→refresh.
    renderSettingsPanel(settingsPanel, report, copy, settingsOpen, pluginActions, runtimeSourceActions)

    renderJobSection()
    if (stale) {
      listSection.textContent = ''
      listSection.append(skeleton(copy))
    } else {
      renderList(
        listSection,
        report,
        copy,
        changelogOpen,
        allOpen,
        (name) => {
          if (changelogOpen.has(name)) changelogOpen.delete(name)
          else changelogOpen.add(name)
          render()
        },
        () => {
          allOpen = !allOpen
          render()
        },
        () => {
          void store.check()
        },
        (name) => {
          void runInstall(store, copy, [name])
        },
        (item) => {
          const report = store.report()
          if (report?.manifestVersion === null || report?.manifestVersion === undefined) return
          const action = item.state === 'ignored'
            ? unignorePlugin(report.manifestVersion, item.name)
            : ignorePlugin(report.manifestVersion, item.name)
          // Same rule as the footer: discovery must re-run for the item to
          // come back as `ignored`, and a refusal has to be visible (this used
          // to be `.catch(() => undefined)`, which hid a 404 from the forwarder
          // and made the mute look applied when nothing had been written).
          void action
            .then(() => store.check())
            .catch((err: unknown) => {
              showToast(
                `${copy.ignoreError}: ${err instanceof Error ? err.message : String(err)}`,
                'error',
              )
            })
        },
      )
    }
    renderRuntime(runtimeSection, report, copy, runtimeActions, dismissedAlert, () => {
      dismissedAlert = true
      render()
    })
    renderFooter(footer, installAllBtn, ignoreBtn, footCount, footSet, report, copy, installing, store)
  }

  const unsubscribe = store.subscribe(render)
  disposers.push(unsubscribe)

  // Refresh on open (bounded; never block the shell).
  void store.refresh().then(() => {
    // Store notification re-renders already; nothing extra to do.
  })

  // Escape closes, the shell-wide dialog contract.
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      onClose()
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
    overlay.remove()
  }

  render()
}
