/**
 * Real-subprocess probe for the DSH logging isolation tests.
 *
 * Each mode runs in its own OS process so the tests can assert things a single
 * process cannot prove: that two DSH launches really do own different
 * directories, that an OS lock is released when a process dies without
 * shutting down, and that a crash during compression leaves a recoverable
 * artifact rather than a corrupt log.
 *
 * The probe prints exactly one machine-readable line:
 *   ##PROBE##{"mode":...,"instanceDir":...}
 */
import { readdirSync } from 'node:fs'

import {
  configureLogging,
  dshInstanceInfo,
  flushLogs,
  getLogger,
  runMaintenance,
  shutdownLogging,
} from '../../src/index.js'

const mode = process.env.HQ_PROBE_MODE ?? 'write'
const recordCount = Number.parseInt(process.env.HQ_PROBE_LINES ?? '3', 10)
const holdMs = Number.parseInt(process.env.HQ_PROBE_HOLD_MS ?? '2000', 10)
const maxSize = process.env.HQ_PROBE_MAX_SIZE
const fault = process.env.HQ_PROBE_FAULT

function faults(): Record<string, unknown> | undefined {
  switch (fault) {
    case 'gzip':
      return { gzip: true }
    case 'publish':
      return { publish: true }
    case 'seal':
      return { seal: true }
    case 'streamOpen':
      return { streamOpen: true }
    case 'diskFull':
      return { diskFull: true }
    case 'gzipDelay':
      return { gzipDelayMs: 10_000 }
    case 'publishDelay':
      return { publishDelayMs: 10_000 }
    default:
      return undefined
  }
}

configureLogging({
  level: 'debug',
  consoleLevel: 'off',
  ...(maxSize ? { maxSize } : {}),
  ...(fault ? { faults: faults() } : {}),
})

const log = getLogger('dsh-probe')

function report(extra: Record<string, unknown> = {}): void {
  const snapshot = dshInstanceInfo()
  process.stdout.write(
    `##PROBE##${JSON.stringify({
      mode,
      pid: process.pid,
      dshInstanceId: snapshot.dshInstanceId,
      instanceDir: snapshot.instanceDir,
      logFile: snapshot.logFile,
      logRoot: snapshot.logRoot,
      ownership: snapshot.ownership,
      degradedReason: snapshot.degradedReason,
      ...extra,
    })}\n`,
  )
}

function writeRecords(tag: string): void {
  for (let i = 0; i < recordCount; i += 1) {
    log.info(`${tag} record ${i}`, { tag, index: i, payload: 'x'.repeat(120) })
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  switch (mode) {
    case 'write': {
      writeRecords('write')
      await flushLogs()
      report({ files: readdirSync(dshInstanceInfo().instanceDir ?? '.').sort() })
      await shutdownLogging()
      return
    }
    case 'hold': {
      log.info('hold started', { tag: 'hold' })
      await flushLogs()
      report()
      await wait(holdMs)
      await shutdownLogging()
      return
    }
    case 'hold-no-shutdown': {
      log.info('hold without shutdown', { tag: 'hold-no-shutdown' })
      await flushLogs()
      report()
      await wait(holdMs)
      // Abandon the process: the OS must release the lock, and the active log
      // must remain readable without a final flush.
      process.exit(0)
      return
    }
    case 'concurrent': {
      // Many "plugins" logging at once through the shared destination.
      const plugins = ['dsh-auth', 'dsh-artifacts', 'dsh-quote', 'dsh-kicad', 'dsh-part-search']
      await Promise.all(
        plugins.map(async (pluginId) => {
          const pluginLog = getLogger(pluginId)
          for (let i = 0; i < recordCount; i += 1) {
            pluginLog.info(`${pluginId} ${i}`, { pluginId, index: i })
          }
        }),
      )
      await flushLogs()
      report({ files: readdirSync(dshInstanceInfo().instanceDir ?? '.').sort() })
      await shutdownLogging()
      return
    }
    case 'rotate': {
      writeRecords('rotate')
      await flushLogs()
      report({ files: readdirSync(dshInstanceInfo().instanceDir ?? '.').sort() })
      await shutdownLogging()
      return
    }
    case 'rotate-crash': {
      // Rotation seals the active file, then waits 10s before compressing.
      // Exiting inside that window leaves a sealed source for recovery.
      writeRecords('rotate-crash')
      const dir = dshInstanceInfo().instanceDir
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const sealed = dir
          ? readdirSync(dir).some((name) => name.includes('.log.sealed-'))
          : false
        if (sealed) break
        await wait(25)
      }
      report({ files: dir ? readdirSync(dir).sort() : [] })
      process.exit(9)
      return
    }
    case 'maintenance': {
      log.info('before maintenance', { tag: 'maintenance' })
      await flushLogs()
      await runMaintenance({
        timeBudgetMs: 5_000,
        minAgeMs: Number.parseInt(process.env.HQ_PROBE_MIN_AGE_MS ?? '5000', 10),
      })
      report({ files: readdirSync(dshInstanceInfo().instanceDir ?? '.').sort() })
      await shutdownLogging()
      return
    }
    default: {
      await flushLogs()
      report()
      await shutdownLogging()
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`PROBE_FAILED ${String(err)}\n`)
  process.exit(1)
})
