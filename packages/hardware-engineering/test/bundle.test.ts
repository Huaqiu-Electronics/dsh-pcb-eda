/**
 * Contract test for the `@huaqiu/hardware-engineering` bundle.
 *
 * A bundle patch is YAML, so nothing type-checks it. These assertions are the
 * only thing standing between a drifted patch and a profile that boots with a
 * normal-looking window and silently missing tools: DSH reports a bad bundle as
 * one stderr skip line and carries on.
 *
 * What is proven here:
 *   1. `cordis.patch.yml` and `src/index.ts` describe the same rows, in order.
 *   2. Every mounted name is a declared dependency, and vice versa.
 *   3. Every mounted package can actually be a plugin row (it ships a patch and
 *      a built-capable entry).
 *   4. No row gates on `hqEdge`, and no `@hqedge/*` package is referenced.
 *   5. The bundle declares the DSH runtime gate (`engines.dsh`).
 *
 * What is NOT proven here: that the rows activate. That needs a real DSH boot
 * (see `scripts/m1-activate.mjs` / the M1 report).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLE_PACKAGE,
  HARDWARE_ENGINEERING_PLUGINS,
  HARDWARE_ENGINEERING_PLUGIN_NAMES,
  HARDWARE_ENGINEERING_PROVIDED_SERVICES,
  HARDWARE_ENGINEERING_REQUIRED_SERVICES,
} from '../src/index.js'

const PACKAGE_DIR = join(import.meta.dirname, '..')
const REPO_ROOT = join(PACKAGE_DIR, '..', '..')

interface PatchRow {
  readonly id: string
  readonly name?: string
  readonly inject: readonly string[]
  readonly disabled?: boolean
}

/**
 * Parse the subset of the patch format this bundle uses: `- id:` rows carrying
 * `name`, `inject: [..]` and `disabled:`. Comments and blank lines are ignored.
 */
function parsePatch(text: string): PatchRow[] {
  const rows: PatchRow[] = []
  let current: { id: string; name?: string; inject: string[]; disabled?: boolean } | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (idMatch?.[1] !== undefined) {
      if (current !== undefined) rows.push(current)
      current = { id: idMatch[1], inject: [] }
      continue
    }
    if (current === undefined) continue
    const nameMatch = /^\s+name:\s*'?([^'\s]+)'?\s*$/.exec(line)
    if (nameMatch?.[1] !== undefined) { current.name = nameMatch[1]; continue }
    const injectMatch = /^\s+inject:\s*\[(.*)\]\s*$/.exec(line)
    if (injectMatch?.[1] !== undefined) {
      current.inject = injectMatch[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter((part) => part.length > 0)
      continue
    }
    if (/^\s+disabled:\s*true\s*$/.test(line)) current.disabled = true
  }
  if (current !== undefined) rows.push(current)
  return rows
}

const patch = parsePatch(readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8'))
const mounted = patch.filter((row) => row.name !== undefined)

/** name → directory for every workspace package. */
function workspacePackages(): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of readdirSync(join(REPO_ROOT, 'packages'))) {
    const manifestPath = join(REPO_ROOT, 'packages', entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
    if (typeof manifest.name === 'string') map.set(manifest.name, join(REPO_ROOT, 'packages', entry))
  }
  return map
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
  name: string
  engines?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
  files?: string[]
  main?: string
  types?: string
}

describe('bundle identity', () => {
  it('is the product package, not a second aggregator', () => {
    expect(manifest.name).toBe(BUNDLE_PACKAGE)
    expect(BUNDLE_PACKAGE).toBe('@huaqiu/hardware-engineering')
  })

  it('declares the bundle patch DSH reads', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships the patch inside the tarball', () => {
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('declares the DSH runtime gate so an incompatible runtime skips it loudly', () => {
    expect(manifest.engines?.dsh).toBeTypeOf('string')
    expect(manifest.engines?.dsh).toMatch(/^\^?0\.2\./)
  })
})

describe('patch ↔ ledger', () => {
  it('mounts exactly the ledger rows, in the same order', () => {
    expect(mounted.map((row) => ({ id: row.id, name: row.name, inject: [...row.inject] })))
      .toEqual(HARDWARE_ENGINEERING_PLUGINS.map((plugin) => ({ id: plugin.id, name: plugin.name, inject: [...plugin.inject] })))
  })

  it('mounts no row twice', () => {
    const ids = mounted.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    const names = mounted.map((row) => row.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('disables the official brand row the bundled theme replaces', () => {
    expect(patch.find((row) => row.id === 'ui-brand-official')).toMatchObject({ disabled: true })
  })

  it('lists providers before the consumers that wait on them', () => {
    const indexOf = (name: string): number => mounted.findIndex((row) => row.name === name)
    for (const plugin of HARDWARE_ENGINEERING_PLUGINS) {
      for (const service of plugin.provides) {
        const provider = HARDWARE_ENGINEERING_PLUGINS.find((candidate) => candidate.provides.includes(service))
        expect(provider).toBeDefined()
        for (const consumer of HARDWARE_ENGINEERING_PLUGINS) {
          if (!consumer.inject.includes(service)) continue
          expect(indexOf(provider!.name)).toBeLessThan(indexOf(consumer.name))
        }
      }
    }
  })

  it('exposes the service sets the activation test asserts on', () => {
    expect(HARDWARE_ENGINEERING_PROVIDED_SERVICES).toEqual(['hardwareArtifacts', 'huaqiuArtifacts', 'huaqiuAuth'])
    expect(HARDWARE_ENGINEERING_REQUIRED_SERVICES).toContain('huaqiuAuth')
    expect(HARDWARE_ENGINEERING_REQUIRED_SERVICES).toContain('huaqiuArtifacts')
    expect(HARDWARE_ENGINEERING_REQUIRED_SERVICES).toContain('webServer')
  })
})

describe('dependency ledger', () => {
  it('declares an exact dependency for every mounted plugin', () => {
    const dependencies = Object.keys(manifest.dependencies ?? {})
    for (const name of HARDWARE_ENGINEERING_PLUGIN_NAMES) {
      expect(dependencies, `${name} must be a dependency of the bundle`).toContain(name)
    }
  })

  it('declares no dependency it does not mount', () => {
    const dependencies = Object.keys(manifest.dependencies ?? {})
    expect(dependencies.sort()).toEqual([...HARDWARE_ENGINEERING_PLUGIN_NAMES].sort())
  })

  it('uses workspace ranges that pack to exact pins in the tarball', () => {
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      // pnpm rewrites `workspace:*` to the exact lockstep version on pack, which
      // is the repo's convention for a reproducible plugin set.
      expect(spec, `${name}: expected workspace:* (packs to an exact pin)`).toBe('workspace:*')
    }
  })

  it('every dependency resolves to a real workspace package that can be a bundle row', () => {
    const packages = workspacePackages()
    for (const name of HARDWARE_ENGINEERING_PLUGIN_NAMES) {
      const dir = packages.get(name)
      expect(dir, `${name} is not a workspace package`).toBeDefined()
      const childManifest = JSON.parse(readFileSync(join(dir!, 'package.json'), 'utf8')) as {
        dsh?: { bundle?: { patch?: string } }
        main?: string
      }
      expect(childManifest.dsh?.bundle?.patch, `${name} declares no dsh.bundle.patch`).toBeTypeOf('string')
      expect(childManifest.main, `${name} declares no entry`).toBeTypeOf('string')
    }
  })
})

describe('HQ Edge independence', () => {
  it('gates no row on hqEdge', () => {
    for (const plugin of HARDWARE_ENGINEERING_PLUGINS) {
      expect(plugin.inject, `${plugin.name} still injects hqEdge`).not.toContain('hqEdge')
    }
  })

  it('references no @hqedge package anywhere in the patch', () => {
    const text = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
    expect(text).not.toMatch(/@hqedge\//)
  })

  it('depends on no @hqedge package', () => {
    const all = { ...manifest.dependencies, ...manifest.peerDependencies }
    expect(Object.keys(all).filter((name) => name.startsWith('@hqedge/'))).toEqual([])
  })
})
