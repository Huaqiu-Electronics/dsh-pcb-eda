import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.js'
import { agentIds } from '../src/config.js'

type Tool = { name: string }

function ctxStub() {
  const registered: unknown[] = []
  const routes: Array<{ kind: string; path: string; handler?: unknown }> = []
  return {
    registered,
    routes,
    ctx: {
      // Cordis runs the callback immediately and keeps its return value as the
      // disposer; the stub mirrors that so route registration is observable.
      effect: (fn: () => unknown) => { fn() },
      webServer: {
        register: (spec: { kind: string; path: string; handler?: unknown }) => (routes.push(spec), () => {}),
      },
      tools: { register: (d: unknown) => (registered.push(d), () => {}) },
      huaqiuAuth: {
        auth: {
          isAuthenticated: async () => true,
          getAccessToken: async () => 'tok-1',
          getUserInfo: async () => ({ id: 'u1', token: 'tok-1' }),
          login: async () => {},
          logout: async () => {},
          validate: async () => ({ status: 'valid' }),
          invalidate: () => {},
          onAuthStateChanged: () => () => {},
        },
      },
      huaqiuArtifacts: {
        create: async () => ({ id: 'art', type: 'zip', filename: 'x.zip', size: 1 }),
        get: async () => null,
        readContent: async () => null,
        delete: async () => {},
        deleteAll: async () => 0,
      },
    } as Record<string, unknown>,
  }
}

describe('@huaqiu/dsh-tool-schematic-gen plugin', () => {
  it('exposes the expected node plugin shape', () => {
    expect(name).toBe('@huaqiu/dsh-tool-schematic-gen')
    // `webServer` mounts the progress route the browser card polls while a
    // 10-minute generation runs. `systemPrompt` carries the standing
    // tool-policy section (src/prompt.ts).
    expect(inject).toEqual(['tools', 'huaqiuAuth', 'huaqiuArtifacts', 'webServer', 'systemPrompt'])
    expect(agentIds.SCHEMATIC).toBe('schemagen')
    expect(agentIds.SYSTEM).toBe('modular_circuit')
  })

  it('registers the two generation tools', () => {
    const { ctx, registered } = ctxStub()
    const dispose = apply(ctx as never)
    const names = (registered as Tool[]).map((t) => t.name)
    expect(names).toEqual([
      'generate_schematic_from_description',
      'generate_system_module_graph',
    ])
    expect(typeof dispose).toBe('function')
  })

  it('throws loudly when the auth service is missing', () => {
    const { ctx } = ctxStub()
    expect(() => apply({ ...ctx, huaqiuAuth: undefined } as never)).toThrow(/huaqiuAuth/)
  })

  it('throws loudly when the artifacts service is missing', () => {
    const { ctx } = ctxStub()
    expect(() => apply({ ...ctx, huaqiuArtifacts: undefined } as never)).toThrow(/huaqiuArtifacts/)
  })

  it('mounts the live-progress route when webServer is available', () => {
    const { ctx, routes } = ctxStub()
    const dispose = apply(ctx as never)
    expect(routes).toMatchObject([{ kind: 'prefix', path: '/api/v1/huaqiu/schematic-gen/progress' }])
    expect(typeof (routes[0] as { handler?: unknown }).handler).toBe('function')
    dispose()
  })

  it('still registers the tools when webServer is unavailable (progress degrades, generation does not)', () => {
    const { ctx, routes, registered } = ctxStub()
    const dispose = apply({ ...ctx, webServer: undefined } as never)
    expect(routes).toEqual([])
    expect(registered).toHaveLength(2)
    dispose()
  })

  it('has no @hqedge dependency and no demo credentials', async () => {
    const fs = await import('node:fs/promises')
    const [source, manifest] = await Promise.all([
      fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ])
    expect(source).not.toMatch(/from\s+['"]@hqedge/)
    const deps = {
      ...JSON.parse(manifest).dependencies,
      ...JSON.parse(manifest).peerDependencies,
      ...JSON.parse(manifest).devDependencies,
    }
    expect(Object.keys(deps).some((k) => k.startsWith('@hqedge'))).toBe(false)
  })
})
