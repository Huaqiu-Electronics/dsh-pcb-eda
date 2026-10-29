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
})
