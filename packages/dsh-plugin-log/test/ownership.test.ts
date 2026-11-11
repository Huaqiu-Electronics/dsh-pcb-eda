/**
 * Exclusive ownership of a DSH instance directory (§5).
 *
 * These tests use REAL processes: a lock that only works in-process would be
 * worthless against the failure that motivated it (two DSH processes writing
 * one file).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'

import { acquireDshOwnership, acquireHistoricalDshOwnership, probeDshOwnership } from '../src/ownership.js'
import { OWNER_LOCK_FILENAME } from '../src/identity.js'
import {
  EDGE_A,
  EDGE_B,
  clearIdentityEnv,
  exists,
  spawnProbe,
  tempHome,
  waitForProbeReport,
} from './helpers.js'
import { join } from 'node:path'

let home: string
let probe: ReturnType<typeof spawnProbe> | null = null

const probeEnv = (extra: Record<string, string>): Record<string, string> => ({
  HQ_EDGE_HOME: home,
  HQ_EDGE_INSTANCE_ID: EDGE_A,
  HQ_PLUGIN_LOG_CONSOLE: 'off',
  ...extra,
})

beforeEach(() => {
  clearIdentityEnv()
  home = tempHome('ownership')
})

afterEach(() => {
  probe?.kill()
  probe = null
  rmSync(home, { recursive: true, force: true })
  clearIdentityEnv()
})

describe('live ownership', () => {
  it('refuses a second owner while a DSH process holds the directory', async () => {
    probe = spawnProbe(probeEnv({ HQ_PROBE_MODE: 'hold', HQ_PROBE_HOLD_MS: '4000' }))
    const report = await waitForProbeReport(probe)
    const dir = report.instanceDir as string

    expect(report.ownership).toBe('held')
    // Another process (this test) must see the directory as owned.
    await expect(probeDshOwnership(dir)).resolves.toBe(false)
    // And a direct acquisition must fail rather than steal it.
    await expect(acquireDshOwnership(dir, 'other-owner')).resolves.toBeNull()

    await probe.exited
  })

  it('releases the lock when the owner exits without shutting down', async () => {
    probe = spawnProbe(probeEnv({ HQ_PROBE_MODE: 'hold-no-shutdown', HQ_PROBE_HOLD_MS: '400' }))
    const report = await waitForProbeReport(probe)
    const dir = report.instanceDir as string
    expect(await probeDshOwnership(dir)).toBe(false)

    await probe.exited

    // The OS closed the endpoint with the process: no PID check, no timeout.
    await expect(probeDshOwnership(dir)).resolves.toBe(true)
  })

  it('keeps owner.lock as a diagnostic that never blocks reacquisition', async () => {
    probe = spawnProbe(probeEnv({ HQ_PROBE_MODE: 'hold', HQ_PROBE_HOLD_MS: '300' }))
    const report = await waitForProbeReport(probe)
    const dir = report.instanceDir as string
    await probe.exited

    expect(exists(join(dir, OWNER_LOCK_FILENAME))).toBe(true)
    await expect(probeDshOwnership(dir)).resolves.toBe(true)
  })
})

describe('acquisition rules', () => {
  it('allows exactly one owner per directory inside one process', async () => {
    const dir = join(home, 'logs', 'instances', EDGE_A, 'dsh', EDGE_B)
    const first = await acquireDshOwnership(dir, EDGE_B)
    expect(first).not.toBeNull()

    const second = await acquireDshOwnership(dir, EDGE_B)
    expect(second).toBeNull()

    first?.release()
    const third = await acquireDshOwnership(dir, EDGE_B)
    expect(third).not.toBeNull()
    third?.release()
  })

  it('does not contend across different directories', async () => {
    const a = await acquireDshOwnership(join(home, 'a'), 'a')
    const b = await acquireDshOwnership(join(home, 'b'), 'b')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    a?.release()
    b?.release()
  })

  it('refuses to recreate a historical directory that no longer exists', async () => {
    await expect(acquireHistoricalDshOwnership(join(home, 'gone'), 'gone')).resolves.toBeNull()
    expect(exists(join(home, 'gone'))).toBe(false)
  })

  it('is idempotent on release', async () => {
    const handle = await acquireDshOwnership(join(home, 'idem'), 'idem')
    expect(handle).not.toBeNull()
    handle?.release()
    expect(() => handle?.release()).not.toThrow()
  })
})
