import { describe, expect, it } from 'vitest'
import {
  ALLOWED_WS_HOSTS,
  agentActions,
  artifactFilenameFor,
  buildCommand,
  buildSocketUrl,
  callComponentAgent,
  commandTypes,
  consumeFrame,
  extractFileUrl,
  fetchArtifactText,
  findAction,
  guessImageMime,
  packageTypes,
  resolveEndpoint,
  resolveImageDataUrl,
} from '../src/protocol.js'

describe('resolveEndpoint', () => {
  it('defaults to the prod componentV2 endpoint', () => {
    expect(resolveEndpoint({})).toBe('ws://www.fdatasheets.com/componentV2/chat')
  })

  it('accepts a whitelisted override and strips trailing slashes', () => {
    expect(resolveEndpoint({ HQ_EDA_COMPONENT_WS_URL: 'wss://www.fdatasheets.com/componentV2/chat/' }))
      .toBe('wss://www.fdatasheets.com/componentV2/chat')
  })

  it('rejects non-whitelisted hosts', () => {
    expect(() => resolveEndpoint({ HQ_EDA_COMPONENT_WS_URL: 'wss://evil.example.com/chat' }))
      .toThrow(/not allowed/)
  })

  it('rejects non-websocket schemes', () => {
    expect(() => resolveEndpoint({ HQ_EDA_COMPONENT_WS_URL: 'https://www.eda.cn/chat' }))
      .toThrow(/ws:\/\/ or wss:\/\//)
  })
})

describe('buildSocketUrl', () => {
  it('appends a channel segment and the token as a query param', () => {
    const url = buildSocketUrl('wss://www.eda.cn/componentV2/chat', 'tok/1', () => 0.1234567)
    expect(url).toBe('wss://www.eda.cn/componentV2/chat/23456?token=tok%2F1')
  })

  it('omits the token when absent', () => {
    const url = buildSocketUrl('wss://www.eda.cn/componentV2/chat', null, () => 0.1234567)
    expect(url).toBe('wss://www.eda.cn/componentV2/chat/23456')
  })
})

describe('consumeFrame / findAction', () => {
  it('collects streaming text, agent actions and terminal flags', () => {
    const acc = { text: [], actions: [], ended: false, tokenExpired: false }
    consumeFrame({ type: 1, msg: 'hello' }, acc)
    consumeFrame({ type: 6, action: 'footprint_dimensions', context: { dimensions: {} } }, acc)
    consumeFrame({ type: 2 }, acc)
    consumeFrame({ type: 12 }, acc)
    expect(acc.text).toEqual(['hello'])
    expect(acc.actions).toHaveLength(1)
    expect(acc.ended).toBe(true)
    expect(acc.tokenExpired).toBe(true)
  })

  it('ignores diagnostics and malformed frames', () => {
    const acc = { text: [], actions: [], ended: false, tokenExpired: false }
    consumeFrame(null, acc)
    consumeFrame({ type: 3 }, acc)
    consumeFrame({ type: 5 }, acc)
    consumeFrame({ type: 1, msg: 123 }, acc)
    expect(acc.text).toEqual([])
    expect(acc.actions).toEqual([])
  })

  it('findAction returns the first wanted action', () => {
    const actions = [
      { action: 'other', context: null },
      { action: 'footprint_button', context: { params: '{"fileUrl":"//x/y.kicad_mod"}' } },
    ]
    const found = findAction(actions, [agentActions.FOOTPRINT_BUTTON])
    expect(found?.action).toBe('footprint_button')
    expect(findAction(actions, ['nope'])).toBeNull()
  })
})

describe('callComponentAgent (socket lifecycle)', () => {
  function fakeSocket() {
    const handlers: Record<string, (ev?: { data?: unknown; message?: string }) => void> = {}
    const socket = {
      onopen: null as ((ev: unknown) => void) | null,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onerror: null as ((ev: { message?: string }) => void) | null,
      onclose: null as (() => void) | null,
      sent: [] as string[],
      send(data: string) { this.sent.push(data) },
      close() {},
    }
    return socket
  }

  it('resolves on an awaited AGENT action, preserving text and context', async () => {
    const socket = fakeSocket()
    const p = callComponentAgent({
      url: 'ws://x/1',
      command: { type: commandTypes.PARSE_SYMBOL, context: {} },
      awaitActions: [agentActions.SYMBOL_BUTTON],
      socketFactory: () => socket as never,
    })
    socket.onopen?.(null)
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: commandTypes.PARSE_SYMBOL, context: {} })
    socket.onmessage?.({ data: JSON.stringify({ type: 1, msg: 'working' }) })
    socket.onmessage?.({ data: JSON.stringify({ type: 6, action: 'symbol_button', context: { params: '{"fileUrl":"//x/y.kicad_sym"}' } }) })
    const result = await p
    expect(result.action?.action).toBe('symbol_button')
    expect(result.text).toBe('working')
  })

  it('rejects on a token-expired frame with an actionable error', async () => {
    const socket = fakeSocket()
    const p = callComponentAgent({
      url: 'ws://x/1',
      command: {},
      awaitActions: [agentActions.SYMBOL_BUTTON],
      socketFactory: () => socket as never,
    })
    socket.onopen?.(null)
    socket.onmessage?.({ data: JSON.stringify({ type: 12 }) })
    await expect(p).rejects.toThrow(/token was rejected/)
  })

  it('rejects when the socket closes before responding', async () => {
    const socket = fakeSocket()
    const p = callComponentAgent({
      url: 'ws://x/1',
      command: {},
      awaitActions: [agentActions.SYMBOL_BUTTON],
      socketFactory: () => socket as never,
    })
    socket.onopen?.(null)
    socket.onclose?.()
    await expect(p).rejects.toThrow(/closed before/)
  })
})

describe('buildCommand', () => {
  it('ships images in context.chat.base64_images with empty history', () => {
    const cmd = buildCommand(commandTypes.PARSE_SYMBOL, {
      inputText: '3-pin LDO',
      images: ['data:image/png;base64,AAAA'],
    })
    expect(cmd).toEqual({
      type: commandTypes.PARSE_SYMBOL,
      context: { chat: { input_text: '3-pin LDO', base64_images: ['data:image/png;base64,AAAA'] }, history: [] },
    })
  })

  it('merges extra top-level context', () => {
    const cmd = buildCommand(commandTypes.FOOTPRINT_GENERATE, { extra: { pkgType: 'qfn', dimensions: { W: 5 } } })
    expect((cmd.context as Record<string, unknown>).pkgType).toBe('qfn')
    expect((cmd.context as Record<string, unknown>).dimensions).toEqual({ W: 5 })
  })
})

describe('extractFileUrl / artifactFilenameFor', () => {
  it('parses a nested JSON-string params.fileUrl and protocol-normalizes it', () => {
    expect(extractFileUrl({ params: '{"fileUrl":"//cdn/x/1.kicad_mod"}' })).toBe('https://cdn/x/1.kicad_mod')
  })
  it('accepts a flat fileUrl and an already-parsed object', () => {
    expect(extractFileUrl({ fileUrl: 'https://x/y.kicad_sym' })).toBe('https://x/y.kicad_sym')
    expect(extractFileUrl({ params: { fileUrl: 'https://x/y.kicad_mod' } })).toBe('https://x/y.kicad_mod')
  })
  it('returns null when absent', () => {
    expect(extractFileUrl({ params: '{}' })).toBeNull()
    expect(extractFileUrl(null)).toBeNull()
  })
  it('derives a filename from the URL or falls back to kind+extension', () => {
    expect(artifactFilenameFor('footprint', 'https://x/path/MCP1700.kicad_mod')).toBe('MCP1700.kicad_mod')
    expect(artifactFilenameFor('symbol')).toBe('generated.kicad_sym')
    expect(artifactFilenameFor('footprint')).toBe('generated.kicad_footprint')
  })
})

describe('fetchArtifactText', () => {
  it('returns the text with a truncation note when too large', async () => {
    const big = 'x'.repeat(600000)
    const res = await fetchArtifactText('https://x/y.kicad_mod', (async () => new Response(big)) as never)
    expect(res.content).toBe('x'.repeat(512 * 1024))
    expect(res.note).toMatch(/truncated/)
  })
  it('returns a note on HTTP failure instead of throwing', async () => {
    const res = await fetchArtifactText('https://x/y.kicad_mod', (async () => new Response('nope', { status: 404 })) as never)
    expect(res.content).toBeNull()
    expect(res.note).toMatch(/could not be downloaded/)
  })
})

describe('resolveImageDataUrl', () => {
  it('passes through an existing image data URL', async () => {
    expect(await resolveImageDataUrl({ image_url: 'data:image/png;base64,AAAA' }))
      .toBe('data:image/png;base64,AAAA')
  })
  it('passes through a caller-held image data URL (component-gen backend path)', async () => {
    expect(await resolveImageDataUrl({ image: 'data:image/jpeg;base64,AAAA' }))
      .toBe('data:image/jpeg;base64,AAAA')
  })
  it('rejects a caller-held image that is not a data URL', async () => {
    await expect(resolveImageDataUrl({ image: '/tmp/foo.png' })).rejects.toThrow(/data: URL carrying an image/)
  })
  it('rejects a data URL that is not an image', async () => {
    await expect(resolveImageDataUrl({ image_url: 'data:text/plain;base64,AAAA' })).rejects.toThrow(/image\/\*/)
  })
  it('reads a local file and base64-encodes with a guessed mime', async () => {
    const url = await resolveImageDataUrl({ image_path: '/tmp/foo.png' }, {
      readFileImpl: async () => Buffer.from([1, 2, 3]),
    })
    expect(url).toBe('data:image/png;base64,AQID')
  })
  it('requires either image_path or image_url', async () => {
    await expect(resolveImageDataUrl({})).rejects.toThrow(/image_path|image_url/)
  })
  it('enforces the size cap', async () => {
    await expect(resolveImageDataUrl({ image_path: '/tmp/big.png' }, {
      readFileImpl: async () => Buffer.alloc(5 * 1024 * 1024),
    })).rejects.toThrow(/too large/)
  })
})

describe('misc exports', () => {
  it('exposes the whitelist and package types', () => {
    expect(ALLOWED_WS_HOSTS).toEqual(['www.eda.cn', 'www.fdatasheets.com', 'www.fdatasheets.com'])
    expect(packageTypes).toContain('bga')
    expect(guessImageMime('x.JPG')).toBe('image/jpeg')
  })
})
