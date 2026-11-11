/**
 * Plugin-facing logger contract: attribution, reserved fields, one shared
 * destination per DSH process, and "never break the plugin".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  RESERVED_FIELDS,
  configureLogging,
  createLogger,
  flushLogs,
  getLogger,
  getLoggingHealth,
  logDir,
  logFilePath,
  resetLogging,
  shutdownLogging,
} from '../src/index.js'
import {
  EDGE_A,
  HOST_ID,
  INSTALL_ID,
  clearIdentityEnv,
  exists,
  filesIn,
  readJsonl,
  tempHome,
} from './helpers.js'

let home: string

beforeEach(async () => {
  await resetLogging()
  clearIdentityEnv()
  home = tempHome('logger')
  process.env.HQ_EDGE_HOME = home
  process.env.HQ_EDGE_INSTANCE_ID = EDGE_A
  process.env.HQ_EDGE_INSTALLATION_ID = INSTALL_ID
  process.env.HQ_HOST_TYPE = 'kicad'
  process.env.HQ_HOST_INSTANCE_ID = HOST_ID
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  configureLogging({ level: 'debug', consoleLevel: 'off' })
})

afterEach(async () => {
  await resetLogging()
  clearIdentityEnv()
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function activeLog(): Promise<string> {
  await flushLogs()
  const file = logFilePath()
  expect(file).toBeTruthy()
  return file as string
}

describe('attribution (§2.1 / §6)', () => {
  it('writes JSONL records carrying pluginId, level, message and full identity', async () => {
    getLogger('dsh-auth').info('host session resolved', { userId: '6215935' })
    const records = readJsonl(await activeLog())

    const record = records.find((entry) => entry.msg === 'host session resolved')
    expect(record).toBeTruthy()
    expect(record!.pluginId).toBe('dsh-auth')
    // Legacy alias kept for existing greps.
    expect(record!.component).toBe('dsh-auth')
    expect(record!.level).toBe('info')
    expect(record!.userId).toBe('6215935')
    expect(typeof record!.time).toBe('number')
    expect(typeof record!.ts).toBe('string')
    expect(record!.installationId).toBe(INSTALL_ID)
    expect(record!.edgeInstanceId).toBe(EDGE_A)
    expect(record!.hostType).toBe('kicad')
    expect(record!.hostInstanceId).toBe(HOST_ID)
    expect(record!.dshInstanceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(record!.pid).toBe(process.pid)
  })

  it('accepts a full package name as the plugin id', async () => {
    createLogger({ pluginId: '@huaqiu/dsh-plugin-eda' }).info('selection', { count: 2 })
    const records = readJsonl(await activeLog())
    expect(records.find((entry) => entry.msg === 'selection')!.pluginId).toBe('@huaqiu/dsh-plugin-eda')
  })

  it('unifies every plugin in ONE file inside ONE instance directory', async () => {
    getLogger('dsh-auth').info('a')
    getLogger('dsh-artifacts').info('b')
    getLogger('dsh-quote').warn('c')

    const file = await activeLog()
    const records = readJsonl(file)
    const pluginIds = new Set(records.map((entry) => entry.pluginId))
    expect(pluginIds.has('dsh-auth')).toBe(true)
    expect(pluginIds.has('dsh-artifacts')).toBe(true)
    expect(pluginIds.has('dsh-quote')).toBe(true)

    // Exactly one active log and exactly one instance directory.
    const dir = logDir() as string
    expect(file.startsWith(dir)).toBe(true)
    expect(filesIn(dir).filter((name) => name.endsWith('.log'))).toHaveLength(1)
    expect(filesIn(join(dir, '..')).filter((name) => !name.includes('.'))).toHaveLength(1)
  })

  it('keeps one destination across a plugin reload (same id, no extra transport)', async () => {
    const first = getLogger('dsh-auth')
    first.info('before reload')
    const before = await activeLog()
    const dirsBefore = filesIn(join(logDir() as string, '..')).length

    // A reload re-runs `getLogger` in the same process; it must reuse the sink.
    const second = getLogger('dsh-auth')
    second.info('after reload')
    await flushLogs()

    expect(logFilePath()).toBe(before)
    expect(filesIn(join(logDir() as string, '..')).length).toBe(dirsBefore)
    const messages = readJsonl(before).map((entry) => entry.msg)
    expect(messages).toContain('before reload')
    expect(messages).toContain('after reload')
  })

  it('keeps the destination available after a plugin is unloaded', async () => {
    const unloaded = getLogger('dsh-removed-plugin')
    unloaded.info('last words')

    // Dropping the logger (and, in a real DSH, unloading the plugin) must not
    // close anything: the next plugin still writes to the same file.
    getLogger('dsh-auth').info('still here')
    const records = readJsonl(await activeLog())
    expect(records.map((entry) => entry.msg)).toEqual(expect.arrayContaining(['last words', 'still here']))
  })

  it('does not create competing transports when several plugins log concurrently', async () => {
    const plugins = ['dsh-a', 'dsh-b', 'dsh-c', 'dsh-d', 'dsh-e']
    await Promise.all(
      plugins.map(async (pluginId) => {
        const log = getLogger(pluginId)
        for (let i = 0; i < 40; i += 1) log.info(`${pluginId}-${i}`, { pluginId, index: i })
      }),
    )

    const file = await activeLog()
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    // Every line must be independently parseable: no interleaving corruption.
    const records = lines.map((line) => JSON.parse(line) as Record<string, any>)
    expect(records).toHaveLength(200 + 1) // 200 plugin records + the boot banner
    expect(new Set(records.map((entry) => entry.pluginId))).toEqual(new Set([...plugins, 'dsh-plugin-log']))
    // Each record keeps its own id: nothing was written under the wrong plugin.
    for (const record of records) {
      if (record.index !== undefined) expect(`${record.pluginId}-${record.index}`).toBe(record.msg)
    }
  })
})

describe('reserved fields (§6)', () => {
  it('refuses plugin attempts to override identity, level or message fields', async () => {
    getLogger('dsh-auth').info('real message', {
      pluginId: 'dsh-someone-else',
      component: 'dsh-someone-else',
      level: 'error',
      msg: 'spoofed',
      dshInstanceId: '00000000-0000-4000-8000-000000000000',
      edgeInstanceId: '00000000-0000-4000-8000-000000000001',
      installationId: '00000000-0000-4000-8000-000000000002',
      hostType: 'hqpcb',
      pid: 1,
      time: 1,
      ts: '1970-01-01T00:00:00.000Z',
      businessField: 'kept',
    })

    const record = readJsonl(await activeLog()).find((entry) => entry.msg === 'real message')
    expect(record).toBeTruthy()
    expect(record!.pluginId).toBe('dsh-auth')
    expect(record!.component).toBe('dsh-auth')
    expect(record!.level).toBe('info')
    expect(record!.dshInstanceId).not.toBe('00000000-0000-4000-8000-000000000000')
    expect(record!.edgeInstanceId).toBe(EDGE_A)
    expect(record!.installationId).toBe(INSTALL_ID)
    expect(record!.hostType).toBe('kicad')
    expect(record!.pid).toBe(process.pid)
    expect(record!.time).not.toBe(1)
    expect(record!.businessField).toBe('kept')
  })

  it('applies the same rule to child() defaults', async () => {
    const child = getLogger('dsh-auth').child({ pluginId: 'dsh-hijack', requestId: 'r-1' })
    child.info('child record')

    const record = readJsonl(await activeLog()).find((entry) => entry.msg === 'child record')
    expect(record!.pluginId).toBe('dsh-auth')
    expect(record!.requestId).toBe('r-1')
  })

  it('documents every field a plugin may not set', () => {
    for (const field of ['level', 'msg', 'pluginId', 'component', 'dshInstanceId', 'edgeInstanceId', 'pid']) {
      expect(RESERVED_FIELDS.has(field)).toBe(true)
    }
  })
})

describe('levels and redaction', () => {
  it('honours the configured minimum level', async () => {
    await resetLogging()
    configureLogging({ level: 'warn', consoleLevel: 'off' })
    const log = getLogger('dsh-auth')
    log.debug('nope-debug')
    log.info('nope-info')
    log.warn('yes-warn')

    const messages = readJsonl(await activeLog()).map((entry) => entry.msg)
    expect(messages).not.toContain('nope-debug')
    expect(messages).not.toContain('nope-info')
    expect(messages).toContain('yes-warn')
  })

  it('redacts credentials but preserves UUID identifiers', async () => {
    getLogger('dsh-auth').info('fetched', {
      token: '21ce59a4-2d69-5b0c-b1ea-6fe3c0d012a4',
      apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz012345',
      userId: '7',
      artifactId: '9f8e7d6c-5b4a-4321-8765-4f3e2d1c0b9a',
    })

    const file = await activeLog()
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('21ce59a4-2d69-5b0c-b1ea-6fe3c0d012a4')
    expect(raw).not.toContain('sk-live-')

    const record = readJsonl(file).find((entry) => entry.msg === 'fetched')
    expect(record!.token).toBe('[redacted]')
    expect(record!.apiKey).toBe('[redacted]')
    expect(record!.userId).toBe('7')
    // Identity UUIDs must survive redaction, or the log stops being attributable.
    expect(record!.artifactId).toBe('9f8e7d6c-5b4a-4321-8765-4f3e2d1c0b9a')
    expect(record!.dshInstanceId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('console mirroring', () => {
  it('mirrors at or above the console level only', async () => {
    await resetLogging()
    configureLogging({ level: 'debug', consoleLevel: 'error' })
    const log = getLogger('dsh-auth')
    log.warn('warn-not-mirrored')
    log.error('boom', { detail: 'x' })

    await flushLogs()
    expect(console.error).toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('does not touch the console when mirroring is off', async () => {
    getLogger('dsh-auth').error('quiet')
    await flushLogs()
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('robustness', () => {
  it('never throws from a log call', () => {
    const log = getLogger('dsh-auth')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => log.info('cyclic', cyclic)).not.toThrow()
    expect(() => log.error('boom', { err: new Error('bad') })).not.toThrow()
    expect(() => log.info('bigint', { value: 10n })).not.toThrow()
    expect(() => log.child({ deep: { nested: { further: new Date() } } }).debug('child')).not.toThrow()
  })

  it('reports the active file only once the destination is open', async () => {
    await resetLogging()
    expect(logFilePath()).toBeNull()
    configureLogging({ level: 'debug', consoleLevel: 'off' })
    getLogger('dsh-auth').info('x')
    const file = await activeLog()
    expect(exists(file)).toBe(true)
  })

  it('reports a healthy destination with no dropped records', async () => {
    getLogger('dsh-auth').info('x')
    await activeLog()
    const health = getLoggingHealth()
    expect(health.state).toBe('healthy')
    expect(health.ownership).toBe('held')
    expect(health.droppedRecords).toBe(0)
    expect(health.instanceDir).toBe(logDir())
  })

  it('keeps working after shutdown is called twice', async () => {
    getLogger('dsh-auth').info('x')
    await flushLogs()
    await shutdownLogging()
    await expect(shutdownLogging()).resolves.toBeUndefined()
  })
})
