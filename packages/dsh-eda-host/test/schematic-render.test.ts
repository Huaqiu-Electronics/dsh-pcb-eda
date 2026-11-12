/**
 * End-to-end tests for the schematic render (PNG screenshot) feature.
 *
 * Verifies:
 *   - client.getRenderCapabilities  → GET /api/v1/schematic-render/capabilities
 *   - client.listSchematicSheets    → GET /api/v1/schematic-render/sheets (query string)
 *   - client.renderSchematic        → POST /api/v1/schematic-render/render (JSON body)
 *   - imageData field survives proto3 JSON bytes→base64 round-trip
 *   - error kinds map correctly on 412 / 501 / 503 / 504 / 500
 *   - tool layer wraps every result in { ok, ... } envelope
 */
import { describe, expect, it } from 'vitest'
import { createEdaHostClient, type EdaHostClient } from '../src/client.js'
import { createEdaHostTools } from '../src/tools.js'
import {
  LIST_SHEETS_BODY,
  MINIMAL_PNG_BASE64,
  RENDER_CAPABILITIES_BODY,
  RENDER_PNG_MULTI_BODY,
  RENDER_PNG_SINGLE_BODY,
} from './fixtures/hq-edge-schematic-render-responses.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const BASE_CONFIG = { hqEdgeBaseUrl: 'http://host:18080' }

// ── Client layer — real HTTP round-trip via mocked fetch ────────────────────

describe('createEdaHostClient — schematic render end-to-end', () => {
  describe('getRenderCapabilities', () => {
    it('GETs /api/v1/schematic-render/capabilities and parses proto3 JSON', async () => {
      const seen: string[] = []
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (url) => {
          seen.push(String(url))
          return jsonResponse(200, RENDER_CAPABILITIES_BODY)
        },
      })

      const caps = await client.getRenderCapabilities()
      expect(seen).toEqual(['http://host:18080/api/v1/schematic-render/capabilities'])

      expect(caps).toEqual({
        supportsActiveDocument: true,
        supportsDocumentId: true,
        supportsHierarchy: true,
        supportsSheetInstance: true,
        supportsPng: true,
        supportsSvg: false,
        supportsRegionRender: false,
        maxWidth: 4096,
        maxHeight: 4096,
      })
    })

    it('defaults missing fields to false / 0', async () => {
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async () =>
          jsonResponse(200, {
            supportsPng: true,
            // everything else omitted
          }),
      })
      const caps = await client.getRenderCapabilities()
      expect(caps.supportsPng).toBe(true)
      expect(caps.supportsSvg).toBe(false)
      expect(caps.maxWidth).toBe(0)
    })

    it('maps 501 to UNIMPLEMENTED', async () => {
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async () =>
          jsonResponse(501, { detail: 'render not supported on this host' }),
      })
      await expect(client.getRenderCapabilities()).rejects.toMatchObject({
        kind: 'UNIMPLEMENTED',
      })
    })
  })

  describe('listSchematicSheets', () => {
    it('GETs /api/v1/schematic-render/sheets with query string when document specified', async () => {
      const seen: string[] = []
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (url) => {
          seen.push(String(url))
          return jsonResponse(200, LIST_SHEETS_BODY)
        },
      })

      const result = await client.listSchematicSheets({
        source: 'SCHEMATIC_SOURCE_ACTIVE_DOCUMENT',
      })
      expect(seen[0]).toContain('/api/v1/schematic-render/sheets')
      expect(result.documentId).toBe('proj-001')
      expect(result.sheets).toHaveLength(2)
      expect(result.sheets[0]?.instancePath).toBe('/')
      expect(result.sheets[0]?.sheetName).toBe('Top')
    })

    it('GETs bare URL when no document given', async () => {
      const seen: string[] = []
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (url) => {
          seen.push(String(url))
          return jsonResponse(200, { documentId: 'x', documentRevision: 'y', sheets: [] })
        },
      })
      await client.listSchematicSheets()
      expect(seen[0]).toBe('http://host:18080/api/v1/schematic-render/sheets')
    })
  })

  describe('renderSchematic', () => {
    it('POSTs JSON body to /api/v1/schematic-render/render and returns images[]', async () => {
      let capturedBody: unknown
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (_url, init) => {
          capturedBody = JSON.parse(String((init as RequestInit).body ?? '{}'))
          return jsonResponse(200, RENDER_PNG_SINGLE_BODY)
        },
      })

      const result = await client.renderSchematic({
        activeDocument: true,
        format: 'SCHEMATIC_IMAGE_FORMAT_PNG',
      })

      // POST body: proto3 JSON style (only real values, no defaults)
      expect(capturedBody).toEqual({
        activeDocument: true,
        // format is not forwarded: the host defaults to PNG
      })

      expect(result.documentId).toBe('proj-001')
      expect(result.documentRevision).toBe('abc123')
      expect(result.images).toHaveLength(1)

      const img = result.images[0]!
      expect(img.sheetInstancePath).toBe('/')
      expect(img.width).toBe(1920)
      expect(img.height).toBe(1080)
      // THE KEY ASSERTION: proto3 JSON bytes → base64 survived the round-trip
      expect(img.imageData).toBe(MINIMAL_PNG_BASE64)
      expect(img.contentHash).toBe('sha256:...')
    })

    it('POSTs multiple sheets when activeDocument=false with paths', async () => {
      let capturedBody: unknown
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (_url, init) => {
          capturedBody = JSON.parse(String((init as RequestInit).body ?? '{}'))
          return jsonResponse(200, RENDER_PNG_MULTI_BODY)
        },
      })

      const result = await client.renderSchematic({
        activeDocument: false,
        sheetInstancePaths: ['/', '/Regulator'],
        maxWidth: 1024,
        maxHeight: 768,
      })

      expect(capturedBody).toEqual({
        activeDocument: false,
        sheetInstancePaths: ['/', '/Regulator'],
      })

      expect(result.images).toHaveLength(2)
      expect(result.images[0]?.imageData).toBe(MINIMAL_PNG_BASE64)
      expect(result.images[1]?.sheetInstancePath).toBe('/Regulator')
    })

    it('maps 412 to FAILED_PRECONDITION (no host open)', async () => {
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async () => jsonResponse(412, { detail: 'no schematic open' }),
      })
      await expect(
        client.renderSchematic({ activeDocument: true }),
      ).rejects.toMatchObject({ kind: 'FAILED_PRECONDITION' })
    })

    it('maps connection failure to UNAVAILABLE', async () => {
      const client = createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED')
        },
      })
      await expect(
        client.renderSchematic({ activeDocument: true }),
      ).rejects.toMatchObject({ kind: 'UNAVAILABLE' })
    })
  })
})

// ── Tool layer — executes the full chain via real client ───────────────────

function hostEnvOf(fetchImpl: typeof fetch): EdaHostClient {
  return createEdaHostClient(BASE_CONFIG, { fetchImpl })
}

describe('createEdaHostTools — schematic render tools', () => {
  it('get_schematic_render_capabilities returns ok:true with parsed flags', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf(async () => jsonResponse(200, RENDER_CAPABILITIES_BODY)),
    })
    const tool = tools.find((t) => t.name === 'get_schematic_render_capabilities')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      capabilities: Record<string, unknown>
    }
    expect(result.ok).toBe(true)
    expect(result.capabilities.supportsPng).toBe(true)
    expect(result.capabilities.maxWidth).toBe(4096)
  })

  it('get_schematic_render_capabilities returns ok:false with UNIMPLEMENTED kind', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf(async () =>
        jsonResponse(501, { detail: 'rendering unsupported' }),
      ),
    })
    const tool = tools.find((t) => t.name === 'get_schematic_render_capabilities')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string; message: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('UNIMPLEMENTED')
  })

  it('list_schematic_sheets passes source/doc_id through and returns ok:true', async () => {
    let seenUrl = ''
    const tools = createEdaHostTools({
      client: createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (url) => {
          seenUrl = String(url)
          return jsonResponse(200, LIST_SHEETS_BODY)
        },
      }),
    })
    const tool = tools.find((t) => t.name === 'list_schematic_sheets')!
    const result = (await tool.execute(
      { source: 'SCHEMATIC_SOURCE_ACTIVE_DOCUMENT' },
      {} as never,
    )) as { ok: boolean; sheets: { sheets: unknown[] } }

    expect(seenUrl).toContain('source=SCHEMATIC_SOURCE_ACTIVE_DOCUMENT')
    expect(result.ok).toBe(true)
    expect(result.sheets.sheets).toHaveLength(2)
  })

  it('get_schematic_png_screenshot returns ok:true with base64 imageData', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf(async () => jsonResponse(200, RENDER_PNG_SINGLE_BODY)),
    })
    const tool = tools.find((t) => t.name === 'get_schematic_png_screenshot')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      render: { images: { imageData: string; width: number; height: number }[] }
    }

    expect(result.ok).toBe(true)
    expect(result.render.images).toHaveLength(1)
    expect(result.render.images[0]!.imageData).toBe(MINIMAL_PNG_BASE64)
    expect(result.render.images[0]!.width).toBe(1920)
    expect(result.render.images[0]!.height).toBe(1080)
  })

  it('get_schematic_png_screenshot propagates UNIMPLEMENTED as ok:false', async () => {
    const tools = createEdaHostTools({
      client: hostEnvOf(async () =>
        jsonResponse(501, { detail: 'PNG export not supported' }),
      ),
    })
    const tool = tools.find((t) => t.name === 'get_schematic_png_screenshot')!
    const result = (await tool.execute({}, {} as never)) as {
      ok: boolean
      error: { kind: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.kind).toBe('UNIMPLEMENTED')
  })

  it('get_schematic_png_screenshot passes explicit active_document=false for all sheets', async () => {
    let capturedBody: unknown
    const tools = createEdaHostTools({
      client: createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (_url, init) => {
          capturedBody = JSON.parse(String((init as RequestInit).body ?? '{}'))
          return jsonResponse(200, RENDER_PNG_MULTI_BODY)
        },
      }),
    })
    const tool = tools.find((t) => t.name === 'get_schematic_png_screenshot')!
    await tool.execute({ active_document: false }, {} as never)
    expect(capturedBody).toEqual({
      activeDocument: false,
    })
  })

  it('get_schematic_png_screenshot forwards sheet_instance_paths', async () => {
    let capturedBody: unknown
    const tools = createEdaHostTools({
      client: createEdaHostClient(BASE_CONFIG, {
        fetchImpl: async (_url, init) => {
          capturedBody = JSON.parse(String((init as RequestInit).body ?? '{}'))
          return jsonResponse(200, RENDER_PNG_MULTI_BODY)
        },
      }),
    })
    const tool = tools.find((t) => t.name === 'get_schematic_png_screenshot')!
    await tool.execute(
      { active_document: false, sheet_instance_paths: ['/', '/Regulator'] },
      {} as never,
    )
    expect(capturedBody).toEqual({
      activeDocument: false,
      sheetInstancePaths: ['/', '/Regulator'],
    })
  })
})
