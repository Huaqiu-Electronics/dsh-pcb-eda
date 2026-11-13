import { describe, expect, it } from 'vitest'
import type { HuaqiuAuthService } from '@huaqiu/dsh-auth'
import type { HuaqiuArtifacts, CreateArtifactResult } from '@huaqiu/dsh-artifacts'
import { runGenerateFootprintFromDimensions, runGenerateFootprintFromImage, runGenerateSymbol, type SymbolFootprintEnv } from '../src/tools.js'
import type { SocketLike } from '../src/protocol.js'

type Tool = { name: string; execute(args: unknown, exec?: unknown): Promise<unknown> }

/** A fake socket that emits the awaited AGENT frame on open. */
function emitOnOpen(action: { action: string; context: unknown }, extra: unknown[] = []) {
  const frames = [...extra, { type: 6, action: action.action, context: action.context }]
  return () => {
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: () => {},
      close: () => {},
    }
    // Defer until the caller wires handlers (callComponentAgent sets onopen
    // synchronously before returning the promise).
    queueMicrotask(() => {
      for (const f of frames) socket.onmessage?.({ data: JSON.stringify(f) })
      socket.onopen?.(null)
    })
    return socket
  }
}

function stubAuth(authenticated = true): HuaqiuAuthService['auth'] {
  return {
    isAuthenticated: async () => authenticated,
    getAccessToken: async () => (authenticated ? 'tok-1' : null),
    getUserInfo: async () => (authenticated ? { id: 'u1', token: 'tok-1' } : null),
    login: async () => {},
    logout: async () => {},
    validate: async () => (
      authenticated
        ? { status: 'valid' as const }
        : { status: 'invalid' as const, reason: 'unauthorized' as const }
    ),
    invalidate: () => {},
    onAuthStateChanged: () => () => {},
  }
}

function stubEnv(overrides: Partial<SymbolFootprintEnv> = {}): SymbolFootprintEnv {
  const auth: HuaqiuAuthService = {
    auth: stubAuth(),
    setCredentials: () => {},
    invalidate: () => {},
    hostMode: false,
  }
  const created: CreateArtifactResult[] = []
  const artifacts: HuaqiuArtifacts = {
    create: async (input) => {
      const c = { id: 'art_' + created.length, type: input.type, filename: input.filename, size: Buffer.byteLength(input.content) }
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
  return {
    auth: auth.auth,
    artifacts,
    deps: { processEnv: {}, random: () => 0.1234567 },
    getUserQuestions: () => undefined,
    ...overrides,
  }
}

const FETCH_OK = async (_url: RequestInfo | URL) => new Response('(kicad (version 20231118))')

describe('symbol-footprint tool bodies', () => {
  it('returns needs_auth for generate_symbol_from_image without a token', async () => {
    const env = stubEnv({ auth: stubAuth(false) })
    const result = await runGenerateSymbol({ image_url: 'data:image/png;base64,AAAA' }, undefined, env)
    expect(result.status).toBe('needs_auth')
    expect(result.kind).toBe('symbol')
  })

  it('returns needs_auth for the footprint tools without a token', async () => {
    const env = stubEnv({ auth: stubAuth(false) })
    const r1 = await runGenerateFootprintFromImage({ image_url: 'data:image/png;base64,AAAA' }, undefined, env)
    expect(r1.status).toBe('needs_auth')
    const r2 = await runGenerateFootprintFromDimensions({ package_type: 'sop', dimensions: { W: 6.2 } }, undefined, env)
    expect(r2.status).toBe('needs_auth')
    expect(r2.kind).toBe('footprint')
  })

  it('generate_symbol_from_image stores the generated symbol as an artifact', async () => {
    const env = stubEnv({
      deps: {
        processEnv: {},
        random: () => 0.1234567,
        socketFactory: emitOnOpen({ action: 'symbol_button', context: { params: '{"fileUrl":"https://x/y.kicad_sym"}' } }),
        fetchImpl: FETCH_OK,
      },
    })
    const result = await runGenerateSymbol({ image_url: 'data:image/png;base64,AAAA' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.kind).toBe('symbol')
    expect(result.artifact).toMatchObject({ type: 'symbol', filename: 'y.kicad_sym' })
    // The Place channel: the stored artifact carries a resolvable file:// URI.
    expect((result.artifact as { uri?: string }).uri).toMatch(/^file:\/\//)
    // Content is NOT inlined when the artifact store succeeds.
    expect(result.content).toBeUndefined()
  })

  it('generate_footprint_from_image returns needs_confirmation with dimensions', async () => {
    const env = stubEnv({
      deps: {
        processEnv: {},
        random: () => 0.1234567,
        socketFactory: emitOnOpen({
          action: 'footprint_dimensions',
          context: { fileName: 'SOIC-8.kicad_mod', pkgType: 'sop', dimensions: { W: 6.2, L: 5.0 } },
        }),
        fetchImpl: FETCH_OK,
      },
    })
    const result = await runGenerateFootprintFromImage({ image_url: 'data:image/png;base64,AAAA' }, undefined, env)
    expect(result.status).toBe('needs_confirmation')
    expect(result.kind).toBe('footprint')
    expect((result as { dimensions: unknown }).dimensions).toEqual({ W: 6.2, L: 5.0 })
    // The follow-up directive is agent-only (see the src/tools.ts module
    // header) — it travels on `agentNote` and must NOT land on `note`, which is
    // the field the client card renders as user copy.
    expect(result.agentNote).toMatch(/web client renders/)
    expect(result.note).toBeUndefined()
  })

  it('generate_footprint_from_dimensions requires a supported package_type', async () => {
    const env = stubEnv()
    await expect(runGenerateFootprintFromDimensions({ dimensions: { W: 1 } }, undefined, env))
      .rejects.toThrow(/package_type is required/)
    await expect(runGenerateFootprintFromDimensions({ package_type: 'bogus', dimensions: { W: 1 } }, undefined, env))
      .rejects.toThrow(/unsupported package_type/)
  })

  it('generate_footprint_from_dimensions generates and stores the footprint', async () => {
    const sentCommands: Array<Record<string, unknown>> = []
    const env = stubEnv({
      deps: {
        processEnv: {},
        random: () => 0.1234567,
        socketFactory: () => {
          const socket: SocketLike = {
            onopen: null,
            onmessage: null,
            onerror: null,
            onclose: null,
            send: (payload) => { sentCommands.push(JSON.parse(String(payload)) as Record<string, unknown>) },
            close: () => {},
          }
          queueMicrotask(() => {
            socket.onopen?.(null)
            socket.onmessage?.({
              data: JSON.stringify({
                type: 6,
                action: 'footprint_button',
                context: { params: '{"fileUrl":"https://x/SOIC8.kicad_mod"}' },
              }),
            })
          })
          return socket
        },
        fetchImpl: FETCH_OK,
      },
    })
    const result = await runGenerateFootprintFromDimensions(
      {
        image: 'data:image/png;base64,AAAA',
        package_type: 'sop',
        dimensions: { W: 6.2, L: 5.0 },
        file_name: 'SOIC-8',
      },
      undefined,
      env,
    )
    expect(result.status).toBe('generated')
    expect(result.kind).toBe('footprint')
    expect(result.pkgType).toBe('sop')
    expect(result.artifact).toMatchObject({ type: 'footprint', filename: 'SOIC8.kicad_mod' })
    expect((sentCommands[0]?.context as { chat?: { base64_images?: string[] } }).chat?.base64_images)
      .toEqual(['data:image/png;base64,AAAA'])
  })

  it('renders the direct-footprint question in the configured HITL language', async () => {
    const captured: Record<string, unknown>[] = []
    const userQuestions = {
      ask: async (options: Record<string, unknown>) => {
        captured.push(options)
        return { answers: [{ selected: ['使用'] }] }
      },
    }
    const directEnv = {
      deps: {
        processEnv: {},
        random: () => 0.1234567,
        socketFactory: emitOnOpen({ action: 'footprint_button', context: { params: '{"fileUrl":"https://x/auto.kicad_mod"}' } }),
        fetchImpl: FETCH_OK,
      },
      getUserQuestions: () => userQuestions,
    }

    // No `hitlLanguage` → the package default (zh), matching the card copy.
    const zh = await runGenerateFootprintFromImage({ image_url: 'data:image/png;base64,AAAA' }, undefined, stubEnv(directEnv))
    expect(zh.status).toBe('generated')
    expect(zh.confirmedByUser).toBe(true)
    expect(captured[0]).toBeDefined()
    expect((captured[0]!.questions as Array<{ header: string }>)[0]!.header).toBe('封装')

    captured.length = 0
    await runGenerateFootprintFromImage(
      { image_url: 'data:image/png;base64,AAAA' },
      undefined,
      stubEnv(Object.assign({}, directEnv, { hitlLanguage: 'en' as const })),
    )
    expect((captured[0]!.questions as Array<{ header: string }>)[0]!.header).toBe('Footprint')
  })

  it('the direct footprint path falls back to a generated result when no user-questions channel', async () => {
    const env = stubEnv({
      deps: {
        processEnv: {},
        random: () => 0.1234567,
        socketFactory: emitOnOpen({ action: 'footprint_button', context: { params: '{"fileUrl":"https://x/auto.kicad_mod"}' } }),
        fetchImpl: FETCH_OK,
      },
    })
    const result = await runGenerateFootprintFromImage({ image_url: 'data:image/png;base64,AAAA' }, undefined, env)
    expect(result.status).toBe('generated')
    expect(result.autoGenerated).toBe(true)
    expect(result.agentNote).toMatch(/no dimensions to confirm/)
    expect(result.note).toBeUndefined()
  })
})

describe('tool schema/execute shape', () => {
  it('tools are registry-ready defineTool definitions with json output', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile(new URL('../src/tools.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/defineTool/)
    expect(source).toMatch(/\{ type: 'json' \}/)
    expect(source).not.toMatch(/from\s+['"]@hqedge/)
  })
})
