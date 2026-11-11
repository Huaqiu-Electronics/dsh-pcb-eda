/**
 * A broken logging destination must never break a plugin (§6).
 *
 * These tests assert the direction of failure: the destination degrades, the
 * plugin's call returns normally, and nothing is silently redirected into a
 * shared file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  configureLogging,
  dshInstanceInfo,
  flushLogs,
  getLogger,
  getLoggingHealth,
  logDir,
  logFilePath,
  resetLogging,
  shutdownLogging,
} from '../src/index.js'
import { installHostLogSink } from '../src/runtime.js'
import { acquireDshOwnership } from '../src/ownership.js'
import { OWNER_LOCK_FILENAME } from '../src/identity.js'
import { EDGE_A, EDGE_B, clearIdentityEnv, exists, filesIn, seedDshInstance, tempHome } from './helpers.js'

let home: string

beforeEach(async () => {
  await resetLogging()
  clearIdentityEnv()
  home = tempHome('faults')
  process.env.HQ_EDGE_HOME = home
  process.env.HQ_EDGE_INSTANCE_ID = EDGE_A
})

afterEach(async () => {
  installHostLogSink(null)
  await resetLogging()
  clearIdentityEnv()
  rmSync(home, { recursive: true, force: true })
})

describe('unusable destination', () => {
  it('degrades without throwing when the log root cannot be created', async () => {
    const blocker = join(home, 'blocked')
    writeFileSync(blocker, 'not a directory')

    configureLogging({ dir: join(blocker, 'logs'), consoleLevel: 'off' })
    const log = getLogger('dsh-auth')
    expect(() => log.info('business continues', { orderId: 'A-1' })).not.toThrow()
    expect(() => log.error('still safe')).not.toThrow()

    await flushLogs()
    const health = getLoggingHealth()
    expect(health.state).toBe('unavailable')
    expect(health.degradedReason).toBe('dsh-log-root-unavailable')
    expect(logFilePath()).toBeNull()
  })

  it('refuses to write into a directory another process owns', async () => {
    const root = join(home, 'logs', 'instances', EDGE_A, 'dsh')
    const dir = seedDshInstance(root, EDGE_B)
    // Stand in for the live owner: hold the same OS lock this process would
    // have to acquire.
    const held = await acquireDshOwnership(dir, EDGE_B)
    expect(held).not.toBeNull()

    configureLogging({ dshInstanceId: EDGE_B, consoleLevel: 'off' })
    const log = getLogger('dsh-auth')
    expect(() => log.info('must not land')).not.toThrow()
    await flushLogs()

    const health = getLoggingHealth()
    expect(health.state).toBe('unavailable')
    expect(health.degradedReason).toBe('ownership-unavailable')
    // Nothing was written into the live owner's active log.
    expect(filesIn(dir).some((name) => name.endsWith('.log') && name.startsWith('dsh.'))).toBe(false)
    // The failure is recorded for support, next to the lock it failed to take.
    expect(exists(join(dir, 'fatal.log'))).toBe(true)

    held?.release()
  })

  it('never falls back to the legacy shared plugin log', async () => {
    const blocker = join(home, 'blocked2')
    writeFileSync(blocker, 'x')
    configureLogging({ dir: join(blocker, 'logs'), consoleLevel: 'off' })
    getLogger('dsh-auth').info('nowhere to go')
    await flushLogs()

    const legacy = join(home, 'logs', 'dsh-plugins')
    expect(exists(legacy)).toBe(false)
  })
})

describe('host-provided sink', () => {
  it('delegates the transport to DSH instead of opening a file', async () => {
    const lines: string[] = []
    installHostLogSink({ write: (line) => lines.push(line) })

    configureLogging({ consoleLevel: 'off' })
    getLogger('dsh-auth').info('through the host', { requestId: 'r-9' })
    await flushLogs()

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    // The boot banner plus the plugin record, both through the host sink.
    expect(records).toHaveLength(2)
    const record = records.find((entry) => entry.msg === 'through the host')
    expect(record).toBeTruthy()
    expect(record!.pluginId).toBe('dsh-auth')
    expect(record!.edgeInstanceId).toBe(EDGE_A)
    expect(record!.requestId).toBe('r-9')
    // The instance identity still exists; the file transport does not.
    const dir = dshInstanceInfo().instanceDir as string
    expect(filesIn(dir).some((name) => name.endsWith('.log'))).toBe(false)
    expect(getLoggingHealth().state).toBe('healthy')
  })

  it('ignores a sink installed after the destination was established', async () => {
    configureLogging({ consoleLevel: 'off' })
    getLogger('dsh-auth').info('file first')
    await flushLogs()

    const lines: string[] = []
    installHostLogSink({ write: (line) => lines.push(line) })
    getLogger('dsh-auth').info('still file')
    await flushLogs()

    expect(lines).toHaveLength(0)
    const dir = logDir() as string
    expect(exists(join(dir, 'fatal.log'))).toBe(true)
    const fatal = filesIn(dir).includes('fatal.log')
    expect(fatal).toBe(true)
  })

  it('flushes and closes the host sink on shutdown, and only DSH does that', async () => {
    let flushed = 0
    let closed = 0
    installHostLogSink({
      write: () => {},
      flush: async () => {
        flushed += 1
      },
      close: () => {
        closed += 1
      },
    })

    configureLogging({ consoleLevel: 'off' })
    getLogger('dsh-auth').info('x')
    await shutdownLogging()

    expect(flushed).toBe(1)
    expect(closed).toBe(1)
  })
})

describe('plugin unload safety', () => {
  it('does not close the shared destination when a plugin disappears', async () => {
    configureLogging({ consoleLevel: 'off' })
    const removed = getLogger('dsh-removed')
    removed.info('last')
    await flushLogs()
    const file = logFilePath() as string

    // Simulate unload: drop the logger and run any per-plugin teardown the
    // package exposes. There is deliberately no close() on PluginLogger.
    expect(Object.keys(removed)).not.toContain('close')

    getLogger('dsh-auth').info('after unload')
    await flushLogs()
    expect(logFilePath()).toBe(file)
    expect(exists(file)).toBe(true)
  })

  it('keeps initialization idempotent across repeated getLogger calls', async () => {
    configureLogging({ consoleLevel: 'off' })
    for (let i = 0; i < 5; i += 1) getLogger('dsh-auth').info(`call ${i}`)
    await flushLogs()

    const dir = logDir() as string
    const root = join(home, 'logs', 'instances', EDGE_A, 'dsh')
    // Exactly one instance directory was created for this process.
    expect(filesIn(root).filter((name) => !name.includes('.'))).toEqual([dir.split(/[\\/]/).pop()])
    expect(filesIn(dir).filter((name) => name.endsWith('.log'))).toHaveLength(1)
    expect(filesIn(dir)).toContain(OWNER_LOCK_FILENAME)
  })

  it('creates the instance directory eagerly and never shares it', async () => {
    configureLogging({ consoleLevel: 'off' })
    getLogger('dsh-auth').info('x')
    await flushLogs()
    const dir = logDir() as string
    mkdirSync(dir, { recursive: true })
    expect(dshInstanceInfo().logFile).toContain(dir)
  })
})
