/**
 * The toolchain capability off the target machine: manifest validation,
 * discovery ranking, path resolution and the manager's state machine.
 *
 * Everything here is decision policy, not download plumbing — the installer's
 * byte-level behaviour is covered by `decode.test.ts` plus the real-archive
 * verification recorded in the implementation report.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MANIFEST_SCHEMA_VERSION, compareVersions, candidateRoots, parseManifest, probeInstallation,
  validateCandidates,
} from '../../src/toolchain/index.js'
import {
  executableCandidates, installationRootOf, normalizeVersion, resolveToolchain, sameRelease,
} from '../../src/toolchain/resolve.js'
import { ToolchainManager } from '../../src/toolchain/manager.js'

/** A manifest body with one entry per tool for win32/x64. */
function manifestBody(entries: Record<string, unknown[]>): string {
  return JSON.stringify({ schemaVersion: MANIFEST_SCHEMA_VERSION, ...entries })
}

const kicadEntry = {
  version: '10.0.7-2',
  platform: 'win',
  arch: 'x64',
  url: 'https://down.eda.cn/data/kicad-release/kicad-huaqiu-10.0.7-2-x86_64.zip',
  sha256: 'f4f350fea2e4633f313791d70b00c198a845204026a82bbe0b4e278ad1d70b99',
}

describe('manifest', () => {
  it('selects the newest release for this platform and arch', () => {
    const result = parseManifest(manifestBody({
      kicad: [kicadEntry, { ...kicadEntry, version: '10.0.5' }],
    }), { platform: 'win32', arch: 'x64' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.selected.kicad?.version).toBe('10.0.7-2')
    expect(result.manifest.target).toEqual({ platform: 'win', arch: 'x64' })
  })

  it('refuses a different schema version instead of guessing', () => {
    const result = parseManifest(JSON.stringify({ schemaVersion: 2, kicad: [kicadEntry] }), { platform: 'win32', arch: 'x64' })
    expect(result).toMatchObject({ ok: false, code: 'unsupported-schema' })
  })

  it('refuses an entry that is not installable', () => {
    const result = parseManifest(manifestBody({ kicad: [{ ...kicadEntry, sha256: 'abc' }] }), { platform: 'win32', arch: 'x64' })
    expect(result).toMatchObject({ ok: false, code: 'invalid-entry' })
  })

  it('reports no matching build as a state, not as an exception', () => {
    const result = parseManifest(manifestBody({ kicad: [kicadEntry] }), { platform: 'linux', arch: 'arm64' })
    expect(result).toMatchObject({ ok: false, code: 'no-entry' })
  })

  it('does not offer a download on a platform it cannot serve', () => {
    const result = parseManifest(manifestBody({ kicad: [kicadEntry] }), { platform: 'freebsd' as NodeJS.Platform })
    expect(result).toMatchObject({ ok: false, code: 'unsupported-platform' })
  })
})

describe('discovery', () => {
  const programFiles = 'C:\\Program Files'
  const localAppData = 'C:\\Users\\u\\AppData\\Local'
  const managed = 'C:\\Users\\u\\.dsh\\toolchains\\kicad'

  /** A machine whose managed root exists and whose system prefix has three versions. */
  const internals = {
    readdir: (path: string): string[] => {
      if (path === managed) return ['10.0.7']
      if (path === join(programFiles, 'KiCad')) return ['9.0', '8.0', '7.0', 'docs']
      if (path === join(localAppData, 'Programs', 'KiCad')) return []
      return []
    },
    exists: (path: string): boolean => path === managed || path === join(programFiles, 'KiCad'),
  }

  it('walks the fixed candidate list, managed first', () => {
    const roots = candidateRoots('kicad', {
      platform: 'win32',
      env: { ProgramFiles: programFiles, LOCALAPPDATA: localAppData },
      managedRoot: 'C:\\Users\\u\\.dsh\\toolchains',
      home: 'C:\\Users\\u',
    }, internals)
    expect(roots[0]?.origin).toBe('managed')
    expect(roots.some(root => root.path.endsWith('KiCad\\9.0'))).toBe(true)
    expect(roots.some(root => root.path.includes('docs'))).toBe(false)
  })

  it('never ranks an unvalidated directory above a validated one', () => {
    const roots = [
      { path: 'C:\\a', origin: 'system' as const },
      { path: 'C:\\b', origin: 'managed' as const },
    ]
    const outcome = validateCandidates('kicad', roots, {
      exists: () => true,
      probeVersion: executable => executable.startsWith('C:\\a') ? '9.0.0' : undefined,
    })
    expect(outcome.selected?.origin).toBe('system')
    expect(outcome.candidates.find(candidate => candidate.path.startsWith('C:\\b'))?.valid).toBe(false)
  })

  it('ranks managed above system at the same version', () => {
    const roots = [
      { path: 'C:\\system', origin: 'system' as const },
      { path: 'C:\\managed\\10.0', origin: 'managed' as const },
    ]
    const outcome = validateCandidates('kicad', roots, {
      exists: () => true,
      probeVersion: () => '10.0.7',
    })
    expect(outcome.selected?.origin).toBe('managed')
  })

  it('ranks the higher version above a lower one', () => {
    expect(compareVersions('10.0.7', '9.0.0')).toBeGreaterThan(0)
    expect(compareVersions('0.49.1', '0.49.1')).toBe(0)
    expect(compareVersions(undefined, '1.0.0')).toBeLessThan(0)
  })

  it('probes one directory without starting a version process for a missing root', () => {
    expect(probeInstallation('kicad', 'C:\\nope', {
      exists: () => false,
      probeVersion: () => '10.0.7',
    }).ok).toBe(false)
  })
})

describe('path resolution', () => {
  it('normalises an installation root from a directory, a bin dir or the executable', () => {
    const root = 'C:\\Program Files\\KiCad\\8.0'
    expect(installationRootOf('kicad', root)).toBe(root)
    expect(installationRootOf('kicad', join(root, 'bin'))).toBe(root)
    expect(installationRootOf('kicad', '   ')).toBeUndefined()
  })

  it('never retargets a directory whose own name matches the CLI stem', async () => {
    // `C:\Program Files\SolidCraft` and `…\KiCad\10.0` are folders, not
    // executables: reading them as executables moved the saved root one level up.
    const scratch = await mkdtemp(join(tmpdir(), 'hardware-roots-'))
    try {
      const solidcraft = join(scratch, 'SolidCraft')
      await mkdir(solidcraft, { recursive: true })
      expect(installationRootOf('solidcraft', solidcraft)).toBe(solidcraft)
      const kicad = join(scratch, 'kicad')
      await mkdir(kicad, { recursive: true })
      expect(installationRootOf('kicad', kicad)).toBe(kicad)
      // A real executable path still collapses to its installation root.
      expect(installationRootOf('kicad', join(kicad, 'bin', 'kicad-cli.exe'))).toBe(kicad)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('resolves an executable only when it exists and answered a version', () => {
    const root = 'C:\\tools\\kicad'
    const layout = executableCandidates('kicad', root, { platform: 'win32' })
    const executable = layout.cli[0] as string
    const configured = resolveToolchain('kicad', root, {
      platform: 'win32',
      exists: path => path === executable,
      probeVersion: () => '10.0.7',
    })
    expect(configured).toMatchObject({ configured: true, cli: executable, version: '10.0.7' })
    const silent = resolveToolchain('kicad', root, {
      platform: 'win32',
      exists: path => path === executable,
      probeVersion: () => undefined,
    })
    expect(silent.configured).toBe(false)
    expect(silent.error).toBeDefined()
  })

  it('reads both version interfaces', () => {
    expect(normalizeVersion('10.0.7')).toBe('10.0.7')
    expect(normalizeVersion('solidcraft-cli 0.49.1')).toBe('0.49.1')
    expect(normalizeVersion('no version here')).toBeUndefined()
  })

  it('accepts the packaging suffix difference between manifest and CLI', () => {
    expect(sameRelease('10.0.7-2', '10.0.7')).toBe(true)
    expect(sameRelease('10.0.7-2', '10.0.5')).toBe(false)
    expect(sameRelease('0.49.1', undefined)).toBe(false)
  })
})

describe('manager', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hardware-manager-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** A directory that looks like a KiCad install to the shared resolver. */
  const install = async (name: string): Promise<string> => {
    const target = join(root, name)
    const executable = executableCandidates('kicad', target).cli[0]
    expect(executable).toBeDefined()
    await mkdir(dirname(executable as string), { recursive: true })
    await writeFile(executable as string, '')
    return target
  }

  const manager = (overrides: {
    settings?: () => Record<string, unknown>
    persist?: (patch: Record<string, unknown>) => Promise<boolean>
    fetchImpl?: typeof fetch
  } = {}): ToolchainManager => new ToolchainManager({
    settings: overrides.settings ?? (() => ({})),
    ...(overrides.persist === undefined ? {} : { persist: overrides.persist }),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    managedRoot: join(root, 'managed'),
    home: root,
    platform: process.platform,
    arch: process.arch,
    env: {},
    versionProbe: async () => '10.0.7',
    pickFile: async () => ({ kind: 'unsupported', message: 'no chooser in tests' }),
    now: () => 1_000,
  })

  it('starts unconfigured and still reports the target and official pages', async () => {
    const state = await manager().status()
    expect(state.kicad.state).toBe('unconfigured')
    expect(state.solidcraft.state).toBe('unconfigured')
    expect(state.official.kicad).toBe('https://www.kicad.org/download/')
    expect(state.target.platform).toBe(process.platform)
  })

  it('persists a validated root and reports it as configured', async () => {
    const patches: Record<string, unknown>[] = []
    let settings: Record<string, unknown> = {}
    const subject = manager({
      settings: () => settings,
      persist: async (patch) => { patches.push(patch); settings = { ...settings, ...patch }; return true },
    })
    const target = await install('kicad-install')
    const outcome = await subject.save('kicad', target, 'manual')
    expect(outcome).toMatchObject({ ok: true, version: '10.0.7' })
    expect(patches[0]).toMatchObject({ kicadRoot: target, kicadSource: 'manual', kicadVersion: '10.0.7' })
    expect((await subject.status()).kicad.state).toBe('configured')
  })

  it('a refused write leaves the tool unconfigured', async () => {
    const subject = manager({ persist: async () => false })
    const outcome = await subject.save('kicad', await install('kicad-refused'), 'manual')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('refused')
    expect((await subject.status()).kicad.state).toBe('unconfigured')
  })

  it('reports a bad path as invalid rather than configured', async () => {
    const subject = manager({ settings: () => ({ kicadRoot: join(root, 'missing') }) })
    const state = await subject.status()
    expect(state.kicad.state).toBe('invalid')
    expect(state.kicad.error).toBeDefined()
  })

  it('keeps agent capabilities compact: availability and version only', async () => {
    const target = await install('kicad-capabilities')
    const subject = manager({
      settings: () => ({ kicadRoot: target }),
      persist: async () => true,
    })
    const capabilities = await subject.capabilities()
    expect(capabilities.kicad).toEqual({ available: true, version: '10.0.7' })
    expect(capabilities.solidcraft.available).toBe(false)
    // No absolute path may travel to the agent (§12.1).
    expect(JSON.stringify(capabilities)).not.toContain(root)
  })

  it('never invents a download: a manifest without this platform is an error state', async () => {
    const subject = manager({
      fetchImpl: async () => new Response(manifestBody({ kicad: [{ ...kicadEntry, platform: 'linux' }] }), { status: 200 }),
    })
    const started = await subject.install('kicad')
    expect(started.snapshot).toBeUndefined()
    expect(started.error?.code).toBe('no-entry')
  })

  it('reports a network failure as a download-unavailable state', async () => {
    const subject = manager({
      fetchImpl: async () => { throw new Error('offline') },
    })
    const started = await subject.install('kicad')
    expect(started.error?.code).toBe('network')
  })

  it('runs discovery in the background and answers immediately', async () => {
    const subject = manager()
    const started = subject.startDiscovery('kicad')
    // `running` is what the caller sees; the verdict arrives through `status`.
    expect(['running', 'done']).toContain(started.kicad.state)
    const settled = await subject.status()
    expect(settled.kicad.discovery.state).toBe('done')
  })

  it('cancel on an unknown job is false, not a throw', () => {
    expect(manager().cancel('nope')).toBe(false)
  })
})
