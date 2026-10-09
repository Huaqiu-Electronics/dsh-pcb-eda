import { describe, expect, it } from 'vitest'
import type { HuaqiuAuthService } from '@huaqiu/dsh-auth'
import type { CreateArtifactResult, HuaqiuArtifacts } from '@huaqiu/dsh-artifacts'
import { resolveConfig } from '../src/config.js'
import { extractModuleGraph, extractSchematic, runGenerateSchematic, runGenerateSystem, type SchematicGenEnv } from '../src/tools.js'
import { HTTP_TIMEOUT_MS } from '../src/sse.js'

function stubAuth(userId = 'u1', token = 'tok-1'): HuaqiuAuthService['auth'] {
  return {
    isAuthenticated: async () => true,
    getAccessToken: async () => token,
    getUserInfo: async () => (userId ? { id: userId, token } : null),
    login: async () => {},
    logout: async () => {},
    validate: async () => ({ status: 'valid' }),
    invalidate: () => {},
    onAuthStateChanged: () => () => {},
  }
}

function stubArtifacts(store = true): { artifacts: HuaqiuArtifacts; created: CreateArtifactResult[] } {
  const created: CreateArtifactResult[] = []
  const artifacts: HuaqiuArtifacts = {
    create: async (input) => {
      if (!store) throw new Error('store unavailable')
      const c = { id: 'art_' + created.length, type: input.type, filename: input.filename, size: input.content.length }
      created.push(c)
      return c
    },
    get: async () => null,
    readContent: async () => null,
    // The Place channel: a stable file:// URI per stored artifact.
    getDownloadUri: async (id) => (created.some((c) => c.id === id) ? 'file:///tmp/dsh-artifacts/' + id + '/content' : null),
    delete: async () => {},
    deleteAll: async () => 0,
  }
  return { artifacts, created }
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  const body = events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('')
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(body)); controller.close() },
  }), { status: 200 })
}

function zipResponse(bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, { status: 200 })
}

function makeEnv(overrides: Partial<SchematicGenEnv> = {}): SchematicGenEnv {
  const { artifacts } = stubArtifacts()
  return {
    config: resolveConfig({}),
    auth: stubAuth(),
    artifacts,
    timeoutMs: HTTP_TIMEOUT_MS,
    ...overrides,
  }
}

describe('extractSchematic', () => {
  it('collects inline .kicad_sch files and the project name', () => {
    const out = extractSchematic({
      outProject: 'Proj',
      schFiles: [{ filename: 'A.kicad_sch', content: '(a)' }, { filename: 'B.kicad_sch', content: 123 }],
      error: '',
    })
    expect(out.outProject).toBe('Proj')
    expect(out.schFiles).toEqual([
      { filename: 'A.kicad_sch', content: '(a)' },
      { filename: 'B.kicad_sch', content: '123' },
    ])
  })
  it('tolerates missing files', () => {
    expect(extractSchematic({}).schFiles).toEqual([])
  })
})

describe('extractModuleGraph', () => {
  it('returns the module_graph object or null', () => {
    expect(extractModuleGraph({ module_graph: { modules: [] } })).toEqual({ modules: [] })
    expect(extractModuleGraph({ module_graph: null })).toBeNull()
    expect(extractModuleGraph({})).toBeNull()
  })
})

describe('runGenerateSchematic', () => {
  it('returns needs_auth (not a throw) when there is no eda.cn login', async () => {
    const env = makeEnv({ auth: stubAuth('', '') })
    const result = await runGenerateSchematic({ description: 'x' }, undefined, env)
    expect(result.status).toBe('needs_auth')
    expect(result.kind).toBe('schematic')
    expect(String(result.hint)).toMatch(/login/)
  })

  it('stores the project zip (sheets + footprints) as a preview artifact', async () => {
    const { artifacts, created } = stubArtifacts()
    const zipBytes = new TextEncoder().encode('PK\x03\x04 fake zip')
    const env = makeEnv({
      artifacts,
      deps: {
        fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
          const href = String(url)
          // The copilotkit SSE stream (design agent) vs the zip download from
          // `project_achieve_url` (the source-of-truth project zip).
          if (href.includes('copilotkit')) {
            return sseResponse([
              { type: 'STATE_SNAPSHOT', snapshot: {
                outProject: 'PSU',
                project_achieve_url: 'https://datastream.eda.cn/uploaded/PSU.zip',
                schFiles: [{ filename: 'PSU.kicad_sch', content: '(kicad (version 20231118))' }],
              } },
              { type: 'RUN_FINISHED' },
            ])
          }
          return zipResponse(zipBytes)
        },
      },
    })
    const result = await runGenerateSchematic({ description: '5V supply' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.kind).toBe('schematic')
    expect(result.design_name).toBe('PSU')
    // Single source of truth: one `zip` artifact, no per-sheet artifacts.
    expect((result.zipArtifact as { type: string; filename: string } | undefined)?.type).toBe('zip')
    expect((result.zipArtifact as { filename: string }).filename).toBe('PSU.zip')
    expect(result.zip_bytes).toBe(zipBytes.length)
    expect(result.schArtifacts).toBeUndefined()
    // The Place channel: the stored zip carries a resolvable file:// URI.
    expect((result.zipArtifact as { uri?: string }).uri).toMatch(/^file:\/\//)
    expect(created).toHaveLength(1)
  })

  it('falls back to inline sheets when no project zip URL is provided', async () => {
    const { artifacts, created } = stubArtifacts()
    const env = makeEnv({
      artifacts,
      deps: {
        fetchImpl: async () => sseResponse([
          { type: 'STATE_SNAPSHOT', snapshot: {
            outProject: 'PSU',
            schFiles: [{ filename: 'PSU.kicad_sch', content: '(kicad)' }],
          } },
          { type: 'RUN_FINISHED' },
        ]),
      },
    })
    const result = await runGenerateSchematic({ description: 'x' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.zipArtifact).toBeUndefined()
    // Legacy fallback: each sheet is stored and rendered individually.
    expect((result.schFiles as Array<{ filename: string }>)[0]!.filename).toBe('PSU.kicad_sch')
    expect((result.schArtifacts as Array<{ type: string }>)[0]!.type).toBe('schematic')
    expect(created).toHaveLength(1)
  })

  it('refuses to download a zip from a non-eda.cn host (SSRF guard)', async () => {
    const { artifacts } = stubArtifacts()
    let zipFetched = false
    const env = makeEnv({
      artifacts,
      deps: {
        fetchImpl: async (url: string | URL | Request) => {
          const href = String(url)
          // Quota pre-check: answered BEFORE the copilotkit/zip handling so the
          // SSRF flag below only ever counts zip downloads.
          if (href.includes('/sub-api/subscriptions/active')) {
            return new Response(JSON.stringify({ code: 200, result: { currentQuota: 5 } }), { status: 200 })
          }
          if (href.includes('copilotkit')) {
            return sseResponse([
              { type: 'STATE_SNAPSHOT', snapshot: {
                outProject: 'PSU',
                project_achieve_url: 'https://evil.example.com/steal.zip',
                schFiles: [{ filename: 'PSU.kicad_sch', content: '(kicad)' }],
              } },
              { type: 'RUN_FINISHED' },
            ])
          }
          zipFetched = true
          return new Response('nope', { status: 200 })
        },
      },
    })
    const result = await runGenerateSchematic({ description: 'x' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.zipArtifact).toBeUndefined()
    expect(zipFetched).toBe(false)
    expect((result.schFiles as Array<{ filename: string }>)[0]!.filename).toBe('PSU.kicad_sch')
  })

  it('falls back to inline sheets when the zip download fails', async () => {
    const { artifacts } = stubArtifacts()
    const env = makeEnv({
      artifacts,
      deps: {
        fetchImpl: async (url: string | URL | Request) => {
          const href = String(url)
          if (href.includes('copilotkit')) {
            return sseResponse([
              { type: 'STATE_SNAPSHOT', snapshot: {
                outProject: 'PSU',
                project_achieve_url: 'https://datastream.eda.cn/gone.zip',
                schFiles: [{ filename: 'PSU.kicad_sch', content: '(kicad)' }],
              } },
              { type: 'RUN_FINISHED' },
            ])
          }
          return new Response('nope', { status: 404 })
        },
      },
    })
    const result = await runGenerateSchematic({ description: 'x' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.zipArtifact).toBeUndefined()
    expect((result.schFiles as Array<{ filename: string }>)[0]!.filename).toBe('PSU.kicad_sch')
    // Degraded state is split by audience: the card still renders the sheet.
    expect((result.schArtifacts as Array<{ type: string }>)[0]!.type).toBe('schematic')
  })

  it('throws when the agent produced no files', async () => {
    const env = makeEnv({
      deps: {
        fetchImpl: async () => sseResponse([
          { type: 'STATE_SNAPSHOT', snapshot: { schFiles: [] } },
          { type: 'RUN_FINISHED' },
        ]),
      },
    })
    await expect(runGenerateSchematic({ description: 'x' }, undefined, env)).rejects.toThrow(/no \.kicad_sch files/)
  })
})

describe('runGenerateSystem', () => {
  it('stores the project zip as a zip artifact (never inline)', async () => {
    const { artifacts, created } = stubArtifacts()
    const zip = new Uint8Array([0x50,0x4b,0x03,0x04,1,2,3])
    const env = makeEnv({
      artifacts,
      deps: {
        fetchImpl: async (url: RequestInfo | URL) => {
          if (String(url).includes('copilotkit')) {
            return sseResponse([
              { type: 'STATE_SNAPSHOT', snapshot: {
                design_name: 'STM32F103C8T6迷你开发板',
                module_graph: { modules: [{ name: 'MCU' }, { name: 'LDO' }], connections: [1, 2, 3] },
                connection_count: 3,
              } },
              { type: 'RUN_FINISHED' },
            ])
          }
          return zipResponse(zip)
        },
      },
    })
    const result = await runGenerateSystem({ description: 'an STM32 mini dev board' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.kind).toBe('system')
    expect(result.design_name).toBe('STM32F103C8T6迷你开发板')
    expect(result.module_count).toBe(2)
    expect(result.connection_count).toBe(3)
    expect((result.zipArtifact as { filename: string }).filename).toBe('STM32F103C8T6迷你开发板.zip')
    expect(result.zip).toBeUndefined()
    expect(created).toHaveLength(1)
    expect(created[0]!.type).toBe('zip')
  })

  it('falls back to inline zip when the artifact store is unavailable and zip is small', async () => {
    const { artifacts } = stubArtifacts(false)
    const zip = new Uint8Array([1,2,3])
    const env = makeEnv({
      artifacts,
      deps: {
        fetchImpl: async (url: RequestInfo | URL) => {
          if (String(url).includes('copilotkit')) {
            return sseResponse([
              { type: 'STATE_SNAPSHOT', snapshot: { design_name: 'Board', module_graph: { modules: [] }, connection_count: 0 } },
              { type: 'RUN_FINISHED' },
            ])
          }
          return zipResponse(zip)
        },
      },
    })
    const result = await runGenerateSystem({ description: 'x' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.zip).toMatch(/^data:application\/zip;base64,/)
    expect(result.zipArtifact).toBeUndefined()
  })

  it('throws when no module_graph came back', async () => {
    const env = makeEnv({
      deps: {
        fetchImpl: async () => sseResponse([
          { type: 'STATE_SNAPSHOT', snapshot: { error: 'the design failed' } },
          { type: 'RUN_FINISHED' },
        ]),
      },
    })
    await expect(runGenerateSystem({ description: 'x' }, undefined, env)).rejects.toThrow(/no module_graph/)
  })

  it('returns needs_auth for the system tool without a login', async () => {
    const env = makeEnv({ auth: stubAuth('', '') })
    const result = await runGenerateSystem({ description: 'x' }, undefined, env)
    expect(result.status).toBe('needs_auth')
    expect(result.kind).toBe('system')
  })
})

describe('GEN subscription quota pre-check', () => {
  /** Quota URL → `quotaResponse`; copilotkit → a valid generated run. */
  function quotaEnv(quotaResponse: unknown, quotaThrows = false): SchematicGenEnv {
    return makeEnv({
      deps: {
        fetchImpl: async (url: string | URL | Request) => {
          const u = String(url)
          if (u.includes('/sub-api/subscriptions/active')) {
            if (quotaThrows) throw new Error('quota api down')
            return new Response(JSON.stringify(quotaResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          if (u.includes('copilotkit')) {
            return sseResponse([
              { type: 'STATE_SNAPSHOT', snapshot: {
                outProject: 'PSU',
                design_name: 'PSU',
                module_graph: { modules: [{ name: 'MCU' }, { name: 'LDO' }], connections: [1, 2, 3] },
                connection_count: 3,
                project_achieve_url: 'https://datastream.eda.cn/proj.zip',
                schFiles: [{ filename: 'PSU.kicad_sch', content: '(kicad)' }],
              } },
              { type: 'RUN_FINISHED' },
            ])
          }
          if (u.includes('export-zip')) {
            return zipResponse(new TextEncoder().encode('PK\x03\x04 fake zip'))
          }
          return new Response('nope', { status: 404 })
        },
      },
    })
  }

  it('returns needs_subscription (not a throw) when the GEN quota is exhausted', async () => {
    const env = quotaEnv({ code: 200, result: { packageName: 'Pro', currentQuota: 0, totalQuota: 10 } })
    const result = await runGenerateSchematic({ description: 'x' }, undefined, env)
    expect(result.status).toBe('needs_subscription')
    expect(result.kind).toBe('schematic')
    expect(result.packageName).toBe('Pro')
    expect(result.currentQuota).toBe(0)
    // The model MUST be told every time (this is the every-call notice).
    expect(String(result.hint)).toMatch(/no available GEN generation quota/)
  })

  it('fails OPEN when the quota API is unreachable (a flaky check never blocks a run)', async () => {
    const env = quotaEnv(null, true)
    const result = await runGenerateSystem({ description: 'x' }, undefined, env)
    expect(result.status).not.toBe('needs_subscription')
    expect(result.status).toBe('generated')
  })

  it('lets the run proceed when quota is available', async () => {
    const env = quotaEnv({ code: 200, result: { packageName: 'Pro', currentQuota: 5, totalQuota: 10 } })
    const result = await runGenerateSchematic({ description: 'x' }, undefined, env)
    expect(result.status).toBe('generated')
  })

  it('reports an unsubscribed account as needs_subscription too', async () => {
    const env = quotaEnv({ code: 200, result: null })
    const result = await runGenerateSystem({ description: 'x' }, undefined, env)
    expect(result.status).toBe('needs_subscription')
    expect(result.kind).toBe('system')
  })
})
