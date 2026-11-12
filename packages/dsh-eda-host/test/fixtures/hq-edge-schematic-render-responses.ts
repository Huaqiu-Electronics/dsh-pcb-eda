/**
 * Wire fixtures for hq-edge schematic-render routes.
 *
 * These objects mirror what hq-edge returns when bridging gRPC protobuf
 * SchematicRenderService responses over HTTP + proto3 JSON:
 *
 *   - snake_case protobuf fields → lowerCamelCase JSON (proto3 JSON spec)
 *   - `bytes image_data`         → base64 string (proto3 JSON spec)
 *   - enum values                → STRING named values (proto3 JSON spec)
 *
 * The fixtures are hand-constructed but follow the exact shape that
 * `@bufbuild/protobuf`'s `toJson()` would emit for the corresponding
 * generated message schemas.
 */

// A minimal valid PNG — 1×1 transparent pixel, base64 encoded.
// Decodes to a 1-byte imageData payload so fixture size stays tiny.
export const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// ── GetRenderCapabilitiesResponse ───────────────────────────────────────────

export const RENDER_CAPABILITIES_BODY = {
  supportsActiveDocument: true,
  supportsDocumentId: true,
  supportsHierarchy: true,
  supportsSheetInstance: true,
  supportsPng: true,
  supportsSvg: false,
  supportsRegionRender: false,
  maxWidth: 4096,
  maxHeight: 4096,
}

// ── ListSchematicSheetsResponse ────────────────────────────────────────────

export const LIST_SHEETS_BODY = {
  documentId: 'proj-001',
  documentRevision: 'abc123',
  sheets: [
    {
      instancePath: '/',
      sheetName: 'Top',
      sourcePath: '/path/to/top.sch',
      sheetUuid: 'uuid-top',
    },
    {
      instancePath: '/Regulator',
      sheetName: 'Regulator',
      sourcePath: '/path/to/regulator.sch',
      sheetUuid: 'uuid-reg',
    },
  ],
}

// ── RenderSchematicResponse ─────────────────────────────────────────────────
// ONE image (active document mode — single sheet PNG).

export const RENDER_PNG_SINGLE_BODY = {
  documentId: 'proj-001',
  documentRevision: 'abc123',
  images: [
    {
      sheetInstancePath: '/',
      format: 'SCHEMATIC_IMAGE_FORMAT_PNG',
      width: 1920,
      height: 1080,
      imageData: MINIMAL_PNG_BASE64,
      contentHash: 'sha256:...',
    },
  ],
}

// ── RenderSchematicResponse ─────────────────────────────────────────────────
// MULTIPLE images (all sheets at once).

export const RENDER_PNG_MULTI_BODY = {
  documentId: 'proj-001',
  documentRevision: 'abc123',
  images: [
    {
      sheetInstancePath: '/',
      format: 'SCHEMATIC_IMAGE_FORMAT_PNG',
      width: 1024,
      height: 768,
      imageData: MINIMAL_PNG_BASE64,
      contentHash: 'hash-1',
    },
    {
      sheetInstancePath: '/Regulator',
      format: 'SCHEMATIC_IMAGE_FORMAT_PNG',
      width: 1024,
      height: 768,
      imageData: MINIMAL_PNG_BASE64,
      contentHash: 'hash-2',
    },
  ],
}
