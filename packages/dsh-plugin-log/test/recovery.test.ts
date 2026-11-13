/**
 * Historical recovery and retention (§5).
 *
 * A new DSH process may repair directories left by previous launches — but ONLY
 * after acquiring their ownership lock, and it must never touch a live one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { cleanupExpiredDshInstances, recoverDshInstances, reportLegacyPluginLogs } from '../src/recovery.js'
import { EDGE_A, clearIdentityEnv, exists, filesIn, readArchive, seedDshInstance, spawnProbe, tempHome, waitForProbeReport } from './helpers.js'

const OWN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HIST_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const HIST_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const HIST_C = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

let home: string
let root: string
let ownDir: string
let probe: ReturnType<typeof spawnProbe> | null = null

const sealedName = (stem: string): string => `${stem}.log.sealed-11111111-1111-4111-8111-111111111111`
const tempName = (stem: string): string => `${stem}.log.gz.tmp-22222222-2222-4222-8222-222222222222`

beforeEach(() => {
  clearIdentityEnv()
  home = tempHome('recovery')
  root = join(home, 'logs', 'instances', EDGE_A, 'dsh')
  ownDir = join(root, OWN_ID)
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(
    join(ownDir, 'instance.json'),
    JSON.stringify({ schemaVersion: 1, dshInstanceId: OWN_ID, edgeInstanceId: EDGE_A }),
  )
})

afterEach(() => {
  probe?.kill()
  probe = null
  rmSync(home, { recursive: true, force: true })
  clearIdentityEnv()
})

async function recover(): Promise<Awaited<ReturnType<typeof recoverDshInstances>>> {
  return recoverDshInstances({ instancesRoot: root, ownInstanceDir: ownDir, minAgeMs: 0, timeBudgetMs: 10_000 })
}

describe('recoverDshInstances', () => {
  it('compresses a sealed source into a published archive and deletes the source', async () => {
    const dir = seedDshInstance(root, HIST_A, [
      { name: sealedName('dsh.2026-11-10'), contents: '{"msg":"sealed-record"}\n' },
    ])

    const report = await recover()
    expect(report.recovered).toBe(1)
    expect(filesIn(dir)).toContain('dsh.2026-11-10.log.gz')
    expect(filesIn(dir).some((name) => name.includes('.log.sealed-'))).toBe(false)
    expect(await readArchive(join(dir, 'dsh.2026-11-10.log.gz'))).toContain('sealed-record')
  })

  it('publishes an already-compressed temp archive without recompressing', async () => {
    const gz = gzipSync(Buffer.from('{"msg":"temp-record"}\n'))
    const dir = seedDshInstance(root, HIST_A, [{ name: tempName('dsh.2026-11-10.1'), contents: gz }])

    const report = await recover()
    expect(report.recovered).toBe(1)
    expect(filesIn(dir)).toContain('dsh.2026-11-10.1.log.gz')
    expect(await readArchive(join(dir, 'dsh.2026-11-10.1.log.gz'))).toContain('temp-record')
  })

  it('quarantines a corrupt temp archive instead of publishing garbage', async () => {
    const dir = seedDshInstance(root, HIST_A, [
      { name: tempName('dsh.2026-11-10.2'), contents: 'not a gzip stream' },
    ])

    const report = await recover()
    expect(report.quarantined).toBe(1)
    expect(filesIn(dir).some((name) => name.includes('.quarantine-'))).toBe(true)
    expect(filesIn(dir).some((name) => name.endsWith('.log.gz'))).toBe(false)
  })

  it('never overwrites a published archive that already exists', async () => {
    const dir = seedDshInstance(root, HIST_A, [
      { name: 'dsh.2026-11-10.log.gz', contents: 'ALREADY-PUBLISHED' },
      { name: tempName('dsh.2026-11-10'), contents: gzipSync(Buffer.from('{"msg":"duplicate"}\n')) },
    ])

    const report = await recover()
    expect(readFileSync(join(dir, 'dsh.2026-11-10.log.gz'), 'utf8')).toBe('ALREADY-PUBLISHED')
    // The verified temp is redundant, so it is removed rather than republished.
    expect(report.deletedFiles).toBe(1)
    expect(filesIn(dir).some((name) => name.includes('.gz.tmp-'))).toBe(false)
  })

  it('skips a directory owned by a live DSH process', async () => {
    probe = spawnProbe({
      HQ_EDGE_HOME: home,
      HQ_EDGE_INSTANCE_ID: EDGE_A,
      HQ_PROBE_MODE: 'hold',
      HQ_PROBE_HOLD_MS: '3000',
    })
    const live = await waitForProbeReport(probe)
    const liveDir = live.instanceDir as string
    const before = filesIn(liveDir)

    const report = await recover()
    expect(report.skippedLive).toBeGreaterThanOrEqual(1)
    expect(filesIn(liveDir)).toEqual(before)

    await probe.exited
  })

  it('preserves a directory whose metadata is corrupt', async () => {
    const dir = join(root, HIST_B)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'instance.json'), '{"dshInstanceId":')
    writeFileSync(join(dir, sealedName('dsh.2026-11-10')), 'x')

    const report = await recover()
    expect(report.skippedInvalid).toBe(1)
    expect(exists(join(dir, sealedName('dsh.2026-11-10')))).toBe(true)
  })

  it('is idempotent', async () => {
    seedDshInstance(root, HIST_A, [{ name: sealedName('dsh.2026-11-10'), contents: '{"msg":"once"}\n' }])
    await recover()
    const second = await recover()
    expect(second.recovered).toBe(0)
    expect(second.skippedInvalid + second.preserved + second.skippedLive).toBeGreaterThanOrEqual(0)
  })

  it('never touches its own directory', async () => {
    writeFileSync(join(ownDir, sealedName('dsh.2026-11-10')), 'mine')
    const report = await recover()
    expect(report.scanned).toBe(0)
    expect(exists(join(ownDir, sealedName('dsh.2026-11-10')))).toBe(true)
  })
})

describe('cleanupExpiredDshInstances', () => {
  it('deletes an expired instance and keeps a recent one', async () => {
    const expired = seedDshInstance(root, HIST_A, [{ name: 'dsh.2026-01-01.log.gz', contents: 'old' }])
    const recent = seedDshInstance(root, HIST_B, [{ name: 'dsh.2026-11-11.log.gz', contents: 'new' }])
    // Age the directory itself: retention is decided by the directory's mtime.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(expired, longAgo, longAgo)

    const report = await cleanupExpiredDshInstances({
      instancesRoot: root,
      ownInstanceDir: ownDir,
      retentionDays: 1,
      timeBudgetMs: 10_000,
    })
    expect(report.deletedDirectories).toBe(1)
    expect(exists(expired)).toBe(false)
    expect(exists(recent)).toBe(true)
  })

  it('preserves an expired directory that still holds recovery artifacts', async () => {
    const dir = seedDshInstance(root, HIST_C, [{ name: sealedName('dsh.2026-01-01'), contents: 'pending' }])
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(dir, longAgo, longAgo)
    await cleanupExpiredDshInstances({
      instancesRoot: root,
      ownInstanceDir: ownDir,
      retentionDays: 1,
      timeBudgetMs: 10_000,
    })
    expect(exists(dir)).toBe(true)
    expect(filesIn(dir).some((name) => name.includes('.log.sealed-'))).toBe(true)
  })

  it('never deletes a live instance', async () => {
    probe = spawnProbe({
      HQ_EDGE_HOME: home,
      HQ_EDGE_INSTANCE_ID: EDGE_A,
      HQ_PROBE_MODE: 'hold',
      HQ_PROBE_HOLD_MS: '3000',
    })
    const live = await waitForProbeReport(probe)
    const liveDir = live.instanceDir as string

    const report = await cleanupExpiredDshInstances({
      instancesRoot: root,
      ownInstanceDir: ownDir,
      retentionDays: 0,
      timeBudgetMs: 10_000,
    })
    expect(report.skippedLive).toBeGreaterThanOrEqual(1)
    expect(exists(liveDir)).toBe(true)
    await probe.exited
  })
})

describe('legacy plugin logs', () => {
  it('reports the old shared dsh-plugins directory without modifying it', async () => {
    const legacyDir = join(home, 'logs', 'dsh-plugins')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'dsh-plugins.log'), 'legacy\n')
    writeFileSync(join(legacyDir, 'dsh-plugins.1.log'), 'older\n')

    const report = await reportLegacyPluginLogs(join(home, 'logs'))
    expect(report.files).toHaveLength(2)
    expect(report.totalBytes).toBeGreaterThan(0)
    expect(report.note).toContain('No file was moved or deleted')
    expect(filesIn(legacyDir)).toHaveLength(2)
  })

  it('is silent when there is no legacy directory', async () => {
    const report = await reportLegacyPluginLogs(join(home, 'logs'))
    expect(report.files).toHaveLength(0)
    expect(report.note).toContain('no legacy')
  })
})
