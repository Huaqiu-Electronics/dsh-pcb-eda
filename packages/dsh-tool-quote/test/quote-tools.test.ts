/**
 * Tests for `@huaqiu/dsh-tool-quote`.
 *
 *   - createQuoteTools: flat agent args → canonical payload assembly for both
 *     tools (only explicit args are sent; eda flags only when true).
 *   - createQuoteToolClient: POSTs to the right hq-edge route, maps the stable
 *     error envelope to QuoteToolError kinds, and never fabricates provider
 *     logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuoteToolClient, QuoteToolError } from '../src/client'
import { createQuoteTools } from '../src/tools'

// ---------------------------------------------------------------------------
// createQuoteTools — payload assembly
// ---------------------------------------------------------------------------

function stubClient() {
  const calls: Array<{ kind: 'pcb' | 'smt'; payload: unknown }> = []
  return {
    calls,
    client: {
      quotePcb: vi.fn(async (payload: unknown) => {
        calls.push({ kind: 'pcb', payload })
        return { ok: true }
      }),
      quoteSmt: vi.fn(async (payload: unknown) => {
        calls.push({ kind: 'smt', payload })
        return { ok: true }
      }),
    },
  }
}

type Tool = {
  name: string
  execute(args: unknown, exec?: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): unknown[] }
}

function toolsOf(client: ReturnType<typeof stubClient>['client']): Tool[] {
  return createQuoteTools({ client }) as unknown as Tool[]
}

function toolByName(tools: Tool[], name: string) {
  const found = tools.find((t) => t.name === name)
  expect(found).toBeDefined()
  return found!
}

describe('createQuoteTools — quote_pcb', () => {
  it('assembles the canonical payload from flat args', async () => {
    const { calls, client } = stubClient()
    const tools = toolsOf(client)
    const tool = toolByName(tools, 'quote_pcb')
    await tool.execute(
      { region: 'cn', bcount: 10, blayer: 4, blength: 100, bwidth: 80, color: 'green' },
      {},
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      kind: 'pcb',
      payload: {
        region: 'cn',
        form: { bcount: 10, blayer: 4, blength: 100, bwidth: 80, color: 'green' },
        eda: undefined,
        includeRawResponse: false,
      },
    })
  })

  it('sends eda flags only when explicitly true', async () => {
    const { calls, client } = stubClient()
    const tools = toolsOf(client)
    await toolByName(tools, 'quote_pcb').execute(
      { region: 'eu_us', derive_board_size: true },
      {},
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload).toEqual({
      region: 'eu_us',
      form: undefined,
      eda: { deriveBoardSize: true },
      includeRawResponse: false,
    })
  })
})

describe('createQuoteTools — quote_smt', () => {
  it('maps pcb_* args into pcbOrder', async () => {
    const { calls, client } = stubClient()
    const tools = toolsOf(client)
    await toolByName(tools, 'quote_smt').execute(
      { region: 'cn', number: '10', pcb_blayer: 2, pcb_blength: 50, pcb_bwidth: 40 },
      {},
    )
    expect(calls).toHaveLength(1)
    const first = calls[0]
    expect(first).toBeDefined()
    expect(first!.payload).toEqual({
      region: 'cn',
      form: {
        number: '10',
        pcbOrder: { blayer: 2, blength: 50, bwidth: 40 },
      },
      eda: undefined,
      includeRawResponse: false,
    })
  })
})

// ---------------------------------------------------------------------------
// createQuoteToolClient — transport + envelope mapping
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createQuoteToolClient', () => {
  it('POSTs to /api/v1/quote/<kind> with the payload', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { region: 'cn', price: { total: 1 } }))
    const client = createQuoteToolClient(
      { hqEdgeBaseUrl: 'http://localhost:18080', requestTimeoutMs: 5_000 },
      { fetchImpl },
    )
    const result = await client.quotePcb({ region: 'cn' })
    expect(result).toEqual({ region: 'cn', price: { total: 1 } })
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const [url, init] = call
    expect(url).toBe('http://localhost:18080/api/v1/quote/pcb')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({ region: 'cn' })
  })

  it('resolves the base URL from the late-bound resolver', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { region: 'eu_us' }))
    const client = createQuoteToolClient(
      { hqEdgeBaseUrl: '', requestTimeoutMs: 5_000 },
      { fetchImpl, baseUrlResolver: () => 'http://127.0.0.1:9999' },
    )
    await client.quoteSmt({ region: 'eu_us' })
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0]
    expect(url).toBe('http://127.0.0.1:9999/api/v1/quote/smt')
  })

  it('maps the stable error envelope to QuoteToolError kinds', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(501, {
        error: 'UNIMPLEMENTED',
        detail: 'derive_board_stackup is not supported',
        code: 'derive_board_stackup_unimplemented',
        status: 501,
      }),
    )
    const client = createQuoteToolClient(
      { hqEdgeBaseUrl: 'http://localhost:18080', requestTimeoutMs: 5_000 },
      { fetchImpl },
    )
    await expect(client.quotePcb({ region: 'cn', eda: { deriveBoardStackup: true } })).rejects.toMatchObject({
      kind: 'UNIMPLEMENTED',
      status: 501,
      detail: 'derive_board_stackup is not supported',
    })
  })

  it('throws FAILED_PRECONDITION without a base URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}))
    const client = createQuoteToolClient(
      { hqEdgeBaseUrl: '', requestTimeoutMs: 5_000 },
      { fetchImpl, baseUrlResolver: () => undefined },
    )
    await expect(client.quotePcb({ region: 'cn' })).rejects.toMatchObject({
      kind: 'FAILED_PRECONDITION',
      status: 412,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
