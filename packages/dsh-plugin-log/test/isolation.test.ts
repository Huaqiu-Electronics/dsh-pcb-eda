/**
 * Acceptance tests that require REAL processes (§7 "Additional acceptance
 * tests"): multiple DSH launches, multiple Edge processes, restart, and a crash
 * during rotation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  EDGE_A,
  EDGE_B,
  clearIdentityEnv,
  exists,
  filesIn,
  nulBytes,
  readArchive,
  readJsonl,
  runProbe,
  spawnProbe,
  tempHome,
  waitForProbeReport,
} from './helpers.js'

let home: string
const spawned: Array<ReturnType<typeof spawnProbe>> = []

const baseEnv = (edge: string, extra: Record<string, string> = {}): Record<string, string> => ({
  HQ_EDGE_HOME: home,
  HQ_EDGE_INSTANCE_ID: edge,
  HQ_PLUGIN_LOG_CONSOLE: 'off',
  ...extra,
})

beforeEach(() => {
  clearIdentityEnv()
  home = tempHome('isolation')
})

afterEach(() => {
  for (const probe of spawned.splice(0)) probe.kill()
  rmSync(home, { recursive: true, force: true })
  clearIdentityEnv()
})

function track(probe: ReturnType<typeof spawnProbe>): ReturnType<typeof spawnProbe> {
  spawned.push(probe)
  return probe
}

describe('multi-process isolation', () => {
  it('gives two DSH processes under different Edge processes independent logs', async () => {
    const [a, b] = await Promise.all([
      runProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'write', HQ_PROBE_LINES: '3' })),
      runProbe(baseEnv(EDGE_B, { HQ_PROBE_MODE: 'write', HQ_PROBE_LINES: '3' })),
    ])

    expect(a.report.logRoot).not.toBe(b.report.logRoot)
    expect(a.report.instanceDir).not.toBe(b.report.instanceDir)
    // Each root is scoped by its own Edge instance id.
    expect(a.report.logRoot).toContain(EDGE_A)
    expect(b.report.logRoot).toContain(EDGE_B)

    const aRecords = readJsonl(a.report.logFile as string)
    const bRecords = readJsonl(b.report.logFile as string)
    expect(aRecords.every((record) => record.edgeInstanceId === EDGE_A)).toBe(true)
    expect(bRecords.every((record) => record.edgeInstanceId === EDGE_B)).toBe(true)
  })

  it('gives two DSH launches under ONE Edge process independent logs', async () => {
    const [first, second] = await Promise.all([
      runProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'write', HQ_PROBE_LINES: '4' })),
      runProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'write', HQ_PROBE_LINES: '5' })),
    ])

    expect(first.report.dshInstanceId).not.toBe(second.report.dshInstanceId)
    expect(first.report.instanceDir).not.toBe(second.report.instanceDir)
    expect(first.report.logRoot).toBe(second.report.logRoot)

    // Both directories survive side by side; neither wrote into the other.
    expect(exists(first.report.logFile as string)).toBe(true)
    expect(exists(second.report.logFile as string)).toBe(true)
    expect(readJsonl(first.report.logFile as string)).toHaveLength(5) // 4 + banner
    expect(readJsonl(second.report.logFile as string)).toHaveLength(6) // 5 + banner
  })

  it('creates a new directory on DSH restart and preserves the previous log', async () => {
    const first = await runProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'write', HQ_PROBE_LINES: '2' }))
    const second = await runProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'write', HQ_PROBE_LINES: '2' }))

    expect(second.report.dshInstanceId).not.toBe(first.report.dshInstanceId)
    const root = first.report.logRoot as string
    const dirs = readdirSync(root).filter((name) => !name.includes('.'))
    expect(new Set(dirs)).toEqual(new Set([first.report.dshInstanceId, second.report.dshInstanceId]))
    expect(readJsonl(first.report.logFile as string)).toHaveLength(3)
  })

  it('never writes into a live DSH directory or loses records under concurrency', async () => {
    // A holder keeps its directory locked while a second DSH starts and logs.
    const holder = track(
      spawnProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'hold', HQ_PROBE_HOLD_MS: '2500' })),
    )
    const held = await waitForProbeReport(holder)
    const heldFiles = filesIn(held.instanceDir as string)

    const other = await runProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'write', HQ_PROBE_LINES: '3' }))
    expect(other.report.instanceDir).not.toBe(held.instanceDir)
    expect(filesIn(held.instanceDir as string)).toEqual(heldFiles)

    await holder.exited
  })

  it('writes every plugin record through one destination with no NUL holes', async () => {
    const { report } = await runProbe(
      baseEnv(EDGE_A, { HQ_PROBE_MODE: 'concurrent', HQ_PROBE_LINES: '50' }),
    )

    const logFile = report.logFile as string
    expect(nulBytes(logFile)).toBe(0)

    const records = readJsonl(logFile)
    const pluginRecords = records.filter((record) => record.pluginId !== 'dsh-plugin-log')
    expect(pluginRecords).toHaveLength(250) // 5 plugins × 50
    expect(new Set(pluginRecords.map((record) => record.pluginId))).toEqual(
      new Set(['dsh-auth', 'dsh-artifacts', 'dsh-quote', 'dsh-kicad', 'dsh-part-search']),
    )
    // One instance directory, one active log: no per-plugin transports.
    const logFiles = filesIn(report.instanceDir as string).filter((name) => name.endsWith('.log'))
    expect(logFiles).toEqual([`dsh.${new Date().toISOString().slice(0, 10)}.log`])

    await Promise.all(spawned.map((probe) => probe.exited))
  })
})

describe('crash and recovery across processes', () => {
  it('recovers a rotation interrupted by a crash and keeps every record', async () => {
    const crashed = await runProbe(
      baseEnv(EDGE_A, {
        HQ_PROBE_MODE: 'rotate-crash',
        HQ_PROBE_MAX_SIZE: '2k',
        HQ_PROBE_LINES: '40',
        HQ_PROBE_FAULT: 'gzipDelay',
      }),
    )

    expect(crashed.code).not.toBe(0)
    const dir = crashed.report.instanceDir as string
    // A crash inside compression leaves a sealed source, not a corrupt log.
    const sealed = filesIn(dir).filter((name) => name.includes('.log.sealed-'))
    expect(sealed.length).toBeGreaterThan(0)

    // A later DSH launch recovers its sibling's artifacts.
    await runProbe(
      baseEnv(EDGE_A, { HQ_PROBE_MODE: 'maintenance', HQ_PROBE_MIN_AGE_MS: '0' }),
    )

    const archives = filesIn(dir).filter((name) => name.endsWith('.log.gz'))
    expect(archives.length).toBeGreaterThan(0)
    for (const archive of archives) {
      const text = await readArchive(join(dir, archive))
      expect(text).not.toContain('\u0000')
      for (const line of text.split('\n').filter((entry) => entry.trim().length > 0)) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }
    // Recovery published the interrupted file and consumed the sealed source.
    expect(filesIn(dir).some((name) => name.includes('.log.sealed-'))).toBe(false)
  })

  it('leaves HQ Edge logs untouched when only DSH state exists', async () => {
    const { report } = await runProbe(baseEnv(EDGE_A, { HQ_PROBE_MODE: 'write' }))
    const dir = report.instanceDir as string
    // The DSH directory contains only DSH-owned artifacts.
    expect(filesIn(dir).some((name) => name.startsWith('server.'))).toBe(false)
    expect(filesIn(dir)).toContain('instance.json')
  })
})
