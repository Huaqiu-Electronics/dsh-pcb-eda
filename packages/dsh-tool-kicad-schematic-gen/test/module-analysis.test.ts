import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, writeFile, readFile, readdir, rm} from 'node:fs/promises'
import {join, dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {Schematic} from '../src/schematic/builder.ts'
import {createModuleAnalyzer, parseAnalysisNetlist, parseBomCsv} from '../src/schematic/module-analysis.ts'
import {registerModuleAnalysis, pageAnalysisItems, queryAnalysisItems} from '../src/schematic/analysis-tool.ts'
import {adaptTool} from '../src/modules/kicad-download.ts'
import {parse, children, value, applyEdits} from '../src/schematic/sexpr.ts'

const exported = `(export (version "E") (components
  (comp (ref "U1") (value "Demo") (footprint "Local:Demo") (fields (field (name "MPN") "REAL-PART")) (sheetpath (names "/"))))
  (nets (net (code "1") (name "EN") (node (ref "U1") (pin "1") (pinfunction "IN") (pintype "input")))))`
const csv = 'Reference,Value,Footprint,Quantity,DNP,ExcludeFromBom,ExcludeFromBoard\r\nU1,Demo,Local:Demo,1,,,\r\n'
const config = {kicadCliPath: 'kicad-cli', maxSchematicBytes: 1000000, previewTimeoutMs: 10000}
const help = (args: readonly string[]) => args.includes('netlist') ? 'kicadsexpr' : '--fields --labels --group-by --filter'
const result = (stdout = '') => ({exitCode: 0, stdout, stderr: '', timedOut: false})

async function fixture(fn: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'module analysis 中文 ')), ctx = new Context()
  try {
    await ctx.plugin(LocalFileSystem, {cwd: root})
    const library = join(root, 'Demo.kicad_sym')
    await writeFile(library, `(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor)
      (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54)
      (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`)
    const sch = new Schematic({projectName: 'demo', title: 'demo', paper: 'A4',
      templateDir: fileURLToPath(new URL('../skills/kicad-schematic-design/templates', import.meta.url))})
    sch.addSymbol({libraryPath: library, libId: 'Local:Demo', reference: 'U1', at: [30, 30], footprint: 'Local:Demo'})
    sch.addSymbol({libraryPath: library, libId: 'Local:Demo', reference: 'U2', at: [60, 30], footprint: 'Local:Demo'})
    sch.label('EN', [30, 30]); sch.label('EN', [60, 30])
    const source = sch.save(join(root, 'source')).schematicPath
    // npm rc.1 lacks the bundled host's bounded readBytes method.
    const fs = {resolve: ctx.fs.resolve.bind(ctx.fs), contains: ctx.fs.contains.bind(ctx.fs),
      stat: ctx.fs.stat.bind(ctx.fs), writeText: ctx.fs.writeText.bind(ctx.fs),
      readBytes: async (target: any, signal: AbortSignal, limit: number) => {
        signal.throwIfAborted(); const bytes = await readFile(target.displayPath)
        if (bytes.length > limit) throw new Error('file exceeds read limit')
        return bytes
      }}
    const services = {fs, sandboxPolicy: {resolve: () => undefined}} as any
    const exec = {agent: {session: {header: {cwd: root}}}, signal: new AbortController().signal} as any
    await fn({root, ctx, services, exec, source})
  } finally {await ctx.fiber.dispose(); await rm(root, {recursive: true, force: true})}
}

test('BOM CSV preserves quoted text, DNP, empty fields and multiline values', () => {
  assert.deepEqual(parseBomCsv('\uFEFFReference,Value,DNP\r\nR1,"a,b\n""c""",DNP\r\n'), [{Reference: 'R1', Value: 'a,b\n"c"', DNP: 'DNP'}])
  assert.throws(() => parseBomCsv('Reference,Value\nR1,"bad'), /unterminated/)
  assert.throws(() => parseBomCsv('Reference,Value\nR1'), /column count/)
  assert.equal(parseAnalysisNetlist(exported).components[0]!.fields.MPN, 'REAL-PART')
  assert.equal(parseAnalysisNetlist(exported).nets[0]!.nodes[0]!.pin, '1')
})

test('query output bounds both rows and text without dropping pagination or concealing oversized data', () => {
  const many = Array.from({length: 80}, (_, i) => ({reference: `R${i}`}))
  assert.equal(pageAnalysisItems(many, 0).items.length, 60)
  assert.equal(pageAnalysisItems(many, 0).nextOffset, 60)
  const large = [{fields: 'x'.repeat(16000)}, {fields: 'y'.repeat(16000)}]
  assert.equal(pageAnalysisItems(large, 0).nextOffset, 1)
  assert.equal(pageAnalysisItems(large, 1).items.length, 1)
  const oversized = pageAnalysisItems([{fields: 'x'.repeat(25000)}, {reference: 'U2'}], 0)
  assert.equal((oversized.items[0] as any).omitted, true)
  assert.equal(oversized.nextOffset, 1)
})

test('compact queries preserve connection peers, procurement identity and unknown assembly state', () => {
  const parsed = parseAnalysisNetlist(exported), first = parsed.components[0]!
  const components = [first, {...first, reference: 'U2'}, {...first, reference: 'U3', fields: {MPN: 'OTHER'}},
    {...first, reference: 'U4', dnp: true}].map(c => ({...c, bomIncluded: true}))
  const data = {components, nets: [{name: 'GND', nodes: Array.from({length: 2050}, (_, i) => ({reference: `U${i}`, pin: '1', pinName: '', pinType: ''}))}],
    bomAvailable: true, inventoryScope: 'netlist' as const}
  const chunks = queryAnalysisItems(data, 'nets', 'U1', '1') as any[]
  const all: object[] = []
  let offset = 0
  for (;;) {
    const page = pageAnalysisItems(chunks, offset)
    all.push(...page.items)
    if (page.nextOffset === null) break
    assert.ok(page.nextOffset > offset); offset = page.nextOffset
  }
  const nodes = all.flatMap((n: any) => n.nodes)
  assert.equal(nodes.length, 2050)
  assert.equal(new Set(nodes.map(n => n.reference)).size, 2050)
  assert.equal(chunks[1].nodeOffset, 32); assert.equal(chunks[0].totalNodes, 2050)
  assert.equal('pinName' in nodes[0], false)
  assert.deepEqual(queryAnalysisItems(data, 'nets', undefined, undefined, 'missing'), [])
  const bom = queryAnalysisItems(data, 'bom') as any[]
  assert.equal(bom.length, 3)
  assert.deepEqual(bom[0].references, ['U1', 'U2']); assert.equal(bom[0].quantity, 2)
  assert.equal(bom[1].fields.MPN, 'OTHER'); assert.equal(bom[2].dnp, true)
  const brief = queryAnalysisItems(data, 'components') as any[]
  assert.equal('fields' in brief[0], false); assert.equal('dnp' in brief[0], false)
  const detail = queryAnalysisItems(data, 'components', 'U1') as any[]
  assert.equal(detail[0].fields.MPN, 'REAL-PART')
  const unknown = queryAnalysisItems({...data, bomAvailable: false, components: [{...first, bomIncluded: null}]}, 'components') as any[]
  assert.equal(unknown[0].bomIncluded, null)
  // A representative repeated network uses fewer serialized characters after grouping.
  const old = data.nets[0]!.nodes.map(n => ({net: 'GND', nodeCount: 2050, ...n}))
  assert.ok(JSON.stringify(chunks).length < JSON.stringify(old).length)
})

test('public queries require view, omit repeated metadata and explicitly distinguish unavailable data', async () => fixture(async ({source, services, exec}) => {
  const tools: any[] = [], options: any[] = []
  const data = {...parseAnalysisNetlist(exported), bomAvailable: true, inventoryScope: 'netlist' as const}
  const analysis = {status: 'ready' as 'ready' | 'partial', cached: true, revision: 'long-revision',
    files: {components: 'long-components-path', connectivity: 'long-connectivity-path'},
    counts: {components: 1, nets: 1, bom: 1}, inventoryScope: 'netlist' as const, diagnostics: [] as string[], nextAction: 'long hint'}
  registerModuleAnalysis({...services, effect: (fn: () => unknown) => fn(), tools: {register: (t: any) => {tools.push(t); return () => {}}}} as never,
    config, async (_path, _exec, input) => {options.push(input); return {analysis, data}})
  const tool = tools[0]
  assert.deepEqual(tool.parameters.required, ['schematicPath', 'view'])
  assert.equal(Object.keys(tool.parameters.properties).length, 7)
  await assert.rejects(tool.execute({schematicPath: source}, exec), /view/)
  await assert.rejects(tool.execute({schematicPath: source, view: 'nets', pin: '1'}, exec), /pin requires/)
  await assert.rejects(tool.execute({schematicPath: source, view: 'components', net: 'GND'}, exec), /net applies/)
  await assert.rejects(tool.execute({schematicPath: source, view: 'summary', kicadCliPath: 'x'}, exec), /kicadCliPath/)
  const details = await tool.execute({schematicPath: source, view: 'components'}, exec)
  assert.deepEqual(Object.keys(details).sort(), ['items', 'status'])
  assert.equal(options.at(-1).reusePartial, true)
  const summary = await tool.execute({schematicPath: source, view: 'summary'}, exec)
  assert.deepEqual(summary, {status: 'ready', counts: analysis.counts, inventoryScope: 'netlist'})
  assert.equal(options.at(-1).reusePartial, false)
  const hostCli = join(dirname(source), 'host', 'kicad-cli.exe')
  await tool.execute({schematicPath: source, view: 'summary', kicadCliPath: hostCli}, exec)
  assert.equal(options.at(-1).kicadCliPath, hostCli)
  data.components[0]!.fields.LongField = 'x'.repeat(25000)
  const oversized = await tool.execute({schematicPath: source, view: 'components', reference: 'U1'}, exec)
  assert.equal(oversized.items[0].omitted, true)
  assert.deepEqual(oversized.files, analysis.files)
  analysis.status = 'partial'; analysis.diagnostics = ['x'.repeat(2000)]
  data.bomAvailable = false
  const missing = await tool.execute({schematicPath: source, view: 'bom'}, exec)
  assert.deepEqual(missing.items, [])
  assert.ok(missing.warnings.some((s: string) => s.includes('BOM unavailable')))
  assert.ok(missing.warnings.every((s: string) => s.length <= 400))
}))

test('analysis remembers download environment and discovers matching project after restart', async () => fixture(async ({source, services, exec, root}) => {
  const project = join(root, 'reference.kicad_pro')
  await writeFile(project, '{"custom":"project"}')
  const cliCalls: string[] = []
  let expectedProject = '{"custom":"project"}'
  const runner = async (cli: string, args: readonly string[]) => {
    cliCalls.push(cli)
    if (args.includes('--help')) return result(help(args))
    assert.equal(await readFile(args.at(-1)!.replace(/\.kicad_sch$/, '.kicad_pro'), 'utf8'), expectedProject)
    await writeFile(args[args.indexOf('--output') + 1]!, args.includes('netlist') ? exported : csv)
    return result()
  }
  const analyze = createModuleAnalyzer(services, config, runner)
  const rememberedCli = join(root, 'host', 'kicad-cli.exe')
  const first = await analyze(source, exec, {sourceProjectPath: project, kicadCliPath: rememberedCli})
  const reused = await analyze(source, exec, {reusePartial: true})
  assert.equal(reused.analysis.revision, first.analysis.revision)
  assert.equal(reused.analysis.cached, true); assert.equal(cliCalls.length, 4)
  assert.ok(cliCalls.every(cli => cli === rememberedCli))
  const downloaded = join(dirname(source), 'HQ_EDA_demo.kicad_sch')
  await writeFile(downloaded, await readFile(source))
  await writeFile(downloaded.replace('.kicad_sch', '.source.kicad_pro'), '{"custom":"project"}')
  const fresh = createModuleAnalyzer(services, config, runner)
  const recovered = await fresh(downloaded, exec)
  assert.equal(recovered.analysis.status, 'ready')
  expectedProject = '{"custom":"changed"}'
  await writeFile(downloaded.replace('.kicad_sch', '.source.kicad_pro'), '{"custom":"changed"}')
  const changed = await fresh(downloaded, exec)
  assert.equal(changed.analysis.status, 'ready')
  assert.notEqual(changed.analysis.revision, recovered.analysis.revision)
}))

test('CLI start failure guides host-path recovery without downloading and reuses the successful path', async () => fixture(async ({source, services, exec, root}) => {
  const hostCli = join(root, 'host', 'kicad-cli.exe'), wrongCli = join(root, 'missing', 'kicad-cli.exe')
  let calls = 0
  const analyze = createModuleAnalyzer(services, {...config, kicadCliPath: wrongCli}, async (cli, args) => {
    calls++
    if (cli !== hostCli) throw Object.assign(new Error(`spawn ${cli} ENOENT`), {code: 'ENOENT'})
    if (args.includes('--help')) return result(help(args))
    await writeFile(args[args.indexOf('--output') + 1]!, args.includes('netlist') ? exported : csv)
    return result()
  })
  const tools: any[] = []
  registerModuleAnalysis({...services, effect: (fn: () => unknown) => fn(), tools: {register: (t: any) => tools.push(t)}} as never, config, analyze)
  const tool = tools[0]
  const failed = await tool.execute({schematicPath: source, view: 'summary'}, exec)
  assert.equal(failed.status, 'unavailable')
  assert.deepEqual(failed.error, {code: 'CLI_START_FAILED', executable: wrongCli})
  assert.ok(failed.warnings.some((s: string) => s.includes('ENOENT')))
  assert.ok(failed.warnings.some((s: string) => s.includes('get_eda_host_info') && s.includes('kicadCliPath') && s.includes('Do not download again')))
  assert.equal((await tool.execute({schematicPath: source, view: 'summary', kicadCliPath: hostCli}, exec)).status, 'ready')
  const afterRecovery = calls
  assert.equal((await tool.execute({schematicPath: source, view: 'components'}, exec)).status, 'ready')
  assert.equal(calls, afterRecovery)
  assert.ok((await readFile(source, 'utf8')).includes('kicad_sch'))
}))

test('CLI capability, timeout and command failures preserve causes without wrong path-recovery advice', async () => fixture(async ({source, services, exec}) => {
  for (const [expected, probeResult] of [
    ['CLI_CAPABILITY_UNSUPPORTED', result('no supported options')],
    ['CLI_PROBE_TIMEOUT', {...result(), timedOut: true}],
    ['CLI_PROBE_FAILED', {...result(), exitCode: 1, stderr: 'configuration cannot be read'}],
  ] as const) {
    const analyze = createModuleAnalyzer(services, config, async () => probeResult)
    const output = await analyze(source, exec)
    assert.equal(output.analysis.failure!.code, expected)
    assert.equal(output.analysis.status, 'unavailable')
    assert.ok(!output.analysis.nextAction.includes('get_eda_host_info'))
    if (expected === 'CLI_PROBE_FAILED') assert.match(output.analysis.diagnostics[0]!, /configuration cannot be read/)
  }
}))

test('analysis caches exact revisions, repairs damaged artifacts and never changes the source', async () => fixture(async ({source, services, exec}) => {
  const calls: string[][] = []
  const runner = async (_cli: string, args: readonly string[]) => {
    calls.push([...args]); if (args.includes('--help')) return result(help(args))
    await writeFile(args[args.indexOf('--output') + 1]!, args.includes('netlist') ? exported : csv)
    return result()
  }
  const analyze = createModuleAnalyzer(services, config, runner)
  const before = await readFile(source, 'utf8')
  const first = await analyze(source, exec)
  assert.equal(first.analysis.status, 'ready'); assert.equal(first.data!.components!.length, 1)
  assert.equal(calls.length, 4)
  assert.deepEqual((await readdir(dirname(first.analysis.files!.components))).sort(), ['components.json', 'connectivity.json'])
  const saved = JSON.parse(await readFile(first.analysis.files!.components, 'utf8'))
  assert.equal(saved.metadata.version, 2)
  assert.equal(saved.metadata.revision, first.analysis.revision)
  assert.equal(saved.data.components[0].bomIncluded, true)
  assert.equal('manifestPath' in first.analysis, false)
  assert.equal((await analyze(source, exec)).analysis.cached, true); assert.equal(calls.length, 4)
  await writeFile(first.analysis.files!.components, '[]')
  assert.equal((await analyze(source, exec)).data!.components!.length, 1); assert.equal(calls.length, 6)
  assert.equal(await readFile(source, 'utf8'), before)
  await writeFile(source, before + '\n')
  const changed = await analyze(source, exec)
  assert.notEqual(changed.analysis.revision, first.analysis.revision)
  assert.equal(calls.length, 8)
  assert.equal(calls.some(a => a.includes('erc')), false)
}))

test('partial exports remain explicit and can recover; missing CLI does not destroy downloaded files', async () => fixture(async ({source, services, exec}) => {
  let broken = true
  const analyze = createModuleAnalyzer(services, config, async (_cli, args) => {
    if (args.includes('--help')) return result(help(args))
    if (args.includes('bom') && broken) return {...result(), exitCode: 1, stderr: 'unsupported project'}
    await writeFile(args[args.indexOf('--output') + 1]!, args.includes('netlist') ? exported : csv)
    return result()
  })
  const partial = await analyze(source, exec)
  assert.equal(partial.analysis.status, 'partial'); assert.equal(partial.data!.nets!.length, 1)
  assert.equal(partial.analysis.counts!.bom, undefined)
  assert.equal(partial.data!.components![0]!.bomIncluded, null)
  broken = false
  const reused = await analyze(source, exec, {reusePartial: true})
  assert.equal(reused.analysis.status, 'partial'); assert.equal(reused.analysis.cached, true)
  assert.equal((await analyze(source, exec)).analysis.status, 'ready')
  const unavailable = createModuleAnalyzer(services, config, async () => {throw new Error('spawn ENOENT')})
  assert.equal((await unavailable(source, exec)).analysis.status, 'unavailable')
  assert.ok((await readFile(source, 'utf8')).includes('kicad_sch'))
}))

test('BOM-only and fully failed extraction omit unavailable counts and preserve explicit null datasets', async () => fixture(async ({source, services, exec}) => {
  let failBom = false
  const analyze = createModuleAnalyzer(services, config, async (_cli, args) => {
    if (args.includes('--help')) return result(help(args))
    if (args.includes('netlist') || failBom) return {...result(), exitCode: 1, stderr: 'export failed'}
    await writeFile(args[args.indexOf('--output') + 1]!, csv)
    return result()
  })
  const partial = await analyze(source, exec)
  assert.equal(partial.analysis.status, 'partial')
  assert.equal(partial.analysis.inventoryScope, 'bom_only')
  assert.equal(partial.analysis.counts!.nets, undefined)
  assert.equal(partial.analysis.counts!.components, 1)
  assert.equal(partial.data!.nets, null)
  failBom = true
  const failed = await analyze(source, exec)
  assert.equal(failed.analysis.status, 'unavailable')
  assert.deepEqual(failed.analysis.counts, {})
  assert.equal(failed.data!.components, null)
  const saved = JSON.parse(await readFile(failed.analysis.files!.connectivity, 'utf8'))
  assert.equal(saved.data.nets, null)
}))

test('child content invalidates cache; unsafe dependencies fail before any CLI invocation', async () => fixture(async ({source, services, exec, root}) => {
  const child = join(root, 'child.kicad_sch'), before = await readFile(source, 'utf8')
  await writeFile(child, before)
  const sheet = '(sheet (at 10 10) (size 10 10) (uuid "child") (property "Sheetname" "Child") (property "Sheetfile" "../child.kicad_sch"))'
  await writeFile(source, before.slice(0, before.lastIndexOf(')')) + sheet + ')')
  let count = 0
  const analyze = createModuleAnalyzer(services, config, async (_cli, args) => {
    count++; if (args.includes('--help')) return result(help(args))
    const snapshot = await readFile(args.at(-1)!, 'utf8')
    assert.ok(!snapshot.includes('../child.kicad_sch'))
    await writeFile(args[args.indexOf('--output') + 1]!, args.includes('netlist') ? exported : csv); return result()
  })
  const first = await analyze(source, exec)
  assert.equal(first.analysis.status, 'ready')
  await writeFile(child, before + '\n')
  assert.notEqual((await analyze(source, exec)).analysis.revision, first.analysis.revision)
  const after = count
  await writeFile(source, (await readFile(source, 'utf8')).replace('../child.kicad_sch', '../../outside.kicad_sch'))
  await assert.rejects(analyze(source, exec), /inside the agent workspace/)
  assert.equal(count, after)
}))

test('download adapter retains success on analysis failure and forwards a known host CLI only to analysis', async () => fixture(async ({source, exec, root}) => {
  const host = {context: {getTargetHost: () => 'kicad'}, project: {getCurrent: () => ({projectId: root}), onChanged: () => () => {}}}
  const base: any = {parameters: {}, execute: async (args: any) => {
    assert.deepEqual(args, {moduleId: 'module'})
    return {moduleId: 'module', moduleName: 'Module', schematicPath: source, originalProjectPath: null, status: 'created', originalProjectStatus: 'absent', footprints: []}
  }}
  const tool = adaptTool(base, host, async (_path, _exec, options) => {
    assert.equal(options!.kicadCliPath, 'custom-cli'); throw new Error('analysis unavailable')
  })
  const output: any = await tool.execute({moduleId: 'module', kicadCliPath: 'custom-cli'}, exec)
  assert.equal(output.schematicStatus, 'created'); assert.equal(output.analysis.status, 'unavailable')
}))

test('real local KiCad exports label aliases and BOM; tool queries reuse the cache', {skip: !process.env.KICAD_CLI_PATH}, async () => fixture(async ({source, services, exec}) => {
  const tools: any[] = []
  registerModuleAnalysis({...services, effect: (fn: () => unknown) => fn(), tools: {register: (t: any) => {tools.push(t); return () => {}}}} as never,
    {...config, kicadCliPath: process.env.KICAD_CLI_PATH!})
  const tool = tools[0]
  const summary = await tool.execute({schematicPath: source, view: 'summary'}, exec)
  assert.equal(summary.status, 'ready', JSON.stringify(summary.warnings))
  assert.equal(summary.counts.components, 2)
  assert.equal(summary.counts.bom, 2)
  assert.equal('items' in summary, false)
  const nets = await tool.execute({schematicPath: source, view: 'nets', reference: 'U1', pin: '1'}, exec)
  assert.equal(nets.status, 'ready')
  assert.deepEqual(nets.items.flatMap((n: any) => n.nodes.map((node: any) => node.reference)).sort(), ['U1', 'U2'])
  const components = await tool.execute({schematicPath: source, view: 'components', reference: 'U1'}, exec)
  assert.equal(components.items[0].reference, 'U1')
  const text = await readFile(source, 'utf8')
  const u2 = children(parse(text), 'symbol').find(s => children(s, 'property').some(p => value(p) === 'Reference' && value(p, 2) === 'U2'))!
  const dnp = children(u2, 'dnp')[0]!
  await writeFile(source, applyEdits(text, [{start: dnp.start, end: dnp.end, text: '(dnp yes)'}]))
  const assembly = await tool.execute({schematicPath: source, view: 'components', reference: 'U2'}, exec)
  assert.equal(assembly.items[0].dnp, true)
  const bom = await tool.execute({schematicPath: source, view: 'bom', reference: 'U2'}, exec)
  assert.equal(bom.items.length, 1)
  assert.ok(bom.items[0].dnp)
  const assemblyText = await readFile(source, 'utf8')
  const assemblyU2 = children(parse(assemblyText), 'symbol').find(s => children(s, 'property').some(p => value(p) === 'Reference' && value(p, 2) === 'U2'))!
  const inBom = children(assemblyU2, 'in_bom')[0]!
  await writeFile(source, applyEdits(assemblyText, [{start: inBom.start, end: inBom.end, text: '(in_bom no)'}]))
  const excluded = await tool.execute({schematicPath: source, view: 'components', reference: 'U2'}, exec)
  assert.equal(excluded.items[0].excludeFromBom, true)
  assert.equal((await tool.execute({schematicPath: source, view: 'bom', reference: 'U2'}, exec)).items.length, 0)
}))
