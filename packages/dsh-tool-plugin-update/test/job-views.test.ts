// @vitest-environment jsdom
/**
 * Tests for the durable update-job half of the panel:
 *
 *  - `normalizeJob` / `normalizeJobStatus` defensively turn the wire payload
 *    (which older/partial servers may send) into a safe projection, clamping
 *    percentages and falling back for unknown phases.
 *  - The active-job view leads the panel when the store reports an active
 *    job: phase text, a determinate bar sized to `progress.percent`, and the
 *    honest "closing does not cancel" note.
 *  - A failed check renders an error row with a Retry action, never the
 *    silent "no updates available" empty state.
 *  - A terminal job lands in a result view with retry guidance.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeJob,
  normalizeJobStatus,
  TERMINAL_PHASES,
  type PluginUpdateReport,
  type UpdateJob,
} from '../src/client/api.js'
import { COPY } from '../src/client/copy.js'
import { openUpdateView, type UpdateStoreLike } from '../src/client/update-view.js'

const zh = COPY.zh

function job(overrides: Partial<UpdateJob> = {}): UpdateJob {
  return {
    id: 'job-1',
    kind: 'plugin-set',
    targetVersion: '0.6.7',
    previousVersion: '0.6.6',
    startedAt: '2026-10-23T02:00:00.000Z',
    updatedAt: '2026-10-23T02:00:10.000Z',
    phase: 'downloading',
    progress: { percent: 42 },
    ...overrides,
  }
}

function report(overrides: Partial<PluginUpdateReport> = {}): PluginUpdateReport {
  return {
    manifestVersion: '0.6.6',
    items: [],
    actionableCount: 0,
    ignoredSet: false,
    runtime: {
      configured: true,
      currentVersion: '0.2.11',
      latest: null,
      updateAvailable: false,
      checkedAt: '2026-10-23T01:00:00.000Z',
      lastError: null,
    },
    ...overrides,
  }
}

function storeFor(
  reportValue: PluginUpdateReport,
  active: UpdateJob | null,
  recent: UpdateJob[],
): UpdateStoreLike {
  return {
    report: () => reportValue,
    installing: () => false,
    setInstalling: () => undefined,
    activeJob: () => active,
    recentJobs: () => recent,
    refresh: async () => reportValue,
    check: async () => reportValue,
    fetchStatus: async () => undefined,
    subscribe: () => () => undefined,
  }
}

afterEach(() => {
  document.querySelector('[data-hq-plugin-update-view]')?.remove()
})

describe('normalizeJob', () => {
  it('normalizes a full wire payload', () => {
    const out = normalizeJob({
      id: 'job-9',
      kind: 'runtime',
      targetVersion: '0.3.10',
      previousVersion: '0.3.9',
      startedAt: 's',
      updatedAt: 'u',
      phase: 'downloading',
      message: 'fetching bundle',
      progress: { percent: 50, bytesDone: 1048576, bytesTotal: 2097152 },
      steps: [{ name: 'sha256', state: 'running', percent: 50 }],
    })
    expect(out).not.toBeNull()
    expect(out?.kind).toBe('runtime')
    expect(out?.progress.percent).toBe(50)
    expect(out?.progress.bytesDone).toBe(1048576)
    expect(out?.steps?.[0]?.state).toBe('running')
  })

  it('clamps percent and falls back to queued for an unknown phase', () => {
    const out = normalizeJob({
      id: 'j',
      phase: 'mystery-phase',
      progress: { percent: 250 },
    })
    expect(out?.phase).toBe('queued')
    expect(out?.progress.percent).toBe(100)
  })

  it('returns null for a payload without an id', () => {
    expect(normalizeJob({ phase: 'downloading' })).toBeNull()
    expect(normalizeJob(null)).toBeNull()
  })

  it('normalizeJobStatus degrades an empty body to no active job', () => {
    expect(normalizeJobStatus(null)).toEqual({ activeJob: null, recentJobs: [] })
    expect(normalizeJobStatus({}).activeJob).toBeNull()
  })

  it('exposes the terminal phase set', () => {
    expect(TERMINAL_PHASES.has('done')).toBe(true)
    expect(TERMINAL_PHASES.has('downloading')).toBe(false)
  })
})

describe('active-job view', () => {
  it('renders the leading active-job card with phase text and a sized bar', () => {
    const active = job({
      progress: { percent: 42, bytesDone: 2097152, bytesTotal: 10485760, bytesPerSecond: 524288 },
    })
    openUpdateView(storeFor(report(), active, []), zh)
    const view = document.querySelector<HTMLElement>('[data-hq-plugin-update-view]')
    expect(view).not.toBeNull()
    const jobSection = view!.querySelector('[data-group="active-job"]')
    expect(jobSection).not.toBeNull()
    // Phase in human words, version transition.
    expect(jobSection!.textContent).toContain(zh.job.phase.downloading)
    expect(jobSection!.textContent).toContain('0.6.6 → 0.6.7')
    // Determinate bar sized to the real percentage (never 100% early).
    const fill = jobSection!.querySelector<HTMLElement>('.hqpu-progress-fill')
    expect(fill).not.toBeNull()
    expect(fill!.style.width).toBe('42%')
    // "Closing the panel does not cancel" is stated.
    expect(view!.textContent).toContain(zh.ui.activeCloseNote)
  })

  it('does not render a progress bar when the server gives no percentage', () => {
    openUpdateView(storeFor(report(), job({ progress: { percent: null } }), []), zh)
    const view = document.querySelector<HTMLElement>('[data-hq-plugin-update-view]')
    expect(view!.querySelector('.hqpu-progress')).toBeNull()
  })
})

describe('active-job banner 4-step indicator', () => {
  /** step classes per phase: done=emerald, active=pulsing brand, upcoming=muted. */
  function stepClasses(phase: UpdateJob['phase']): string[] {
    openUpdateView(storeFor(report(), job({ phase, progress: { percent: 30 } }), []), zh)
    const view = document.querySelector<HTMLElement>('[data-hq-plugin-update-view]')!
    return [...view.querySelectorAll('.hqpu-job-steps4 > *')].map((n) => n.className)
  }

  afterEach(() => {
    document.querySelector('[data-hq-plugin-update-view]')?.remove()
  })

  it('downloading marks step 0 active and the rest upcoming', () => {
    expect(stepClasses('downloading')).toEqual([
      'hqpu-job-step--active',
      'hqpu-job-step--todo',
      'hqpu-job-step--todo',
      'hqpu-job-step--todo',
    ])
  })

  it('verifying marks step 0 done and step 1 active', () => {
    expect(stepClasses('verifying')).toEqual([
      'hqpu-job-step--done',
      'hqpu-job-step--active',
      'hqpu-job-step--todo',
      'hqpu-job-step--todo',
    ])
  })

  it('restarting marks steps 0-2 done and step 3 active', () => {
    expect(stepClasses('restarting')).toEqual([
      'hqpu-job-step--done',
      'hqpu-job-step--done',
      'hqpu-job-step--done',
      'hqpu-job-step--active',
    ])
  })

  it('queued leaves every step upcoming (no step has started)', () => {
    expect(stepClasses('queued')).toEqual([
      'hqpu-job-step--todo',
      'hqpu-job-step--todo',
      'hqpu-job-step--todo',
      'hqpu-job-step--todo',
    ])
  })
})

describe('check-status banner', () => {
  it('shows an error row with Retry and hides the empty "no updates" state on a failed check', () => {
    const failed = report({ lastError: 'manifest fetch timed out', items: [] })
    openUpdateView(storeFor(failed, null, []), zh)
    const view = document.querySelector<HTMLElement>('[data-hq-plugin-update-view]')
    expect(view!.textContent).toContain('manifest fetch timed out')
    expect(view!.textContent).toContain(zh.retryNow)
    // The silent success-empty state must NOT appear alongside a failure.
    expect(view!.textContent).not.toContain(zh.empty)
    expect(view!.querySelector('[data-group="check-status"]')).not.toBeNull()
  })
})

describe('result view', () => {
  it('renders a terminal failed job as a result card with retry guidance', () => {
    const failed = job({
      id: 'job-2',
      phase: 'failed',
      result: { ok: false, installedVersion: null, errorCode: 'CHECKSUM_MISMATCH', message: 'hash mismatch', rolledBack: true, finishedAt: '2026-10-23T02:05:00.000Z' },
    })
    openUpdateView(storeFor(report(), null, [failed]), zh)
    const view = document.querySelector<HTMLElement>('[data-hq-plugin-update-view]')
    const result = view!.querySelector('[data-group="job-result"]')
    expect(result).not.toBeNull()
    expect(result!.textContent).toContain(zh.job.resultFailed)
    expect(result!.textContent).toContain('CHECKSUM_MISMATCH')
    // Retry starts a NEW job — copy must say so, not "install again".
    expect(result!.textContent).toContain(zh.job.retry)
  })
})
