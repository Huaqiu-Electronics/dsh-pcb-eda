/**
 * Tests for the dsh-eda-host netlist client + tools.
 *
 * Covers the semantic rules of the task spec:
 *   - a populated design stays populated (the P0 double-nesting regression)
 *   - a genuine empty result (200 + empty netlist) is OK, not an error
 *   - HTTP status → semantic error kind (412 → FAILED_PRECONDITION,
 *     501 → UNIMPLEMENTED, 503 → UNAVAILABLE, 504 → DEADLINE_EXCEEDED,
 *     500 → INTERNAL)
 *   - a timed-out request is DEADLINE_EXCEEDED, never an empty result
 *   - malformed responses are explicit errors, never empty results
 *   - tools surface { ok, scope, netlist | error.kind } without fabricating data
 */
import { describe, expect, it } from 'vitest'
import {
  createEdaHostClient,
  parseNetlistBody,
  type EdaHostClient,
  type EdaHostRequestOptions,
} from '../src/client.js'
import { createEdaHostTools, createNetListTools } from '../src/tools.js'
import { NetlistError, type SchematicNetlist } from '../src/types.js'
import {
  EMPTY_NETLIST_BODY,
  LEGACY_EMPTY_NETLIST_BODY,
  LEGACY_POPULATED_NETLIST_BODY,
  POPULATED_NETLIST_BODY,
} from './fixtures/hq-edge-netlist-responses.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const BASE_CONFIG = { hqEdgeBaseUrl: 'http://host:18080' }

describe('parseNetlistBody — real hq-edge wire shapes', () => {
  it('reads a populated netlist from the CURRENT single-level body', () => {
    const netlist = parseNetlistBody(POPULATED_NETLIST_BODY)
    expect(netlist.components).toHaveLength(1)
    expect(netlist.components[0]?.referenceDesignators).toEqual(['R1'])
    expect(netlist.nets).toHaveLength(1)
    expect(netlist.nets[0]?.name).toBe('GND')
  })

  it('unwraps the LEGACY double-nested body instead of reporting empty', () => {
    // Regression guard: this exact shape used to yield components:[] / nets:[].
    const netlist = parseNetlistBody(LEGACY_POPULATED_NETLIST_BODY)
    expect(netlist.components).toHaveLength(1)
    expect(netlist.components[0]?.value).toBe('10k')
    expect(netlist.nets[0]?.pinReferences[0]).toEqual({
      referenceDesignator: 'R1',
      pinNumber: '2',
    })
  })

  it('treats a genuinely empty design as empty (current + legacy)', () => {
    expect(parseNetlistBody(EMPTY_NETLIST_BODY)).toEqual({ components: [], nets: [] })
    expect(parseNetlistBody(LEGACY_EMPTY_NETLIST_BODY)).toEqual({ components: [], nets: [] })
  })

  it('rejects malformed bodies instead of degrading to empty', () => {
    for (const bad of [
      null,
      undefined,
      'nope',
      {},
      { netlist: null },
      { netlist: 'x' },
      { netlist: [] },
      { netlist: { components: 'not-an-array' } },
      { netlist: { nets: 42 } },
    ]) {
      expect(() => parseNetlistBody(bad), `body: ${JSON.stringify(bad)}`).toThrow(NetlistError)
    }
  })

  it('classifies a malformed body as INTERNAL, not as a valid design', () => {
    try {
      parseNetlistBody({ netlist: { components: 'nope' } })
      throw new Error('expected parseNetlistBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(NetlistError)
      expect((err as NetlistError).kind).toBe('INTERNAL')
    }
  })
})

describe('createEdaHostClient — netlist', () => {
  it('returns a populated netlist end to end (current hq-edge)', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(200, POPULATED_NETLIST_BODY),
    })
    const netlist = await client.getProjectNetlist()
    expect(netlist.components).toHaveLength(1)
    expect(netlist.nets).toHaveLength(1)
  })

  it('returns a populated netlist end to end (legacy hq-edge)', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(200, LEGACY_POPULATED_NETLIST_BODY),
    })
    expect((await client.getSelectionNetlist()).components).toHaveLength(1)
  })

  it('returns an empty netlist for a valid empty result (200)', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(200, EMPTY_NETLIST_BODY),
    })
    const netlist = await client.getProjectNetlist()
    expect(netlist.components).toEqual([])
    expect(netlist.nets).toEqual([])
  })

  it('maps 412 to FAILED_PRECONDITION', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(412, { error: 'x', detail: 'no host' }),
    })
    await expect(client.getProjectNetlist()).rejects.toMatchObject({
      kind: 'FAILED_PRECONDITION',
    })
  })

  it('maps 501 to UNIMPLEMENTED', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(501, { error: 'x', detail: 'unsupported scope' }),
    })
    await expect(client.getActivePageNetlist()).rejects.toMatchObject({
      kind: 'UNIMPLEMENTED',
    })
  })

  it('maps 503 to UNAVAILABLE, 504 to DEADLINE_EXCEEDED and 500 to INTERNAL', async () => {
    const unavailable = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(503, { error: 'x' }),
    })
    await expect(unavailable.getProjectNetlist()).rejects.toMatchObject({ kind: 'UNAVAILABLE' })

    const deadline = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(504, { error: 'x' }),
    })
    await expect(deadline.getProjectNetlist()).rejects.toMatchObject({
      kind: 'DEADLINE_EXCEEDED',
    })

    const internal = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(500, { error: 'x' }),
    })
    await expect(internal.getProjectNetlist()).rejects.toMatchObject({ kind: 'INTERNAL' })
  })

  it('maps connection failure to UNAVAILABLE', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(client.getProjectNetlist()).rejects.toMatchObject({ kind: 'UNAVAILABLE' })
  })

  it('maps an aborted request to DEADLINE_EXCEEDED, never to an empty result', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      },
    })
    await expect(client.getProjectNetlist()).rejects.toMatchObject({
      kind: 'DEADLINE_EXCEEDED',
    })
  })

  it('never returns an empty netlist for a non-200 response', async () => {
    for (const status of [412, 500, 501, 503, 504]) {
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async () => jsonResponse(status, { error: 'x' }),
      })
      await expect(client.getProjectNetlist(), `status ${status}`).rejects.toBeInstanceOf(
        NetlistError,
      )
    }
  })

  it('prefers a baseUrlResolver (ctx.hqEdge) over static config', async () => {
    const seen: string[] = []
    const client = createEdaHostClient(
      { hqEdgeBaseUrl: 'http://stale:1' },
      {
        baseUrlResolver: () => 'http://hqedge:9',
        fetchImpl: async (url: URL | RequestInfo) => {
          seen.push(String(url))
          return jsonResponse(200, EMPTY_NETLIST_BODY)
        },
      },
    )
    await client.getSelectionNetlist()
    expect(seen[0]).toBe('http://hqedge:9/api/v1/netlist/selection')
  })

  it('falls back to static config when the resolver returns nothing', async () => {
    const seen: string[] = []
    const client = createEdaHostClient(BASE_CONFIG, {
      baseUrlResolver: () => undefined,
      fetchImpl: async (url: URL | RequestInfo) => {
        seen.push(String(url))
        return jsonResponse(200, EMPTY_NETLIST_BODY)
      },
    })
    await client.getProjectNetlist()
    expect(seen[0]).toBe('http://host:18080/api/v1/netlist/project')
  })

  it('throws FAILED_PRECONDITION when no base URL is resolvable', async () => {
    const client = createEdaHostClient(
      { hqEdgeBaseUrl: '' },
      { baseUrlResolver: () => undefined },
    )
    await expect(client.getProjectNetlist()).rejects.toMatchObject({
      kind: 'FAILED_PRECONDITION',
    })
  })

  it('passes an abort signal through to fetch', async () => {
    let observed: unknown = undefined
    const controller = new AbortController()
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async (_url, init) => {
        observed = (init as RequestInit | undefined)?.signal
        return jsonResponse(200, EMPTY_NETLIST_BODY)
      },
    })
    await client.getProjectNetlist({ signal: controller.signal })
    expect(observed).toBeDefined()
  })

  it('turns an abort during fetch into DEADLINE_EXCEEDED, not an empty netlist', async () => {
    const controller = new AbortController()
    const client = createEdaHostClient(BASE_CONFIG, {
      // Behave like a real fetch: reject once the signal has been aborted.
      fetchImpl: async (_url, init) => {
        if ((init as RequestInit | undefined)?.signal?.aborted) {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          throw err
        }
        return jsonResponse(200, POPULATED_NETLIST_BODY)
      },
    })
    controller.abort()
    await expect(client.getProjectNetlist({ signal: controller.signal })).rejects.toMatchObject({
      kind: 'DEADLINE_EXCEEDED',
    })
  })
})

describe('createEdaHostClient — host discovery', () => {
  it('returns host info', async () => {
    const info = {
      identity: { hostType: 'EDA_HOST_TYPE_KICAD', hostName: 'KiCad', version: '10.0.6' },
      installation: {
        applicationPath: '/Applications/KiCad',
        executables: [{ name: 'kicad-cli', path: '/usr/bin/kicad-cli' }],
      },
    }
    const seen: string[] = []
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async (url: URL | RequestInfo) => {
        seen.push(String(url))
        return jsonResponse(200, { info })
      },
    })
    expect(await client.getEdaHostInfo()).toEqual(info)
    expect(seen[0]).toBe('http://host:18080/api/v1/host/info')
  })

  it('has no availability field — a successful response IS the signal', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(200, { info: {} }),
    })
    // proto3 omits default-valued fields, so a host that reports nothing
    // arrives as `{}`. Since `hq.host.v1` has no `available` field, the request
    // succeeding is the only availability signal — absent values must fall
    // back to defaults rather than be read as "unavailable".
    expect(await client.getEdaHostInfo()).toEqual({
      identity: { hostType: 'EDA_HOST_TYPE_UNSPECIFIED', hostName: '', version: '' },
      installation: { applicationPath: '', executables: [] },
    })
  })

  it('ignores a legacy `available` flag instead of inferring unavailability', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () =>
        jsonResponse(200, {
          info: {
            identity: { hostType: 'EDA_HOST_TYPE_KICAD', hostName: 'KiCad', version: '10.0.6' },
            installation: {
              applicationPath: '/Applications/KiCad',
              executables: [{ name: 'kicad-cli', path: '', available: false }],
            },
            available: false,
          },
        }),
    })
    // An older host may still send `available`. It is no longer part of the
    // contract, so dropping it must not turn a reachable host into an
    // unavailable one — and an empty `path` must not be read as "not runnable".
    expect(await client.getEdaHostInfo()).toEqual({
      identity: { hostType: 'EDA_HOST_TYPE_KICAD', hostName: 'KiCad', version: '10.0.6' },
      installation: {
        applicationPath: '/Applications/KiCad',
        executables: [{ name: 'kicad-cli', path: '' }],
      },
    })
  })

  it('returns capability names and filters non-strings', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () =>
        jsonResponse(200, {
          capabilities: ['EDA_HOST_CAPABILITY_NETLIST', 'EDA_HOST_CAPABILITY_PCB', 7],
        }),
    })
    expect(await client.getEdaHostCapabilities()).toEqual([
      'EDA_HOST_CAPABILITY_NETLIST',
      'EDA_HOST_CAPABILITY_PCB',
    ])
  })

  it('rejects malformed host discovery responses', async () => {
    const badInfo = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(200, {}),
    })
    await expect(badInfo.getEdaHostInfo()).rejects.toMatchObject({ kind: 'INTERNAL' })

    const badCaps = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(200, { capabilities: 'nope' }),
    })
    await expect(badCaps.getEdaHostCapabilities()).rejects.toMatchObject({ kind: 'INTERNAL' })
  })
})

describe('createNetListTools', () => {
  function toolEnvOf(netlistOrThrow: SchematicNetlist | Error): EdaHostClient {
    const make = async (): Promise<SchematicNetlist> => {
      if (netlistOrThrow instanceof Error) throw netlistOrThrow
      return netlistOrThrow
    }
    return {
      getProjectNetlist: make,
      getSelectionNetlist: make,
      getActivePageNetlist: make,
      getEdaHostInfo: async () => {
        throw new Error('not used')
      },
      getEdaHostCapabilities: async () => {
        throw new Error('not used')
      },
    }
  }

  it('registers exactly three semantic netlist tools', () => {
    const tools = createNetListTools({ client: toolEnvOf({ components: [], nets: [] }) })
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_active_page_netlist',
      'get_project_netlist',
      'get_selection_netlist',
    ])
  })

  it('returns ok:true with the netlist for a valid empty result', async () => {
    const [projectTool] = createNetListTools({ client: toolEnvOf({ components: [], nets: [] }) })
    expect(projectTool).toBeDefined()
    const result = (await projectTool!.execute({}, {} as never)) as { ok: boolean; netlist: unknown }
    expect(result.ok).toBe(true)
    expect(result.netlist).toEqual({ components: [], nets: [] })
  })

  it('propagates UNIMPLEMENTED as ok:false with the semantic kind', async () => {
    const tools = createNetListTools({
      client: toolEnvOf(new NetlistError('UNIMPLEMENTED', 'active page not supported')),
    })
    const activeTool = tools.find((t) => t.name === 'get_active_page_netlist')!
    const result = (await activeTool.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('UNIMPLEMENTED')
  })

  it('surfaces DEADLINE_EXCEEDED as a timeout, not as an empty result', async () => {
    const tools = createNetListTools({
      client: toolEnvOf(new NetlistError('DEADLINE_EXCEEDED', 'too slow')),
    })
    const projectTool = tools.find((t) => t.name === 'get_project_netlist')!
    const result = (await projectTool.execute({}, {} as never)) as {
      ok: boolean
      netlist?: unknown
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('DEADLINE_EXCEEDED')
    expect(result.netlist).toBeUndefined()
  })

  it('never fabricates data: generic failure becomes INTERNAL ok:false', async () => {
    const tools = createNetListTools({ client: toolEnvOf(new Error('boom')) })
    const projectTool = tools.find((t) => t.name === 'get_project_netlist')!
    const result = (await projectTool!.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('INTERNAL')
  })
})

describe('createEdaHostTools', () => {
  function hostEnvOf(handlers: {
    info?: () => Promise<unknown>
    capabilities?: () => Promise<unknown>
  }): EdaHostClient {
    return {
      getProjectNetlist: async () => ({ components: [], nets: [] }),
      getSelectionNetlist: async () => ({ components: [], nets: [] }),
      getActivePageNetlist: async () => ({ components: [], nets: [] }),
      getEdaHostInfo: (async () => handlers.info?.()) as EdaHostClient['getEdaHostInfo'],
      getEdaHostCapabilities: (async () =>
        handlers.capabilities?.()) as EdaHostClient['getEdaHostCapabilities'],
    }
  }

  it('registers exactly the two host discovery tools', () => {
    const tools = createEdaHostTools({ client: hostEnvOf({}) })
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_eda_host_capabilities',
      'get_eda_host_info',
    ])
  })

  it('returns ok:true with host info', async () => {
    const info = {
      identity: { hostType: 'EDA_HOST_TYPE_KICAD', hostName: 'KiCad', version: '10.0.6' },
      installation: { applicationPath: '/Applications/KiCad', executables: [] },
    }
    const tools = createEdaHostTools({ client: hostEnvOf({ info: async () => info }) })
    const tool = tools.find((t) => t.name === 'get_eda_host_info')!
    const result = (await tool.execute({}, {} as never)) as { ok: boolean; info: unknown }
    expect(result.ok).toBe(true)
    expect(result.info).toEqual(info)
  })

  it('returns ok:true with capabilities', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf({ capabilities: async () => ['EDA_HOST_CAPABILITY_NETLIST'] }),
    })
    const tool = tools.find((t) => t.name === 'get_eda_host_capabilities')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      capabilities: string[]
    }
    expect(result.ok).toBe(true)
    expect(result.capabilities).toEqual(['EDA_HOST_CAPABILITY_NETLIST'])
  })

  it('reports host discovery failure with a semantic kind instead of empty data', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf({
        info: async () => {
          throw new NetlistError('UNAVAILABLE', 'host down')
        },
      }),
    })
    const tool = tools.find((t) => t.name === 'get_eda_host_info')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      info?: unknown
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('UNAVAILABLE')
    expect(result.info).toBeUndefined()
  })
})

describe('request budget', () => {
  it('defaults to a finite 30s budget', async () => {
    // Documented single budget: nothing may wait indefinitely.
    const { DEFAULT_REQUEST_TIMEOUT_MS } = await import('../src/config.js')
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('propagates the runtime abort signal into the request', async () => {
    const controller = new AbortController()
    controller.abort()
    let sawAbortedSignal = false
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async (_url, init) => {
        sawAbortedSignal = Boolean((init as RequestInit | undefined)?.signal?.aborted)
        return jsonResponse(200, EMPTY_NETLIST_BODY)
      },
    })
    const options: EdaHostRequestOptions = { signal: controller.signal }
    await client.getProjectNetlist(options)
    expect(sawAbortedSignal).toBe(true)
  })
})
