import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getComponentModels, inspectBuilderCompatibility, type ModelOptions } from '../src/components/models.ts'

const options: ModelOptions = {
  requestTimeoutMs: 1000,
  maxModelBytes: 10000,
}

const symbol = `(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor)
  (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54)
      (name "IN" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27))))))))`

const footprint = `(footprint "Demo" (layer "F.Cu")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`

function reply(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}

test('summarizes exact-part symbol pins and footprint pads without writing files', async () => {
  const requests: string[] = []
  const fetcher = (async (url: URL | RequestInfo, init?: RequestInit) => {
    requests.push(String(url))
    if (String(url).endsWith('/productDetail')) {
      assert.deepEqual(JSON.parse(String(init?.body)), {manufacturer_id: '7189', mpn: 'Demo'})
      return reply({ code: 200000, result: { mpn: 'Demo', cadUrlList: [
        { type: 'symbol', fileUrl: '//example.test/Demo.kicad_sym' },
        { type: 'footprint', fileUrl: 'https://example.test/Demo.kicad_mod' },
      ] } })
    }
    return new Response(String(url).endsWith('.kicad_sym') ? symbol : footprint)
  }) as typeof fetch

  const result = await getComponentModels('7189', 'Demo', options, new AbortController().signal, fetcher)
  assert.equal(result.part, '7189:Demo')
  assert.deepEqual(result.symbol, {
    status: 'parsed', name: 'Demo', subsymbols: ['Demo_1_1'], pinCount: 1,
    pins: [{ unit: 'Demo_1_1', number: '1', name: 'IN', type: 'input' }],
    builderCompatibility: { status: 'ready', availableUnits: [1], nextAction: 'Place a listed unit (1); confirm physical pin numbers and package against the selected part. A symbol name is not an MPN match.' },
  })
  assert.deepEqual(result.footprint, {
    status: 'parsed', name: 'Demo', padCount: 1, pads: [{ number: '1', type: 'smd' }],
  })
  assert.deepEqual(result.validation, { pinPadMatch: 'not_checked' })
  assert.equal(requests.length, 3)
})

test('reports missing models without claiming parsing or pin-pad validation', async () => {
  const fetcher = (async () => reply({ code: 200000, result: { mpn: 'Demo', cadUrlList: null } })) as typeof fetch
  const result = await getComponentModels('7189', 'Demo', options, new AbortController().signal, fetcher)
  assert.deepEqual(result.symbol, { status: 'missing' })
  assert.deepEqual(result.footprint, { status: 'missing' })
})

test('rejects a model file larger than the configured limit', async () => {
  const fetcher = (async (url: URL | RequestInfo) => String(url).endsWith('/productDetail')
    ? reply({ code: 200000, result: { mpn: 'Demo', cadUrlList: [{ type: 'symbol', fileUrl: 'https://example.test/large' }] } })
    : new Response('x'.repeat(101))) as typeof fetch
  await assert.rejects(
    getComponentModels('7189', 'Demo', { ...options, maxModelBytes: 100 }, new AbortController().signal, fetcher),
    /symbol file exceeds 100 bytes/,
  )
})

test('upgrades upstream HTTP URLs and fetches model bytes only through HTTPS', async () => {
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input)
    assert.ok(url.startsWith('https://'))
    return url.endsWith('/productDetail') ? reply({ code: 200000, result: { mpn: 'Demo', cadUrlList: [
      { type: 'symbol', fileUrl: 'http://example.test/Demo.kicad_sym' },
    ] } }) : new Response(symbol)
  }) as typeof fetch
  assert.equal((await getComponentModels('7189', 'Demo', options, new AbortController().signal, fetcher)).symbol.status, 'parsed')
})

test('reports alternate-only and malformed units before placement', async () => {
  const { SchematicParser } = await import('kicad-sexpr-parser')
  for (const section of ['Demo_1_2', 'wrong_name']) {
    const parsed = new SchematicParser().parseLibSymbols(symbol.replaceAll('Demo_1_1', section))[0]!
    const result = inspectBuilderCompatibility(parsed)
    assert.equal(result.status, 'unsupported_units')
    assert.deepEqual(result.availableUnits, [])
    assert.match(result.nextAction, /Do not repeatedly place unit 1/)
  }
  const parsed = new SchematicParser().parseLibSymbols(symbol.replaceAll('Demo_1_1', 'Demo_2_1'))[0]!
  assert.deepEqual(inspectBuilderCompatibility(parsed).availableUnits, [2])
})

test('common-only pins are available as normalized unit 1; empty common graphics are not', async () => {
  const { SchematicParser } = await import('kicad-sexpr-parser')
  const parsed = new SchematicParser().parseLibSymbols(symbol.replaceAll('Demo_1_1', 'Demo_0_1'))[0]!
  assert.equal(inspectBuilderCompatibility(parsed).normalization, 'common_only_to_unit_1')
  assert.deepEqual(inspectBuilderCompatibility(parsed).availableUnits, [1])
  parsed.children![0]!.pins = []
  assert.equal(inspectBuilderCompatibility(parsed).status, 'unsupported_units')
})


test('invalid footprint preserves a parsed symbol and identifies its source without retrying', async () => {
  const fetcher = (async (url: URL | RequestInfo) => String(url).endsWith('/productDetail')
    ? reply({ code: 200000, result: { mpn: 'Demo', cadUrlList: [
      { type: 'symbol', fileUrl: 'https://example.test/a.kicad_sym' },
      { type: 'footprint', fileUrl: 'https://example.test/b.kicad_mod' },
    ] } }) : new Response(String(url).endsWith('.kicad_sym') ? symbol : 'dsfsdf\n是打发斯蒂芬')) as typeof fetch
  const result = await getComponentModels('9032', 'TS-1187E-C-A-B', options, new AbortController().signal, fetcher)
  assert.equal(result.symbol.status, 'parsed')
  assert.equal(result.footprint.status, 'invalid')
  if (result.footprint.status !== 'invalid') throw new Error('expected invalid model')
  assert.equal(result.footprint.code, 'MODEL_FORMAT_INVALID')
  assert.equal(result.footprint.sourceUrl, 'https://example.test/b.kicad_mod')
  assert.equal(result.footprint.retryUnchanged, false)
})

test('malformed symbol preserves a valid footprint', async () => {
  const fetcher = (async (url: URL | RequestInfo) => String(url).endsWith('/productDetail')
    ? reply({ code: 200000, result: { mpn: 'Demo', cadUrlList: [
      { type: 'symbol', fileUrl: 'https://example.test/a.kicad_sym' },
      { type: 'footprint', fileUrl: 'https://example.test/b.kicad_mod' },
    ] } }) : new Response(String(url).endsWith('.kicad_sym') ? '(kicad_symbol_lib 是)' : footprint)) as typeof fetch
  const result = await getComponentModels('1', 'Demo', options, new AbortController().signal, fetcher)
  assert.equal(result.footprint.status, 'parsed')
  assert.equal(result.symbol.status, 'invalid')
  if (result.symbol.status !== 'invalid') throw new Error('expected invalid model')
  assert.equal(result.symbol.code, 'MODEL_PARSE_FAILED')
})
