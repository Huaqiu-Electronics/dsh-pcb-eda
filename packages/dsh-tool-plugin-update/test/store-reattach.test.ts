// @vitest-environment jsdom
/**
 * The store's re-attach behaviour (`src/client/index.ts`).
 *
 * The panel can be installing the set that contains ITS OWN plugin. Activating
 * it restarts DSH, so the page loses its server mid-job and comes back to a
 * process that knows nothing about the job it was showing. Two things must
 * therefore be true, and neither is visible from the rendered view:
 *
 *   1. **Ask about the job you started.** `watchJob(id)` makes every later read
 *      `GET /activity?job=<id>`, which is the only question the new process can
 *      answer about a finished job.
 *   2. **Notice the server was replaced.** A changed `bootId` clears the
 *      install flag (it belongs to the old process) and re-reads the report, so
 *      the panel cannot stay "busy" against a server that never had the job.
 *   3. **Believe the job record, not just a state transition.** The install
 *      finished while DSH was restarting: the first read back already has an
 *      EMPTY active slot, so `wasActive && active === null` never fires. The
 *      terminal `job` returned by `/activity?job=<id>` must settle the flag,
 *      otherwise the footer stays "更新中" forever with only the 60 s report
 *      refresh left running (regression: hq-edge 0.6.23 / plugin 0.6.23).
 *
 * Plus the degradation path: an older hq-edge has no `/activity` at all, and the
 * store must fall back to `/status` instead of spinning forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginUpdateReport, UpdateJob } from '../src/client/api.js'

const mocks = vi.hoisted(() => ({
  fetchActivity: vi.fn(),
  fetchJobStatus: vi.fn(),
  fetchReport: vi.fn(),
  checkUpdates: vi.fn(),
}))

vi.mock('../src/client/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.js')>()
  return {
    ...actual,
    fetchActivity: mocks.fetchActivity,
    fetchJobStatus: mocks.fetchJobStatus,
    fetchReport: mocks.fetchReport,
    checkUpdates: mocks.checkUpdates,
  }
})

const { UpdateStore } = await import('../src/client/index.js')

function job(overrides: Partial<UpdateJob> = {}): UpdateJob {
  return {
    id: 'uj_1',
    kind: 'plugin-set',
    targetVersion: '0.6.14',
    previousVersion: '0.6.9',
    startedAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-29T08:00:10.000Z',
    phase: 'downloading',
    progress: { percent: 42 },
    ...overrides,
  }
}

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bootId: 'boot_a',
    startedAt: '2026-10-29T07:59:00.000Z',
    now: '2026-10-29T08:00:11.000Z',
    activeJob: job(),
    job: null,
    phaseAgeMs: 1000,
    stalled: false,
    setVersion: '0.6.9',
    actionableCount: 3,
    ...overrides,
  }
}

const EMPTY_REPORT = {
  checkedAt: '2026-10-29T08:00:00.000Z',
  lastError: null,
  manifestVersion: '0.6.14',
  actionableCount: 0,
  items: [],
  ignoredSet: false,
  pluginSource: { url: 'https://example.invalid/m.json', origin: 'config', configuredUrl: '', override: false },
  runtime: {
    configured: false,
    currentVersion: null,
    latest: null,
    updateAvailable: false,
    checkedAt: null,
    lastError: null,
    source: { url: '', origin: 'unset', configuredUrl: '', override: false },
    lastResult: null,
  },
} as unknown as PluginUpdateReport

let store: InstanceType<typeof UpdateStore>

beforeEach(() => {
  mocks.fetchActivity.mockReset()
  mocks.fetchJobStatus.mockReset()
  mocks.fetchReport.mockReset()
  mocks.checkUpdates.mockReset()
  mocks.fetchReport.mockResolvedValue(EMPTY_REPORT)
  mocks.fetchJobStatus.mockResolvedValue({ activeJob: null, recentJobs: [] })
  store = new UpdateStore()
})

afterEach(() => {
  store.stop()
})

describe('store re-attach', () => {
  it('asks /activity about the job it started', async () => {
    mocks.fetchActivity.mockResolvedValue(activity())

    store.watchJob('uj_1')
    await store.fetchStatus()

    expect(mocks.fetchActivity).toHaveBeenCalledWith('uj_1')
    expect(mocks.fetchJobStatus).not.toHaveBeenCalled()
    expect(store.activeJob()?.id).toBe('uj_1')
    expect(store.stalled()).toBe(false)
  })

  it('falls back to /status when the server has no /activity (older hq-edge)', async () => {
    mocks.fetchActivity.mockRejectedValue(new Error('not found'))
    mocks.fetchJobStatus.mockResolvedValue({ activeJob: job({ id: 'uj_9' }), recentJobs: [] })

    store.watchJob('uj_9')
    await store.fetchStatus()

    expect(mocks.fetchActivity).toHaveBeenCalled()
    expect(store.activeJob()?.id).toBe('uj_9')
  })

  it('treats a changed bootId as a replaced server and re-reads everything', async () => {
    mocks.fetchActivity.mockResolvedValueOnce(activity({ bootId: 'boot_a' }))
    store.watchJob('uj_1')
    await store.fetchStatus()
    store.setInstalling(true)
    expect(store.installing()).toBe(true)

    // hq-edge came back as a different process: our job is gone.
    mocks.fetchActivity.mockResolvedValueOnce(
      activity({ bootId: 'boot_b', activeJob: null, stalled: false, setVersion: '0.6.14' }),
    )
    await store.fetchStatus()

    expect(store.installing()).toBe(false)
    expect(store.activeJob()).toBeNull()
    // The report is re-read: the old one still lists the plugins that install.
    expect(mocks.fetchReport).toHaveBeenCalled()
    expect(store.stalled()).toBe(false)
  })

  it('clears the install flag once the followed job settles', async () => {
    mocks.fetchActivity.mockResolvedValueOnce(activity())
    store.watchJob('uj_1')
    store.setInstalling(true)
    await store.fetchStatus()

    mocks.fetchActivity.mockResolvedValueOnce(
      activity({ activeJob: null, job: job({ phase: 'done', result: { ok: true, installedVersion: '0.6.14', rolledBack: false, finishedAt: '2026-10-29T08:03:00.000Z' } }) }),
    )
    await store.fetchStatus()

    expect(store.installing()).toBe(false)
    expect(store.activeJob()).toBeNull()
    // The settled job stays in the local history for the log drawer.
    expect(store.recentJobs().map((entry) => entry.id)).toContain('uj_1')
    expect(mocks.fetchReport).toHaveBeenCalled()
  })

  it('surfaces a stalled job so the view can stop animating', async () => {
    mocks.fetchActivity.mockResolvedValue(
      activity({ activeJob: job({ phase: 'restarting', progress: { percent: 100 } }), phaseAgeMs: 240_000, stalled: true }),
    )
    store.watchJob('uj_1')
    await store.fetchStatus()

    expect(store.stalled()).toBe(true)
    expect(store.phaseAgeMs()).toBe(240_000)
    // Still following: the server settles the job on the next read.
    expect(store.activeJob()?.phase).toBe('restarting')
  })

  const settledJob = (overrides: Partial<UpdateJob> = {}): UpdateJob =>
    job({
      phase: 'done',
      result: {
        ok: true,
        installedVersion: '0.6.25',
        rolledBack: false,
        finishedAt: '2026-11-12T08:38:40.137Z',
      },
      ...overrides,
    })

  it('settles when the FIRST read after a DSH restart reports the watched job terminal', async () => {
    // The bug: active was already null (the page lost the job during the
    // restart), so there is no active → null transition to observe. Only the
    // durable `job` record proves the install finished.
    mocks.fetchActivity.mockResolvedValue(
      activity({ activeJob: null, job: settledJob(), bootId: 'boot_after_restart' }),
    )
    store.setInstalling(true)
    store.watchJob('uj_1')
    expect(store.installing()).toBe(true)

    await store.fetchStatus()

    expect(mocks.fetchActivity).toHaveBeenCalledWith('uj_1')
    expect(store.installing()).toBe(false)
    expect(store.activeJob()).toBeNull()
    expect(store.stalled()).toBe(false)
    // The settled record stays for the log drawer, and the report is re-read
    // so the footer can show the newly installed versions.
    expect(store.recentJobs().map((entry) => entry.id)).toContain('uj_1')
    expect(mocks.fetchReport).toHaveBeenCalled()

    // Polling stops AND the following id is dropped: no more /activity spam.
    await store.fetchStatus()
    expect(mocks.fetchActivity).toHaveBeenCalledTimes(1)
    expect(mocks.fetchJobStatus).toHaveBeenCalled()
  })

  it('ignores a terminal record belonging to a different job', async () => {
    mocks.fetchActivity.mockResolvedValue(
      activity({ activeJob: null, job: settledJob({ id: 'uj_other' }) }),
    )
    store.setInstalling(true)
    store.watchJob('uj_1')
    await store.fetchStatus()

    expect(store.installing()).toBe(true)
  })

  it('keeps following a watched job that is still running', async () => {
    mocks.fetchActivity.mockResolvedValue(
      activity({ activeJob: null, job: job({ phase: 'restarting' }) }),
    )
    store.setInstalling(true)
    store.watchJob('uj_1')
    await store.fetchStatus()

    expect(store.installing()).toBe(true)
    expect(store.recentJobs().map((entry) => entry.phase)).toContain('restarting')
  })

  it('settles from /status history when an older hq-edge has no /activity', async () => {
    mocks.fetchActivity.mockRejectedValue(new Error('not found'))
    mocks.fetchJobStatus.mockResolvedValue({
      activeJob: null,
      recentJobs: [settledJob()],
    })
    store.setInstalling(true)
    store.watchJob('uj_1')
    await store.fetchStatus()

    expect(store.installing()).toBe(false)
    expect(mocks.fetchReport).toHaveBeenCalled()
  })

  it('keeps the flag while the DSH forwarder is down (failed reads prove nothing)', async () => {
    mocks.fetchActivity.mockRejectedValue(new Error('forwarder down'))
    mocks.fetchJobStatus.mockRejectedValue(new Error('forwarder down'))
    store.setInstalling(true)
    store.watchJob(null)
    await store.fetchStatus()

    expect(store.installing()).toBe(true)
    expect(mocks.fetchReport).not.toHaveBeenCalled()
  })

  it('resets a stale installing flag on the mount/status-read path', async () => {
    // No job id came back and the state read finds no live job: nothing can
    // ever clear the flag but this fallback.
    store.setInstalling(true)
    store.watchJob(null)
    await store.fetchStatus()

    expect(store.installing()).toBe(false)
    expect(mocks.fetchReport).toHaveBeenCalled()
  })

  it('does NOT clear the flag while the install request is still in flight', async () => {
    // Between setInstalling(true) and watchJob(), /status legitimately has no
    // job yet — clearing here would re-enable the CTA mid-install.
    store.setInstalling(true)
    await store.fetchStatus()

    expect(store.installing()).toBe(true)
  })

  it('keeps the flag while a live job is active', async () => {
    mocks.fetchActivity.mockResolvedValue(activity({ activeJob: job(), job: null }))
    store.setInstalling(true)
    store.watchJob('uj_1')
    await store.fetchStatus()

    expect(store.installing()).toBe(true)
    expect(store.activeJob()?.id).toBe('uj_1')
  })

  it('abandons a re-attach that never answers (watchdog on the idle refresh)', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-12T08:38:00.000Z'))
      const doomed = new UpdateStore()
      doomed.setInstalling(true)
      doomed.watchJob('uj_1')
      expect(doomed.installing()).toBe(true)

      // Poll reads kept arriving with an empty active slot and no job record.
      // Two minutes later the 60 s idle refresh gives up on the flag.
      vi.setSystemTime(new Date('2026-11-12T08:40:01.000Z'))
      doomed.settleStaleInstall()

      expect(doomed.installing()).toBe(false)
      expect(mocks.fetchReport).toHaveBeenCalled()
      doomed.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps polling for the watched job while the re-attach window is open', async () => {
    vi.useFakeTimers()
    try {
      mocks.fetchActivity.mockResolvedValue(activity({ activeJob: null, job: null }))
      const pending = new UpdateStore()
      pending.setInstalling(true)
      pending.watchJob('uj_1')
      await pending.fetchStatus()
      expect(mocks.fetchActivity).toHaveBeenCalledTimes(1)
      expect(pending.installing()).toBe(true)

      // The old code stopped here because `active === null` — one lost read
      // ended the poll loop for good.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(mocks.fetchActivity).toHaveBeenCalledTimes(2)
      pending.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resyncs a freshly re-mounted panel once the restarted DSH answers', async () => {
    vi.useFakeTimers()
    try {
      // The replacement module starts with an empty store. Its first two
      // reads land while DSH is still coming back up.
      mocks.fetchReport
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockRejectedValueOnce(new Error('connection refused'))
      mocks.fetchJobStatus.mockResolvedValue({ activeJob: null, recentJobs: [] })

      const pending = store.resync(6, 1_000)
      await vi.runAllTimersAsync()
      await pending

      expect(mocks.fetchReport).toHaveBeenCalledTimes(3)
      expect(store.report()).toBe(EMPTY_REPORT)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the re-sync retries so a dead server cannot spin forever', async () => {
    vi.useFakeTimers()
    try {
      mocks.fetchReport.mockRejectedValue(new Error('connection refused'))
      mocks.fetchJobStatus.mockResolvedValue({ activeJob: null, recentJobs: [] })

      const pending = store.resync(3, 1_000)
      await vi.runAllTimersAsync()
      await pending

      expect(mocks.fetchReport).toHaveBeenCalledTimes(3)
      expect(store.report()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
