/**
 * Tests for the dsh-eda-host schematic→PCB sync client + tool.
 *
 * Covers the task spec:
 *   - the tool registers under `sync_schematic_to_pcb` with no parameters
 *   - it dispatches exactly one sync command via the client (a single POST to
 *     the sync route) — never a netlist/query RPC
 *   - 200 → ok:true; error statuses map to the semantic kinds (412 / 501 /
 *     503 / 504 / 500) used by the other tools
 *   - a timed-out / aborted request is DEADLINE_EXCEEDED, never a no-op
 *   - a connection failure is UNAVAILABLE
 *   - the tool surfaces host failures as ok:false with the semantic kind
 *   - the runtime abort signal is propagated into the request
 */
import { describe, expect, it } from 'vitest'
import {
  createEdaHostClient,
  type EdaHostClient,
  type EdaHostRequestOptions,
} from '../src/client.js'
import { createEdaHostTools } from '../src/tools.js'
import { NetlistError } from '../src/types.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const BASE_CONFIG = { hqEdgeBaseUrl: 'http://host:18080' }

describe('createEdaHostClient — syncSchematicToPcb', () => {
  it('POSTs exactly once to the sync route and resolves on 200', async () => {
    const seen: string[] = []
    const methods: string[] = []
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async (url: URL | RequestInfo, init) => {
        seen.push(String(url))
        methods.push((init as RequestInit | undefined)?.method ?? 'GET')
        return jsonResponse(200, { ok: true })
      },
    })

    await client.syncSchematicToPcb()

    expect(seen).toEqual(['http://host:18080/api/v1/sync-schematic-to-pcb'])
    expect(methods).toEqual(['POST'])
  })

  it('maps 412 → FAILED_PRECONDITION, 501 → UNIMPLEMENTED, 503 → UNAVAILABLE, 504 → DEADLINE_EXCEEDED, 500 → INTERNAL', async () => {
    const cases: Array<[number, string]> = [
      [412, 'FAILED_PRECONDITION'],
      [501, 'UNIMPLEMENTED'],
      [503, 'UNAVAILABLE'],
      [504, 'DEADLINE_EXCEEDED'],
      [500, 'INTERNAL'],
    ]
    for (const [status, kind] of cases) {
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async () => jsonResponse(status, { error: 'x', detail: 'boom' }),
      })
      await expect(
        client.syncSchematicToPcb(),
        `status ${status} should be ${kind}`,
      ).rejects.toMatchObject({ kind })
    }
  })

  it('maps a connection failure to UNAVAILABLE', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(client.syncSchematicToPcb()).rejects.toMatchObject({ kind: 'UNAVAILABLE' })
  })

  it('maps an aborted request to DEADLINE_EXCEEDED, never to a no-op', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async (_url, init) => {
        if ((init as RequestInit | undefined)?.signal?.aborted) {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          throw err
        }
        return jsonResponse(200, { ok: true })
      },
    })
    await expect(client.syncSchematicToPcb({ signal: controller.signal })).rejects.toMatchObject({
      kind: 'DEADLINE_EXCEEDED',
    })
  })

  it('propagates the abort signal into the request', async () => {
    const controller = new AbortController()
    controller.abort()
    let observed: unknown = undefined
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async (_url, init) => {
        observed = (init as RequestInit | undefined)?.signal
        return jsonResponse(200, { ok: true })
      },
    })
    await client.syncSchematicToPcb({ signal: controller.signal })
    // The client propagates the caller's abort signal into the request (combined
    // with its own budget), so the request is already aborted.
    expect(observed).toBeDefined()
    expect((observed as AbortSignal | undefined)?.aborted).toBe(true)
  })

  it('throws FAILED_PRECONDITION when no base URL is resolvable', async () => {
    const client = createEdaHostClient(
      { hqEdgeBaseUrl: '' },
      { baseUrlResolver: () => undefined },
    )
    await expect(client.syncSchematicToPcb()).rejects.toMatchObject({
      kind: 'FAILED_PRECONDITION',
    })
  })
})

describe('createEdaHostTools — sync_schematic_to_pcb', () => {
  function hostEnvOf(syncImpl: () => Promise<void>): EdaHostClient {
    return {
      getProjectNetlist: async () => ({ components: [], nets: [] }),
      getSelectionNetlist: async () => ({ components: [], nets: [] }),
      getActivePageNetlist: async () => ({ components: [], nets: [] }),
      getEdaHostInfo: async () => {
        throw new Error('not used')
      },
      getEdaHostCapabilities: async () => {
        throw new Error('not used')
      },
      getPcbSelection: async () => {
        throw new Error('not used')
      },
      getPcbBoard: async () => {
        throw new Error('not used')
      },
      syncSchematicToPcb: (async (options?: EdaHostRequestOptions) => {
        void options
        await syncImpl()
      }) as EdaHostClient['syncSchematicToPcb'],
      getRenderCapabilities: async () => {
        throw new Error('not used')
      },
      listSchematicSheets: async () => {
        throw new Error('not used')
      },
      renderSchematic: async () => {
        throw new Error('not used')
      },
    }
  }

  it('registers the sync tool with no input parameters', () => {
    const tools = createEdaHostTools({ client: hostEnvOf(async () => {}) })
    const tool = tools.find((t) => t.name === 'sync_schematic_to_pcb')!
    expect(tool).toBeDefined()
    // The tool takes no arguments — the parameter schema has no properties.
    expect((tool.parameters as { properties: Record<string, unknown> }).properties).toEqual({})
  })

  it('dispatches exactly one sync command on invocation', async () => {
    let calls = 0
    const tools = createEdaHostTools({
      client: hostEnvOf(async () => {
        calls += 1
      }),
    })
    const tool = tools.find((t) => t.name === 'sync_schematic_to_pcb')!
    const result = (await tool.execute({}, {} as never)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('returns ok:true when the host executes the command', async () => {
    const tools = createEdaHostTools({ client: hostEnvOf(async () => {}) })
    const tool = tools.find((t) => t.name === 'sync_schematic_to_pcb')!
    const result = (await tool.execute({}, {} as never)) as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  it('surfaces host failures as ok:false with a semantic kind', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf(async () => {
        throw new NetlistError('UNIMPLEMENTED', 'sync not supported by this host')
      }),
    })
    const tool = tools.find((t) => t.name === 'sync_schematic_to_pcb')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('UNIMPLEMENTED')
  })

  it('surfaces transport failures as ok:false with INTERNAL for unknown errors', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf(async () => {
        throw new Error('boom')
      }),
    })
    const tool = tools.find((t) => t.name === 'sync_schematic_to_pcb')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('INTERNAL')
  })

  it('propagates the abort signal through to the client', async () => {
    let observed: unknown = undefined
    const client: EdaHostClient = {
      getProjectNetlist: async () => ({ components: [], nets: [] }),
      getSelectionNetlist: async () => ({ components: [], nets: [] }),
      getActivePageNetlist: async () => ({ components: [], nets: [] }),
      getEdaHostInfo: async () => {
        throw new Error('not used')
      },
      getEdaHostCapabilities: async () => {
        throw new Error('not used')
      },
      getPcbSelection: async () => {
        throw new Error('not used')
      },
      getPcbBoard: async () => {
        throw new Error('not used')
      },
      syncSchematicToPcb: (async (options?: EdaHostRequestOptions) => {
        observed = options?.signal
      }) as EdaHostClient['syncSchematicToPcb'],
      getRenderCapabilities: async () => {
        throw new Error('not used')
      },
      listSchematicSheets: async () => {
        throw new Error('not used')
      },
      renderSchematic: async () => {
        throw new Error('not used')
      },
    }
    const tools = createEdaHostTools({ client })
    const tool = tools.find((t) => t.name === 'sync_schematic_to_pcb')!
    const controller = new AbortController()
    await tool.execute({}, { signal: controller.signal } as never)
    expect(observed).toBe(controller.signal)
  })
})
