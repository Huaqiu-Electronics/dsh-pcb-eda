/**
 * Asynchronous rotation, archive publication and failure preservation (§5).
 *
 * Every test drives the PUBLIC api: a plugin logs a lot, the destination
 * rotates underneath it, and no record is lost or corrupted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  configureLogging,
  flushLogs,
  getLoggingHealth,
  getLogger,
  logDir,
  resetLogging,
  todayString,
} from '../src/index.js'
import type { DshRotationFaults } from '../src/rotation.js'
import { EDGE_A, EDGE_B, clearIdentityEnv, filesIn, readArchive, tempHome } from './helpers.js'

const RECORD_PAYLOAD = 'x'.repeat(200)

let home: string
let clock: Date

beforeEach(async () => {
  await resetLogging()
  clearIdentityEnv()
  home = tempHome('rotation')
  process.env.HQ_EDGE_HOME = home
  process.env.HQ_EDGE_INSTANCE_ID = EDGE_A
  clock = new Date('2026-11-10T10:00:00.000Z')
})

afterEach(async () => {
  await resetLogging()
  clearIdentityEnv()
  rmSync(home, { recursive: true, force: true })
})

function configure(extra: { maxSize?: string; faults?: DshRotationFaults; now?: () => Date } = {}): void {
  configureLogging({
    level: 'debug',
    consoleLevel: 'off',
    dshInstanceId: EDGE_B,
    maxSize: extra.maxSize ?? '2k',
    retentionDays: 14,
    faults: extra.faults,
    now: extra.now ?? (() => clock),
  })
}

function archives(dir: string): string[] {
  return filesIn(dir).filter((name) => name.endsWith('.log.gz'))
}

function artifacts(dir: string): string[] {
  return filesIn(dir).filter((name) => name.includes('.log.sealed-') || name.includes('.gz.tmp-'))
}

function write(count: number, prefix = 'record'): void {
  const log = getLogger('dsh-auth')
  for (let i = 0; i < count; i += 1) log.info(`${prefix} ${i}`, { index: i, payload: RECORD_PAYLOAD })
}

describe('size rotation', () => {
  it('publishes readable gzip archives without losing or duplicating records', async () => {
    configure()
    write(40)
    await flushLogs()

    const dir = logDir() as string
    const published = archives(dir)
    expect(published.length).toBeGreaterThan(0)

    for (const archive of published) {
      const restored = await readArchive(join(dir, archive))
      expect(restored).not.toContain('\u0000')
      // Every archived line is still a complete JSON record.
      for (const line of restored.split('\n').filter((entry) => entry.trim().length > 0)) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }

    // Active file + archives together must contain every record exactly once.
    const activePath = join(dir, `dsh.${todayString(clock)}.log`)
    const sources = [readFileSync(activePath, 'utf8')]
    for (const archive of published) sources.push(await readArchive(join(dir, archive)))

    const indices = sources
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => typeof record.index === 'number')
      .map((record) => record.index as number)

    expect(indices.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i))
    expect(artifacts(dir)).toHaveLength(0)
  })

  it('never overwrites an archive when the same size threshold is crossed again', async () => {
    configure()
    write(160)
    await flushLogs()

    const dir = logDir() as string
    const published = archives(dir)
    expect(published.length).toBeGreaterThanOrEqual(2)
    expect(new Set(published).size).toBe(published.length)
    // The old `.gz.N` collision-chain naming is gone for good.
    expect(published.some((name) => /\.log\.gz\.\d+$/.test(name))).toBe(false)
  })

  it('reports the rotation count in health', async () => {
    configure()
    write(60)
    await flushLogs()
    expect(getLoggingHealth().rotationCount).toBeGreaterThan(0)
  })
})

describe('date rotation', () => {
  it('archives the previous day and publishes the new day', async () => {
    const dayOne = new Date('2026-11-10T10:00:00.000Z')
    const dayTwo = new Date('2026-11-11T10:00:00.000Z')
    let now = dayOne
    configure({ maxSize: '1g', now: () => now })

    write(3, 'day-one')
    await flushLogs()

    now = dayTwo
    write(3, 'day-two')
    await flushLogs()

    const dir = logDir() as string
    const restored = await readArchive(join(dir, 'dsh.2026-11-10.log.gz'))
    expect(restored).toContain('day-one 0')
    expect(readFileSync(join(dir, 'dsh.2026-11-11.log'), 'utf8')).toContain('day-two 2')
  })

  it('never overwrites an existing archive from an earlier run', async () => {
    configure({ maxSize: '1g' })

    // Run 1: a full day of records, then a rollover publishes the archive.
    write(2, 'first-run')
    await flushLogs()
    const dir = logDir() as string
    clock = new Date('2026-11-11T10:00:00.000Z')
    write(1, 'second-run')
    await flushLogs()

    const existing = join(dir, 'dsh.2026-11-10.log.gz')
    expect(filesIn(dir)).toContain('dsh.2026-11-10.log.gz')
    // Stand in for "an archive already published by an earlier run".
    writeFileSync(existing, 'PRESERVED-ARCHIVE')

    // Run 2 into the same directory, rolling the same date over again.
    await resetLogging()
    clock = new Date('2026-11-10T10:00:00.000Z')
    configure({ maxSize: '1g' })
    write(2, 'third-run')
    await flushLogs()
    clock = new Date('2026-11-11T10:00:00.000Z')
    write(1, 'fourth-run')
    await flushLogs()

    expect(readFileSync(existing, 'utf8')).toBe('PRESERVED-ARCHIVE')
    const second = await readArchive(join(dir, 'dsh.2026-11-10.1.log.gz'))
    expect(second).toContain('third-run 0')
  })
})

describe('failure preservation', () => {
  it('publishes nothing and preserves the sealed source when publication fails', async () => {
    configure({ faults: { publish: true } })
    write(60)
    await flushLogs()

    const dir = logDir() as string
    expect(archives(dir)).toHaveLength(0)
    const leftovers = artifacts(dir)
    expect(leftovers.length).toBeGreaterThan(0)

    // The original data is still readable, not lost with the failed rotation.
    const sealed = leftovers.find((name) => name.includes('.log.sealed-')) as string | undefined
    if (sealed) {
      expect(readFileSync(join(dir, sealed), 'utf8')).toContain('record 0')
    }
    expect(getLoggingHealth().state).toBe('degraded')
  })

  it('preserves the sealed source when compression fails', async () => {
    configure({ faults: { gzip: true } })
    write(60)
    await flushLogs()

    const dir = logDir() as string
    expect(archives(dir)).toHaveLength(0)
    const sealed = artifacts(dir).filter((name) => name.includes('.log.sealed-'))
    expect(sealed.length).toBeGreaterThan(0)
    expect(readFileSync(join(dir, sealed[0] as string), 'utf8')).toContain('record 0')
  })

  it('continues on the active file when sealing fails', async () => {
    configure({ faults: { seal: true } })
    write(60)
    await flushLogs()

    const dir = logDir() as string
    expect(archives(dir)).toHaveLength(0)
    // Nothing was renamed away: the records are still in the active file.
    expect(readFileSync(join(dir, `dsh.${todayString(clock)}.log`), 'utf8')).toContain('record 0')
  })

  it('degrades instead of throwing when the device reports ENOSPC', async () => {
    configure({ faults: { diskFull: true } })
    const log = getLogger('dsh-auth')
    expect(() => {
      for (let i = 0; i < 20; i += 1) log.info(`record ${i}`, { payload: RECORD_PAYLOAD })
    }).not.toThrow()
    await flushLogs()
    // The ENOSPC surfaces asynchronously, exactly like a real full disk.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const health = getLoggingHealth()
    expect(['degraded', 'unavailable']).toContain(health.state)
    expect(health.lastError ?? '').toContain('ENOSPC')
  })

  it('degrades instead of throwing when the active stream cannot be opened', async () => {
    configure({ faults: { streamOpen: true } })
    const log = getLogger('dsh-auth')
    expect(() => log.info('still safe')).not.toThrow()
    await flushLogs()
    expect(getLoggingHealth().state).toBe('unavailable')
  })
})
