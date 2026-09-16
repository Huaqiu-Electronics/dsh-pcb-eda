/**
 * Tests for the dsh-eda-host netlist client + tools.
 *
 * Covers the semantic rules of the task spec (§15):
 *   - valid empty result (200 + empty netlist) is OK, not an error
 *   - HTTP status → semantic error kind (412 → FAILED_PRECONDITION,
 *     501 → UNIMPLEMENTED, 503 → UNAVAILABLE, 500 → INTERNAL)
 *   - tools surface { ok, scope, netlist | error.kind } without fabricating data
 */
import { describe, expect, it } from 'vitest'
import { createEdaHostClient } from '../src/client.js'
import { createNetListTools } from '../src/tools.js'
import { NetlistError, type SchematicNetlist } from '../src/types.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const BASE_CONFIG = { hqEdgeBaseUrl: 'http://host:18080' }

describe('createEdaHostClient', () => {
  it('returns an empty netlist for a valid empty result (200)', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(200, { netlist: { components: [], nets: [] } }),
    })
    const netlist = await client.getProjectNetlist()
    expect(netlist.components).toEqual([])
    expect(netlist.nets).toEqual([])
  })

  it('parses components and nets', async () => {
    const client = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () =>
        jsonResponse(200, {
          netlist: {
            components: [
              {
                referenceDesignators: ['R1'],
                value: '10k',
                manufacturerPartNumber: '',
                footprint: 'R_0603',
                description: '',
                pins: [
                  { pinNumber: '1', pinName: '1', electricalType: 'ELECTRICAL_TYPE_PASSIVE' },
                ],
              },
            ],
            nets: [
              { name: 'GND', pinReferences: [{ referenceDesignator: 'R1', pinNumber: '2' }] },
            ],
          },
        }),
    })
    const netlist = await client.getSelectionNetlist()
    expect(netlist.components[0]?.referenceDesignators).toEqual(['R1'])
    expect(netlist.components[0]?.pins[0]?.electricalType).toBe('ELECTRICAL_TYPE_PASSIVE')
    expect(netlist.nets[0]?.pinReferences[0]).toEqual({ referenceDesignator: 'R1', pinNumber: '2' })
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

  it('maps 503 to UNAVAILABLE and 500 to INTERNAL', async () => {
    const unavailable = createEdaHostClient(BASE_CONFIG, {
      fetchImpl: async () => jsonResponse(503, { error: 'x' }),
    })
    await expect(unavailable.getProjectNetlist()).rejects.toMatchObject({ kind: 'UNAVAILABLE' })

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

  it('prefers a baseUrlResolver (ctx.hqEdge) over static config', async () => {
    const seen: string[] = []
    const client = createEdaHostClient(
      { hqEdgeBaseUrl: 'http://stale:1' },
      {
        baseUrlResolver: () => 'http://hqedge:9',
        fetchImpl: async (url: URL | RequestInfo) => {
          seen.push(String(url))
          return jsonResponse(200, { netlist: { components: [], nets: [] } })
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
        return jsonResponse(200, { netlist: { components: [], nets: [] } })
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
})

describe('createNetListTools', () => {
  function toolEnvOf(netlistOrThrow: SchematicNetlist | Error) {
    const make = async (): Promise<SchematicNetlist> => {
      if (netlistOrThrow instanceof Error) throw netlistOrThrow
      return netlistOrThrow
    }
    const client = {
      getProjectNetlist: make,
      getSelectionNetlist: make,
      getActivePageNetlist: make,
    }
    return createNetListTools({ client })
  }

  it('registers exactly three semantic tools', () => {
    const tools = toolEnvOf({ components: [], nets: [] })
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_active_page_netlist',
      'get_project_netlist',
      'get_selection_netlist',
    ])
  })

  it('returns ok:true with the netlist for a valid empty result', async () => {
    const [projectTool] = toolEnvOf({ components: [], nets: [] })
    expect(projectTool).toBeDefined()
    const result = (await projectTool!.execute({}, {} as never)) as { ok: boolean; netlist: unknown }
    expect(result.ok).toBe(true)
    expect(result.netlist).toEqual({ components: [], nets: [] })
  })

  it('propagates UNIMPLEMENTED as ok:false with the semantic kind', async () => {
    const tools = toolEnvOf(new NetlistError('UNIMPLEMENTED', 'active page not supported'))
    const activeTool = tools.find((t) => t.name === 'get_active_page_netlist')!
    const result = (await activeTool.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('UNIMPLEMENTED')
  })

  it('never fabricates data: generic failure becomes INTERNAL ok:false', async () => {
    const tools = toolEnvOf(new Error('boom'))
    const projectTool = tools.find((t) => t.name === 'get_project_netlist')!
    const result = (await projectTool!.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('INTERNAL')
  })
})
