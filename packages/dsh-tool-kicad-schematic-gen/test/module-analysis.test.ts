import {testDesignPlan} from './design-plan-fixture.ts'
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
import {adaptTool} from '../src/modules/kicad-download.ts'

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
    const sch = new Schematic({designPlan:testDesignPlan,projectName: 'demo', title: 'demo', paper: 'A4',
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
  const reused = await analyze(source, exec)
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
  assert.deepEqual((await readdir(dirname(first.analysis.files!.components))).sort(), ['bom.json', 'components.json', 'connectivity.json'])
  const saved = JSON.parse(await readFile(first.analysis.files!.components, 'utf8'))
  assert.equal(saved.metadata.version, 3)
  assert.equal(saved.metadata.revision, first.analysis.revision)
  assert.equal(first.data!.components![0]!.bomIncluded, true)
  assert.equal('manifestPath' in first.analysis, false)
  assert.equal((await analyze(source, exec)).analysis.cached, true); assert.equal(calls.length, 4)
  await writeFile(first.analysis.files!.components, '[]')
  assert.equal((await analyze(source, exec)).data!.components!.length, 1); assert.equal(calls.length, 6)
  assert.equal(await readFile(source, 'utf8'), before)
  await writeFile(source, before + '\n')
  const changed = await analyze(source, exec)
  assert.notEqual(changed.analysis.revision, first.analysis.revision)
  assert.equal(calls.length, 8)
  assert.ok(calls.every(a => a[0] === 'sch' && a[1] === 'export' && ['netlist', 'bom'].includes(a[2]!)))
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
  const reused = await analyze(source, exec)
  assert.equal(reused.analysis.status, 'partial'); assert.equal(reused.analysis.cached, true)
  assert.equal((await analyze(source, exec, {refresh:true})).analysis.status, 'ready')
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
  const failed = await analyze(source, exec, {refresh:true})
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

test('download exports local BOM, connectivity and ports and retries without downloading again', async () => fixture(async ({source, services, exec, root}) => {
  const host = {context:{getTargetHost:()=>'kicad'},project:{getCurrent:()=>({projectId:root}),onChanged:()=>()=>{}}}
  let downloads=0
  const base={parameters:{},execute:async (args:unknown)=>{
    assert.deepEqual(args,{moduleId:'module'})
    downloads++
    return {moduleId:'module',moduleName:'Module',schematicPath:source,originalProjectPath:null,status:'created',footprints:[{footprintName:'Demo',footprintPath:'Demo.kicad_mod'}]}
  }}
  const cliPath=join(root,'host','kicad-cli.exe')
  const analyze=createModuleAnalyzer(services,config,async (cli,args)=>{
    if (cli!==cliPath) throw Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'})
    if (args.includes('--help')) return result(help(args))
    await writeFile(args[args.indexOf('--output')+1]!,args.includes('netlist')?exported:csv)
    return result()
  })
  let sourceWithPort='(kicad_sch (hierarchical_label "EN" (shape input)))'
  const tool=adaptTool(base as never,host,analyze,async()=>sourceWithPort)
  const first:any=await tool.execute({moduleId:'module'},exec)
  assert.equal(first.schematicStatus,'created')
  assert.equal(first.analysis.status,'unavailable')
  assert.deepEqual(first.analysis.ports.items,['EN'])
  assert.equal(first.analysis.ports.nextAction,undefined)
  assert.match(first.analysis.nextAction,/refreshAnalysis:true/)
  sourceWithPort='(kicad_sch '+Array.from({length:61},(_,index)=>`(hierarchical_label "P${index}" (shape input))`).join(' ')+')'
  const retry:any=await tool.execute({moduleId:'module',refreshAnalysis:true,kicadCliPath:cliPath},exec)
  assert.equal(retry.schematicStatus,'existing')
  assert.equal(retry.analysis.status,'ready')
  assert.equal(retry.analysis.ports.truncated,true)
  assert.equal(retry.analysis.ports.items.length,60)
  assert.match(retry.analysis.ports.nextAction,/list_kicad_hierarchical_ports.*schematicPath/)
  assert.match(retry.analysis.filesHint,/analysis\.files/)
  assert.equal(downloads,1)
  assert.equal(JSON.parse(await readFile(retry.analysis.files.bom,'utf8')).items[0].fields.MPN,'REAL-PART')
  assert.equal(JSON.parse(await readFile(retry.analysis.files.connectivity,'utf8')).data.nets[0].name,'EN')
}))

test('download without packaged footprints skips both CLI exports and port parsing', async () => fixture(async ({source, exec, root}) => {
  const host = {context:{getTargetHost:()=>'kicad'},project:{getCurrent:()=>({projectId:root}),onChanged:()=>()=>{}}}
  const base={parameters:{},execute:async()=>({moduleId:'module',moduleName:'Module',schematicPath:source,status:'created',footprints:[]})}
  const unexpected=async()=>{assert.fail('skipped analysis should never run')}
  const tool=adaptTool(base as never,host,unexpected,unexpected)
  const output:any=await tool.execute({moduleId:'module'},exec)
  assert.equal(output.footprints,null)
  assert.deepEqual(output.analysis,{status:'skipped',reason:'no_packaged_footprints'})
  assert.match(output.nextAction,/Select another module/)
}))

test('real KiCad writes BOM and connectivity artifacts', {skip: !process.env.KICAD_CLI_PATH}, async () => fixture(async ({source, services, exec}) => {
  const analyze = createModuleAnalyzer(services, {...config, kicadCliPath:process.env.KICAD_CLI_PATH!})
  const {analysis} = await analyze(source, exec)
  assert.equal(analysis.status, 'ready', JSON.stringify(analysis.diagnostics))
  const bom = JSON.parse(await readFile(analysis.files!.bom!, 'utf8'))
  assert.deepEqual(bom.items.map((item:{reference:string})=>item.reference).sort(), ['U1','U2'])
  const connectivity = JSON.parse(await readFile(analysis.files!.connectivity, 'utf8'))
  assert.ok(connectivity.data.nets.some((net:{nodes:unknown[]})=>net.nodes.length===2))
}))
