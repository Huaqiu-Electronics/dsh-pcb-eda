/**
 * Log-root resolution (§3 / §4): where a DSH process is allowed to write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  configureLogging,
  dshInstanceInfo,
  flushLogs,
  getLogger,
  logDir,
  logRoot,
  resetLogging,
} from '../src/index.js'
import { getDshLogRoot, getHqEdgeHome } from '../src/paths.js'
import { EDGE_A, INSTALL_ID, clearIdentityEnv, exists, tempHome } from './helpers.js'

let home: string

beforeEach(async () => {
  await resetLogging()
  clearIdentityEnv()
  home = tempHome('home')
  process.env.HQ_EDGE_HOME = home
  process.env.HQ_EDGE_INSTANCE_ID = EDGE_A
  process.env.HQ_EDGE_INSTALLATION_ID = INSTALL_ID
  configureLogging({ consoleLevel: 'off' })
})

afterEach(async () => {
  await resetLogging()
  clearIdentityEnv()
  rmSync(home, { recursive: true, force: true })
})

describe('DSH log root', () => {
  it('defaults to <HQ_EDGE_HOME>/logs/instances/<edge>/dsh', async () => {
    getLogger('dsh-auth').info('x')
    await flushLogs()

    expect(logRoot()).toBe(join(home, 'logs', 'instances', EDGE_A, 'dsh'))
    const snapshot = dshInstanceInfo()
    expect(snapshot.instanceDir).toBe(join(home, 'logs', 'instances', EDGE_A, 'dsh', snapshot.dshInstanceId as string))
  })

  it('honours $DSH_LOG_ROOT passed by HQ Edge', async () => {
    await resetLogging()
    const explicitRoot = join(home, 'passed-by-edge', 'dsh')
    process.env.DSH_LOG_ROOT = explicitRoot
    configureLogging({ consoleLevel: 'off' })

    getLogger('dsh-auth').info('x')
    await flushLogs()
    expect(logRoot()).toBe(explicitRoot)
  })

  it('lets an explicit dir beat $DSH_LOG_ROOT', async () => {
    await resetLogging()
    process.env.DSH_LOG_ROOT = join(home, 'from-env', 'dsh')
    const explicit = join(home, 'from-option', 'dsh')
    configureLogging({ dir: explicit, consoleLevel: 'off' })

    getLogger('dsh-auth').info('x')
    await flushLogs()
    expect(logRoot()).toBe(explicit)
  })

  it('uses <HQ_EDGE_HOME>/logs/dsh when no Edge identity is available', async () => {
    await resetLogging()
    delete process.env.HQ_EDGE_INSTANCE_ID
    configureLogging({ consoleLevel: 'off' })

    getLogger('dsh-auth').info('x')
    await flushLogs()
    expect(logRoot()).toBe(join(home, 'logs', 'dsh'))
  })

  it('honours $HQ_EDGE_LOG_DIR as the log base', async () => {
    await resetLogging()
    const base = join(home, 'custom-logs')
    process.env.HQ_EDGE_LOG_DIR = base
    configureLogging({ consoleLevel: 'off' })

    getLogger('dsh-auth').info('x')
    await flushLogs()
    expect(logRoot()).toBe(join(base, 'instances', EDGE_A, 'dsh'))
  })

  it('ignores a relative $HQ_EDGE_HOME (repository convention)', () => {
    // A relative override must not be resolved against the CWD: it is simply
    // rejected, and the caller falls back to the documented default.
    expect(getHqEdgeHome('relative/home')).toBe(getHqEdgeHome())
    expect(isAbsolute(getHqEdgeHome('relative/home'))).toBe(true)
  })

  it('never writes directly into the shared root: the instance level is always appended', async () => {
    getLogger('dsh-auth').info('x')
    await flushLogs()

    const root = logRoot() as string
    const dir = logDir() as string
    expect(dir).not.toBe(root)
    expect(dir.startsWith(root)).toBe(true)
    // The record itself lives one level deeper than the root.
    expect(dshInstanceInfo().logFile).toBeTruthy()
  })

  it('writes instance.json describing this DSH process', async () => {
    getLogger('dsh-auth').info('x')
    await flushLogs()

    const dir = logDir() as string
    const metadata = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8')) as Record<string, unknown>
    expect(metadata.dshInstanceId).toBe(dshInstanceInfo().dshInstanceId)
    expect(metadata.edgeInstanceId).toBe(EDGE_A)
    expect(metadata.installationId).toBe(INSTALL_ID)
    expect(metadata.pid).toBe(process.pid)
    expect(typeof metadata.startedAt).toBe('string')
    expect(metadata.schemaVersion).toBe(1)
    expect(exists(join(dir, 'owner.lock'))).toBe(true)
  })

  it('builds the root from the Edge id without inventing one', () => {
    expect(getDshLogRoot(EDGE_A, join(home, 'logs'))).toBe(join(home, 'logs', 'instances', EDGE_A, 'dsh'))
    expect(getDshLogRoot(null, join(home, 'logs'))).toBe(join(home, 'logs', 'dsh'))
  })
})
