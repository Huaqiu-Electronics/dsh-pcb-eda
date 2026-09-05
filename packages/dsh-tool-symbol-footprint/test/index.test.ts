import { describe, expect, it, vi } from 'vitest'
import { apply, createComponentGenBackend, inject, name, packageTypes } from '../src/index.js'
import type { HuaqiuAuthService } from '@huaqiu/dsh-auth'
import type { HuaqiuArtifacts, CreateArtifactResult } from '@huaqiu/dsh-artifacts'

type Tool = { name: string; execute(args: unknown, exec?: unknown): Promise<unknown> }

function ctxStub() {
  let id = 0
  const registered: unknown[] = []
  const auth: HuaqiuAuthService = {
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
    setCredentials: () => {},
    invalidate: () => {},
    hostMode: false,
  }
  const artifacts: HuaqiuArtifacts = {
    create: async (): Promise<CreateArtifactResult> => ({ id: 'art_test', type: 'footprint', filename: 'x.kicad_mod', size: 1 }),
    get: async () => null,
    readContent: async () => null,
    delete: async () => {},
    deleteAll: async () => 0,
  }
  return {
    auth,
    artifacts,
    registered,
    ctx: {
      tools: { register: (d: unknown) => (registered.push(d), () => { id += 1 }) },
      huaqiuAuth: auth,
      huaqiuArtifacts: artifacts,
      get: () => undefined,
    } as Record<string, unknown>,
  }
}

describe('@huaqiu/dsh-tool-symbol-footprint plugin', () => {
  it('exposes the expected node plugin shape', () => {
    expect(name).toBe('@huaqiu/dsh-tool-symbol-footprint')
    expect(inject).toEqual(['tools', 'huaqiuAuth', 'huaqiuArtifacts', 'webServer'])
    expect(typeof apply).toBe('function')
    expect(Array.isArray(packageTypes)).toBe(true)
    // Component-gen backend factory: reused by the standalone server.
    expect(typeof createComponentGenBackend).toBe('function')
    expect(packageTypes.length).toBeGreaterThan(0)
  })

  it('registers the three generation tools', () => {
    const { ctx, registered } = ctxStub()
    apply(ctx as never)
    const names = (registered as Tool[]).map((t) => t.name)
    expect(names).toEqual([
      'generate_symbol_from_image',
      'generate_footprint_from_image',
      'generate_footprint_from_dimensions',
    ])
  })

  it('rolls back earlier tools when registration fails partway through', () => {
    const { ctx } = ctxStub()
    const disposed: string[] = []
    const failure = new Error('registration failed')
    let calls = 0

    ;(ctx.tools as { register(tool: Tool): () => void }).register = (tool) => {
      calls += 1
      if (calls === 3) {
        throw failure
      }
      return () => {
        disposed.push(tool.name)
      }
    }

    expect(() => apply(ctx as never)).toThrow(failure)
    expect(disposed).toEqual([
      'generate_footprint_from_image',
      'generate_symbol_from_image',
    ])
  })

  it('throws loudly when the tools service is missing', () => {
    expect(() => apply({} as never)).toThrow(/requires the DSH/)
  })

  it('throws loudly when the huaqiuAuth service is missing', () => {
    const { ctx } = ctxStub()
    expect(() => apply({ ...ctx, huaqiuAuth: undefined } as never)).toThrow(/huaqiuAuth/)
  })

  it('throws loudly when the huaqiuArtifacts service is missing', () => {
    const { ctx } = ctxStub()
    expect(() => apply({ ...ctx, huaqiuArtifacts: undefined } as never)).toThrow(/huaqiuArtifacts/)
  })

  it('returns a disposer that unregisters the tools', () => {
    const { ctx, registered } = ctxStub()
    const dispose = apply(ctx as never)
    expect(typeof dispose).toBe('function')
    dispose()
    // register returned a disposer per tool; the plugin-level dispose calls them.
    expect(registered.length).toBe(3)
  })

  it('has no @hqedge dependency (import or manifest)', async () => {
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
