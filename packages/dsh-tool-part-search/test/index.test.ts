import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.js'

describe('@huaqiu/dsh-tool-part-search plugin', () => {
  it('exposes the expected plugin shape', () => {
    expect(name).toBe('@huaqiu/dsh-tool-part-search')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
  })

  it('registers the four part-search tools via ctx.tools.register', () => {
    const registered: unknown[] = []
    const ctx = {
      tools: {
        register: (def: unknown) => {
          registered.push(def)
          return () => undefined
        },
      },
    }
    const dispose = apply(ctx as never)
    expect(registered).toHaveLength(4)
    const names = registered.map((t) => (t as { name: string }).name)
    expect(names).toEqual([
      'search_hqsch_parts',
      'get_hqsch_part',
      'get_hqsch_part_models',
      'get_hqsch_supply_chain',
    ])
    // disposer is a function (tool unregistration path)
    expect(typeof dispose).toBe('function')
  })

  it('rolls back already registered tools when registration fails partway through', () => {
    const disposed: string[] = []
    let registrations = 0
    const ctx = {
      tools: {
        register: (def: unknown) => {
          const toolName = (def as { name: string }).name
          registrations += 1
          if (registrations === 3) {
            throw new Error('registration failed')
          }
          return () => disposed.push(toolName)
        },
      },
    }

    expect(() => apply(ctx as never)).toThrow('registration failed')
    expect(disposed).toEqual([
      'search_hqsch_parts',
      'get_hqsch_part',
    ])
  })

  it('throws loudly when the tools service is missing', () => {
    expect(() => apply({} as never)).toThrow(/requires the DSH/)
  })

  it('has no @hqedge dependency (import or manifest), only docstring mentions', async () => {
    const fs = await import('node:fs/promises')
    const [source, manifest] = await Promise.all([
      fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ])
    // No import from @hqedge anywhere in the plugin source.
    expect(source).not.toMatch(/from\s+['"]@hqedge/)
    expect(source).not.toMatch(/import\s*\(['"]@hqedge/)
    // No @hqedge package in any dependency section of the manifest.
    const deps = {
      ...JSON.parse(manifest).dependencies,
      ...JSON.parse(manifest).peerDependencies,
      ...JSON.parse(manifest).devDependencies,
    }
    expect(Object.keys(deps).some((k) => k.startsWith('@hqedge'))).toBe(false)
  })
})
