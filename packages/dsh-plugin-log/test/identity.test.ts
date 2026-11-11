/**
 * The fourth identity level (§1): one `dsh_instance_id` per DSH launch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  createDshIdentity,
  instanceDirFor,
  pluginLogVersion,
  readDshInstanceMetadata,
  readDshLogContext,
} from '../src/identity.js'
import { isUuid } from '../src/fs-utils.js'
import {
  EDGE_A,
  EDGE_B,
  HOST_ID,
  INSTALL_ID,
  clearIdentityEnv,
  tempHome,
} from './helpers.js'

let home: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  clearIdentityEnv()
  home = tempHome('identity')
  env = { HQ_EDGE_HOME: home } as NodeJS.ProcessEnv
})

afterEach(() => {
  clearIdentityEnv()
  rmSync(home, { recursive: true, force: true })
})

describe('context resolution', () => {
  it('reads the four identity levels and the target host', () => {
    const context = readDshLogContext({
      HQ_EDGE_HOME: home,
      HQ_EDGE_INSTALLATION_ID: INSTALL_ID,
      HQ_EDGE_INSTANCE_ID: EDGE_A,
      HQ_HOST_TYPE: 'KiCad',
      HQ_HOST_INSTANCE_ID: HOST_ID,
      HQ_TARGET_HOST: 'kicad',
      DSH_HOME: join(home, 'dsh-home'),
    })

    expect(context.installationId).toBe(INSTALL_ID)
    expect(context.edgeInstanceId).toBe(EDGE_A)
    // Host types are normalised to lower case so filtering is predictable.
    expect(context.hostType).toBe('kicad')
    expect(context.hostInstanceId).toBe(HOST_ID)
    expect(context.targetHost).toBe('kicad')
    expect(context.dshHome).toBe(join(home, 'dsh-home'))
    expect(context.dshLogRootSource).toBe('edge-instance')
    expect(context.warnings).toHaveLength(0)
  })

  it('records malformed identities as absent instead of fabricating them', () => {
    const context = readDshLogContext({
      HQ_EDGE_HOME: home,
      HQ_EDGE_INSTANCE_ID: 'not-a-uuid',
      HQ_EDGE_INSTALLATION_ID: '12345',
      HQ_HOST_INSTANCE_ID: '',
      HQ_HOST_TYPE: 'kicad; rm -rf /',
    })

    expect(context.edgeInstanceId).toBeNull()
    expect(context.installationId).toBeNull()
    expect(context.hostInstanceId).toBeNull()
    expect(context.hostType).toBeNull()
    expect(context.dshLogRootSource).toBe('unscoped')
    expect(context.warnings.length).toBe(3)
  })

  it('lets $DSH_LOG_ROOT win over the Edge-derived root', () => {
    const context = readDshLogContext({
      HQ_EDGE_HOME: home,
      HQ_EDGE_INSTANCE_ID: EDGE_A,
      DSH_LOG_ROOT: join(home, 'edge-provided', 'dsh'),
    })
    expect(context.dshLogRoot).toBe(join(home, 'edge-provided', 'dsh'))
    expect(context.dshLogRootSource).toBe('env:DSH_LOG_ROOT')
  })

  it('lets an explicit override win over every environment variable', () => {
    const context = readDshLogContext(
      { HQ_EDGE_HOME: home, DSH_LOG_ROOT: join(home, 'env-root') },
      { dshLogRoot: join(home, 'option-root') },
    )
    expect(context.dshLogRoot).toBe(join(home, 'option-root'))
    expect(context.dshLogRootSource).toBe('override')
  })

  it('derives <logs>/instances/<edge>/dsh when only the Edge id is known', () => {
    const context = readDshLogContext({ HQ_EDGE_HOME: home, HQ_EDGE_INSTANCE_ID: EDGE_A })
    expect(context.dshLogRoot).toBe(join(home, 'logs', 'instances', EDGE_A, 'dsh'))
  })
})

describe('instance identity', () => {
  it('generates a different dsh_instance_id for every launch', () => {
    const context = readDshLogContext(env)
    const first = createDshIdentity(context, { now: new Date('2026-11-11T09:00:00.000Z') })
    const second = createDshIdentity(context, { now: new Date('2026-11-11T09:00:01.000Z') })

    expect(isUuid(first.dshInstanceId)).toBe(true)
    expect(isUuid(second.dshInstanceId)).toBe(true)
    expect(first.dshInstanceId).not.toBe(second.dshInstanceId)
    expect(first.startedAt).toBe('2026-11-11T09:00:00.000Z')
  })

  it('accepts an injected id for tests and a host-provided $DSH_INSTANCE_ID', () => {
    const context = readDshLogContext(env)
    const injected = createDshIdentity(context, { dshInstanceId: EDGE_B })
    expect(injected.dshInstanceId).toBe(EDGE_B)

    process.env.DSH_INSTANCE_ID = HOST_ID
    expect(createDshIdentity(context).dshInstanceId).toBe(HOST_ID)
  })

  it('ignores a malformed injected id', () => {
    const context = readDshLogContext(env)
    const identity = createDshIdentity(context, { dshInstanceId: 'nope' })
    expect(isUuid(identity.dshInstanceId)).toBe(true)
  })

  it('places the instance directory directly under the DSH root', () => {
    const context = readDshLogContext({ HQ_EDGE_HOME: home, HQ_EDGE_INSTANCE_ID: EDGE_A })
    const identity = createDshIdentity(context, { dshInstanceId: EDGE_B })
    expect(instanceDirFor(identity)).toBe(join(home, 'logs', 'instances', EDGE_A, 'dsh', EDGE_B))
  })

  it('reports a package version', () => {
    expect(pluginLogVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('historical metadata', () => {
  function writeMetadata(dir: string, value: unknown): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'instance.json'), typeof value === 'string' ? value : JSON.stringify(value))
  }

  function valid(id: string): Record<string, unknown> {
    return {
      schemaVersion: 1,
      dshInstanceId: id,
      installationId: INSTALL_ID,
      edgeInstanceId: EDGE_A,
      hostType: 'kicad',
      hostInstanceId: HOST_ID,
      targetHost: 'kicad',
      pid: 4242,
      startedAt: '2026-11-11T09:00:00.000Z',
      version: '0.6.23',
      dshHome: null,
      logRoot: home,
    }
  }

  it('reads a valid instance.json', () => {
    const dir = join(home, 'dsh', EDGE_B)
    writeMetadata(dir, valid(EDGE_B))
    const metadata = readDshInstanceMetadata(dir)
    expect(metadata?.dshInstanceId).toBe(EDGE_B)
    expect(metadata?.hostType).toBe('kicad')
  })

  it('returns null for a corrupt or NUL-corrupted file', () => {
    const dirA = join(home, 'dsh', EDGE_A)
    writeMetadata(dirA, '{"dshInstanceId": "x"')
    expect(readDshInstanceMetadata(dirA)).toBeNull()

    const dirB = join(home, 'dsh', EDGE_B)
    writeMetadata(dirB, `${'\u0000'.repeat(64)}${JSON.stringify(valid(EDGE_B))}`)
    expect(readDshInstanceMetadata(dirB)).toBeNull()
  })

  it('rejects metadata whose id does not match the directory name', () => {
    const dir = join(home, 'dsh', EDGE_A)
    writeMetadata(dir, valid(EDGE_B))
    expect(basename(dir)).toBe(EDGE_A)
    expect(readDshInstanceMetadata(dir)).toBeNull()
  })

  it('treats an unknown schema version as readable but old', () => {
    const dir = join(home, 'dsh', EDGE_B)
    writeMetadata(dir, { ...valid(EDGE_B), schemaVersion: undefined })
    expect(readDshInstanceMetadata(dir)?.schemaVersion).toBe(0)
  })
})
