/**
 * Regression tests for the sidebar update-count badge (`src/client/badge.ts`).
 *
 * What the badge must answer: how many updates are still on offer — the
 * actionable plugin items PLUS one for a pending HQ Edge runtime update.
 *
 * And what it must never do: never come back to life from history. Two earlier
 * versions of this rule were wrong in opposite directions — it counted a
 * settled job (durable history, so "1" latched on forever, even after a
 * successful install) and it ignored the runtime offer (so a pending runtime
 * upgrade was invisible until the panel was opened). Both are pinned below.
 */
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_PHASES,
  runtimeUpdateOffered,
  type PluginUpdateItem,
  type PluginUpdateReport,
  type RuntimeUpdateInfo,
  type UpdateJob,
  type UpdatePhase,
} from '../src/client/api.js'
import { badgeCountFor } from '../src/client/badge.js'
import { actionableUpdateCount } from '../src/client/version.js'

function item(
  name: string,
  state: PluginUpdateItem['state'],
  extra: Partial<PluginUpdateItem> = {},
): PluginUpdateItem {
  return {
    name,
    currentVersion: '0.6.9',
    availableVersion: '0.6.10',
    state,
    ...extra,
  }
}

function runtime(overrides: Partial<RuntimeUpdateInfo> = {}): RuntimeUpdateInfo {
  return { configured: true, updateAvailable: false, ...overrides }
}

/** A pending runtime offer, shaped exactly as hq-edge sends it (an entry, not
 *  a bare version string). */
function runtimeAvailable(): RuntimeUpdateInfo {
  return runtime({
    currentVersion: '0.6.9',
    updateAvailable: true,
    latest: {
      version: '0.6.10',
      sha256: 'a'.repeat(64),
      platform: 'darwin',
      url: 'https://example.invalid/edge.zip',
    },
  })
}

function report(overrides: Partial<PluginUpdateReport> = {}): PluginUpdateReport {
  return {
    manifestVersion: '0.6.10',
    items: [],
    actionableCount: 0,
    ignoredSet: false,
    runtime: runtime(),
    ...overrides,
  }
}

function job(phase: UpdatePhase): UpdateJob {
  return {
    id: `job-${phase}`,
    kind: 'plugin-set',
    targetVersion: '0.6.10',
    previousVersion: '0.6.9',
    startedAt: '2026-10-29T06:00:00.000Z',
    updatedAt: '2026-10-29T06:01:00.000Z',
    phase,
    progress: { percent: null },
  }
}

describe('actionableUpdateCount — the PLUGIN-set number', () => {
  it('counts compatible update + install items only', () => {
    const r = report({
      items: [
        item('a', 'update'),
        item('b', 'install', { currentVersion: null }),
        item('c', 'current'),
        item('d', 'blocked'),
      ],
    })
    expect(actionableUpdateCount(r)).toBe(2)
  })

  it('is zero once the whole offer is ignored', () => {
    const r = report({
      ignoredSet: true,
      // A newer hq-edge also demotes the items; an older one only sets the flag.
      items: [item('a', 'ignored'), item('b', 'ignored')],
    })
    expect(actionableUpdateCount(r)).toBe(0)
    expect(
      actionableUpdateCount(report({ ignoredSet: true, items: [item('a', 'update')] })),
    ).toBe(0)
  })

  it('skips individually ignored items even when the server left them actionable', () => {
    const r = report({ items: [item('a', 'update', { ignored: true }), item('b', 'update')] })
    expect(actionableUpdateCount(r)).toBe(1)
  })

  it('never includes the runtime offer — that number is the footer plugin count', () => {
    const r = report({ items: [item('a', 'update')], runtime: runtimeAvailable() })
    expect(actionableUpdateCount(r)).toBe(1)
  })

  it('is zero for a null/empty report', () => {
    expect(actionableUpdateCount(null)).toBe(0)
    expect(actionableUpdateCount(report())).toBe(0)
  })
})

describe('runtimeUpdateOffered', () => {
  it('is true only for an offer the panel can actually render', () => {
    expect(runtimeUpdateOffered(runtimeAvailable())).toBe(true)
    expect(runtimeUpdateOffered(runtime())).toBe(false)
    // Flag set but no entry to install from → nothing to count.
    expect(runtimeUpdateOffered(runtime({ updateAvailable: true, latest: null }))).toBe(false)
    expect(runtimeUpdateOffered(null)).toBe(false)
    expect(runtimeUpdateOffered(undefined)).toBe(false)
  })
})

describe('badgeCountFor — offers only, never history', () => {
  it('shows the number of actionable plugin updates', () => {
    const r = report({ items: [item('a', 'update'), item('b', 'install')] })
    expect(badgeCountFor(r, null)).toBe(2)
  })

  it('counts a pending runtime update as one more', () => {
    expect(badgeCountFor(report({ runtime: runtimeAvailable() }), null)).toBe(1)
    const r = report({ items: [item('a', 'update'), item('b', 'update')], runtime: runtimeAvailable() })
    expect(badgeCountFor(r, null)).toBe(3)
  })

  it('keeps the runtime offer after the plugin offer is ignored', () => {
    // Muting this release set must not hide a newer HQ Edge runtime.
    const r = report({
      ignoredSet: true,
      items: [item('a', 'ignored'), item('b', 'ignored')],
      runtime: runtimeAvailable(),
    })
    expect(badgeCountFor(r, null)).toBe(1)
  })

  it('drops to zero when nothing is offered — plugins installed AND runtime current', () => {
    // The exact reported bug: post-install report, finished job in history.
    const r = report({
      manifestVersion: '0.6.10',
      items: [item('a', 'current'), item('b', 'current')],
      runtime: runtime({ currentVersion: '0.6.10' }),
    })
    expect(badgeCountFor(r, null)).toBe(0)
  })

  it('stays at zero for EVERY terminal job phase, with nothing offered', () => {
    const terminal: UpdatePhase[] = ['done', 'failed', 'rolled-back', 'abandoned']
    for (const phase of terminal) {
      expect(TERMINAL_PHASES.has(phase)).toBe(true)
      // A terminal job handed back as "active" (a stale poll) must not count.
      expect(badgeCountFor(report(), job(phase))).toBe(0)
    }
  })

  it('still shows a running job when nothing is offered', () => {
    expect(badgeCountFor(report(), job('downloading'))).toBe(1)
    expect(badgeCountFor(null, job('queued'))).toBe(1)
  })

  it('does not let a running job mask a real remaining count', () => {
    const r = report({ items: [item('a', 'update'), item('b', 'update'), item('c', 'update')] })
    expect(badgeCountFor(r, job('downloading'))).toBe(3)
  })

  it('clears once the job settles, even though the job stays in history', () => {
    // Same snapshot, one poll apart: the running job is what carried the "1".
    expect(badgeCountFor(report(), job('verifying'))).toBe(1)
    expect(badgeCountFor(report(), null)).toBe(0)
  })
})
