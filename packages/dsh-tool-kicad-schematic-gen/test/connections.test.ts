import assert from 'node:assert/strict'
import {test} from 'node:test'
import {inspectPinConnections} from '../src/schematic/connections.ts'
import {listFlatObjects, type FlatObject} from '../src/schematic/flat.ts'
import {parseFlatRequest} from '../src/schematic/flat-input.ts'
import {apply} from '../src/schematic/index.ts'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'

const wire = (uuid: string, from: [number, number], to: [number, number]): FlatObject => ({type: 'wire', uuid, from, to})
const symbol = (reference: string, at: [number, number]): FlatObject => ({type: 'symbol', uuid: reference, reference,
  pins: [{number: '1', name: 'IN', at, electricalType: 'input'}, {number: '2', name: 'OUT', at: [at[0] + 5, at[1]], electricalType: 'output'}]})

test('physical connections follow wire ends and T branches, but not component bodies or remote label aliases', () => {
  const objects: FlatObject[] = [symbol('U1', [0, 0]), symbol('R1', [10, 0]),
    wire('a', [0, 0], [10, 0]), wire('b', [5, 0], [5, 5]), wire('remote', [30, 0], [40, 0]),
    {type: 'label', uuid: 'name', name: 'EN', at: [5, 5]}, {type: 'label', uuid: 'alias', name: 'EN', at: [30, 0]}]
  const result = inspectPinConnections(objects, 'U1', '1')
  assert.deepEqual(result.netNames, ['EN'])
  assert.deepEqual(result.target.endpoint, {reference: 'U1', pin: '1'})
  assert.deepEqual(result.objects.map(o => o.uuid), ['U1', 'R1', 'a', 'b', 'name'])
  assert.deepEqual(result.objects.find(o => o.reference === 'R1')!.pins!.map(p => p.number), ['1'])
  assert.throws(() => inspectPinConnections(objects, 'U1', 'IN'), /found 0/)
})

test('interior crossings need a junction; collinear and diagonal endpoint joins are supported', () => {
  const objects = [symbol('U1', [0, 0]), wire('a', [0, 0], [10, 0]), wire('cross', [5, -5], [5, 5]),
    wire('diagonal', [10, 0], [15, 5])]
  assert.equal(inspectPinConnections(objects, 'U1', '1').objects.some(o => o.uuid === 'cross'), false)
  assert.equal(inspectPinConnections(objects, 'U1', '1').objects.some(o => o.uuid === 'diagonal'), true)
  assert.equal(inspectPinConnections([...objects, {type: 'junction', uuid: 'j', at: [5, 0]}], 'U1', '1').objects.some(o => o.uuid === 'cross'), true)
})

test('unresolved or ambiguous placed pins fail explicitly, isolated pins retain exact coordinates', () => {
  assert.throws(() => inspectPinConnections([{...symbol('U1', [0, 0]), pinError: 'missing cache'}], 'U1', '1'), /cannot resolve/)
  assert.throws(() => inspectPinConnections([symbol('U1', [0, 0]), symbol('U1', [20, 0])], 'U1', '1'), /found 2/)
  assert.deepEqual(inspectPinConnections([symbol('U1', [1.27, 2.54])], 'U1', '1').target.at, [1.27, 2.54])
})

test('catalog resolves active units, rotation, mirror, DNP and footprint using existing parser', () => {
  const source = `(kicad_sch (version 20250114) (generator test) (uuid "root")
    (lib_symbols (symbol "Demo:Demo" (symbol "Demo_1_1"
      (pin input line (at 2 3 0) (length 1) (name "EN") (number "1")))
      (symbol "Demo_2_1" (pin output line (at 99 99 0) (length 1) (name "OTHER") (number "2")))))
    (symbol (lib_id "Demo:Demo") (at 10 20 90) (unit 1) (mirror y) (dnp yes)
      (property "Reference" "U1") (property "Value" "Demo") (property "Footprint" "Local:Demo") (uuid "instance")))`
  const objects = listFlatObjects(source)
  assert.deepEqual(objects[0]!.pins, [{number: '1', name: 'EN', electricalType: 'input', at: [13, 18]}])
  assert.equal(objects[0]!.footprint, 'Local:Demo')
  assert.equal(objects[0]!.dnp, true)
  assert.deepEqual(inspectPinConnections(objects, 'U1', '1').target.at, [13, 18])
})

test('request selectors are action-specific and bounded pagination is retained', () => {
  assert.deepEqual(parseFlatRequest({action: 'connections', sourcePath: 'a', reference: 'U1', pin: '1', offset: 4}, 12),
    {action: 'connections', sourcePath: 'a', reference: 'U1', pin: '1', offset: 4, limit: 12})
  assert.deepEqual((parseFlatRequest({action: 'list', sourcePath: 'a', references: ['U1']}, 12) as any).references, ['U1'])
  assert.throws(() => parseFlatRequest({action: 'connections', sourcePath: 'a', reference: 'U1', pin: '1', offset: -1}, 12), /offset/)
  assert.throws(() => parseFlatRequest({action: 'create', sourcePath: 'a', reference: 'U1'}, 12), /selectors/)
})

test('registered tool returns bounded connections, revision and filtered catalog without writes', async () => {
  let source = `(kicad_sch (version 20250114) (generator test) (uuid "root")
    (lib_symbols (symbol "Demo:Demo" (symbol "Demo_1_1"
      (pin input line (at 0 0 0) (length 1) (name "EN") (number "1")))))
    (symbol (lib_id "Demo:Demo") (at 10 20 0) (unit 1)
      (property "Reference" "U1") (property "Value" "Demo") (uuid "instance"))
    (wire (pts (xy 10 20) (xy 20 20)) (uuid "wire")))`
  const tools: any[] = []
  const cwd = resolve('connection-test-workspace')
  apply({effect: (f: () => unknown) => f(), tools: {register: (tool: unknown) => tools.push(tool)}, fs: {
    resolve: async (path: string, options?: {cwd?: string}) => ({displayPath: resolve(options?.cwd ?? cwd, path)}),
    contains: (root: any, path: any) => path.displayPath.startsWith(root.displayPath),
    stat: async () => ({type: 'file'}), readBytes: async () => Buffer.from(source),
    writeText: () => {throw new Error('query must never write')},
  }} as never, {flatListLimit: 1, maxSchematicBytes: 100000,
    kicadCliPath: 'kicad-cli', previewDensity: 288, previewMaxWidth: 2400, previewMaxPages: 4,
    previewPadding: 32, previewTimeoutMs: 30000, previewTrimThreshold: 10,
    flatTemplateDir: fileURLToPath(new URL('../skills/kicad-schematic-design/templates/', import.meta.url))} as never)
  const tool = tools.find(t => t.name === 'edit_kicad_flat_schematic')
  const exec = {agent: {session: {header: {cwd}}}, signal: new AbortController().signal}
  const request = {action: 'connections', sourcePath: 'demo.kicad_sch', reference: 'U1', pin: '1'}
  const first = await tool.execute(request, exec)
  assert.equal(first.totalObjects, 2)
  assert.equal(first.objects.length, 1)
  assert.equal(first.nextOffset, 1)
  const next = await tool.execute({...request, offset: first.nextOffset}, exec)
  assert.equal(next.objects[0].uuid, 'wire')
  assert.equal(next.nextOffset, null)
  const filtered = await tool.execute({action: 'list', sourcePath: request.sourcePath, references: ['U1']}, exec)
  assert.equal(filtered.totalObjects, 1)
  assert.equal(filtered.sha256, first.sha256)
  source = source.replace('(at 10 20 0)', '(at 11 20 0)')
  assert.notEqual((await tool.execute(request, exec)).sha256, first.sha256)
  await assert.rejects(tool.execute({...request, sourcePath: '../outside.kicad_sch'}, exec), /inside the agent workspace/)
})
