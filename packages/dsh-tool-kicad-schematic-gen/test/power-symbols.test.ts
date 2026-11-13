import {testDesignPlan} from './design-plan-fixture.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Schematic } from '../src/schematic/builder.ts'
import { children, parse, value } from '../src/schematic/sexpr.ts'
import { planPowerLabels } from '../src/schematic/power-layout.ts'
import type { FlatPoint } from '../src/schematic/flat.ts'

const templateDir = fileURLToPath(new URL('../skills/kicad-schematic-design/templates', import.meta.url))
const power = (net: string) => `(symbol "${net}" (power)
 (property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
 (property "Value" "${net}" (at 0 -2 0) (effects (font (size 1.27 1.27))))
 (symbol "${net}_0_1" (polyline (pts (xy -1 0) (xy 1 0)) (stroke (width 0.15) (type default)) (fill (type none))))
 (symbol "${net}_1_1" (pin power_in line (at 0 0 0) (length 0) hide
 (name "${net}" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

async function fixture(run: (root: string, library: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-power-symbols-'))
  const library = join(root, 'power.kicad_sym')
  await writeFile(library, `(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor) ${power('GND')} ${power('+3V3')})`)
  try { await run(root, library) } finally { await rm(root, { recursive: true, force: true }) }
}
const build = (requiredPowerSymbols?: Record<string, string>) => new Schematic({designPlan:testDesignPlan,
  projectName: 'power_delivery', title: 'Power delivery', paper: 'A4', templateDir, requiredPowerSymbols,
})

test('fresh UUIDs are selected by current module/net/coordinates on every build', async () => fixture(async (root, library) => {
  const original = build()
  original.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [20, 20] })
  original.label('GND', [30, 30]); original.label('+3V3', [40, 30]); original.label('AGND', [50, 30])
  const source = original.save(join(root, 'source')).schematicPath
  const results: Array<{ uuid: string; content: string }> = []
  for (let iteration = 0; iteration < 2; iteration++) {
    const sch = build({ GND: 'power:GND', '+3V3': 'power:+3V3' })
    const imported = sch.importModule({ sourcePath: source, name: 'core', offset: [10, 10], nets: { GND: 'GND', '+3V3': '+3V3' } })
    sch.frame({ name: 'core', description: 'Power', autoBounds: true, objectUuids: imported.objectUuids })
    const catalog = sch.powerLabelCatalog(['GND', '+3V3'])
    const target = catalog.filter(label => label.module === 'core' && label.net === 'GND'
      && Math.abs(label.at[0] - 40.64) < 0.001 && Math.abs(label.at[1] - 40.64) < 0.001)
    assert.equal(target.length, 1)
    const ground = target[0]!
    const copy = sch.powerLabelCatalog(['GND']); copy[0]!.at[0] = -999
    assert.equal(sch.powerLabelCatalog(['GND'])[0]!.at[0], 40.64)
    const converted = sch.replacePowerLabels({ libraryPath: library, nets: { GND: 'power:GND', '+3V3': 'power:+3V3' },
      placements: { [ground.uuid]: { at: [ground.at[0], 45], angle: 0, valueAt: [ground.at[0], 49] } } })
    assert.equal(converted.find(symbol => symbol.uuid === ground.uuid)?.at[1], 44.45)
    assert.equal(sch.powerLabelCatalog(['GND', '+3V3']).length, 0)
    assert.ok(sch.checkPowerSymbols().every(status => status.symbolCount > 0))
    const saved = sch.save(join(root, `run-${iteration}`))
    const content = await readFile(saved.schematicPath, 'utf8')
    const form = parse(content)
    assert.ok(children(form, 'wire').some(wire => {
      const pts = children(wire, 'pts')[0]!
      return children(pts, 'xy').some(xy => Number(value(xy)) === 40.64 && Number(value(xy, 2)) === 44.45)
    }))
    assert.ok(children(form, 'label').some(label => value(label) === 'core__AGND'))
    results.push({ uuid: ground.uuid, content })
  }
  assert.notEqual(results[0]!.uuid, results[1]!.uuid)
}))

test('required nets block render/save without writing when conversion is omitted or partial', async () => fixture(async (root, library) => {
  const sch = build({ GND: 'power:GND', '+3V3': 'power:+3V3' })
  sch.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  sch.label('GND', [20, 20]); sch.label('+3V3', [30, 20])
  assert.throws(() => sch.render(), /POWER_SYMBOLS_REQUIRED/)
  assert.throws(() => sch.save(join(root, 'rejected')), /POWER_SYMBOLS_REQUIRED/)
  assert.deepEqual(await readdir(root), ['power.kicad_sym'])
  sch.replacePowerLabels({ libraryPath: library, nets: { GND: 'power:GND' } })
  assert.throws(() => sch.checkPowerSymbols(), /\+3V3/)
  sch.replacePowerLabels({ libraryPath: library, nets: { '+3V3': 'power:+3V3' } })
  assert.ok(sch.checkPowerSymbols().every(status => !status.remainingLabelUuids.length))
  sch.label('GND', [40, 40])
  assert.throws(() => sch.save(join(root, 'reintroduced-label')), /unconverted labels/)
}))

test('stale placement UUIDs reject conversion without removing labels; legacy builds remain optional', async () => fixture(async (root, library) => {
  const sch = build()
  sch.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  const uuid = sch.label('GND', [20, 20])
  assert.throws(() => sch.replacePowerLabels({ libraryPath: library, nets: { GND: 'power:GND' },
    placements: { 'previous-build-uuid': { at: [20, 25] } } }), /does not select a mapped label/)
  assert.equal(sch.powerLabelCatalog(['GND'])[0]!.uuid, uuid)
  assert.deepEqual(sch.checkPowerSymbols(), [])
  sch.save(join(root, 'legacy'))
}))

test('a #PWR reference without an actual power definition cannot satisfy delivery', async () => fixture(async (root, library) => {
  const ordinaryLibrary = join(root, 'ordinary.kicad_sym')
  await writeFile(ordinaryLibrary, (await readFile(library, 'utf8')).replaceAll('(power)', ''))
  const required = { GND: 'power:GND' }
  const sch = build(required)
  // Requirements are copied: later mutation of the caller's map cannot disable them.
  delete (required as Partial<typeof required>).GND
  sch.addSymbol({ libraryPath: ordinaryLibrary, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  assert.throws(() => sch.checkPowerSymbols(), /GND: 0 power symbols/)
}))

test('catalog includes global and flattened port labels while excluding unrelated nets', async () => fixture(async (root, library) => {
  const original = build()
  original.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  const source = original.save(join(root, 'source')).schematicPath
  const text = await readFile(source, 'utf8')
  const rootForm = parse(text)
  const extra = `
    (global_label "GND" (shape input) (at 20.32 30.48 90) (effects (font (size 1.27 1.27))) (uuid "global-ground"))
    (hierarchical_label "GND" (shape input) (at 40.64 30.48 0) (effects (font (size 1.27 1.27))) (uuid "hier-ground"))
    (label "AGND" (at 49.53 30.48 0) (effects (font (size 1.27 1.27))) (uuid "analog-ground"))
  `
  await writeFile(source, `${text.slice(0, rootForm.end - 1)}${extra}${text.slice(rootForm.end - 1)}`)
  const sch = build()
  sch.importModule({ sourcePath: source, name: 'global_module', offset: [5, 5], nets: { GND: 'GND' } })
  const labels = sch.powerLabelCatalog(['GND'])
  // importModule deliberately flattens hierarchical ports to local labels first.
  assert.equal(labels.length, 2)
  const global = labels.find(label => label.type === 'global_label')!
  assert.equal(global.module, 'global_module')
  assert.deepEqual(global.at, [25.4, 35.56]); assert.equal(global.angle, 90)
  assert.ok(labels.every(label => label.net === 'GND'))
}))

test('planner reserves rendered titles and descriptions, while final diagnostics reflect actual overrides',async()=>fixture(async(root,library)=>{
  const sch=build({GND:'power:GND'})
  sch.region({name:'Power module',description:'Input and output',origin:[20.32,20.32],size:[60.96,60.96]})
  const uuid=sch.label('GND',[50.8,50.8])
  const plan=sch.planPowerPlacements({libraryPath:library,nets:{GND:'power:GND'},maxMoveMm:0})
  assert.deepEqual(plan.diagnostics.unresolved,[])
  plan.placements[uuid]={at:[50.8,50.8],angle:90,valueAt:[50.8,19.05]}
  sch.replacePowerLabels({libraryPath:library,nets:{GND:'power:GND'},placements:plan.placements})
  const saved=sch.save(join(root,'overridden'))
  assert.equal(saved.powerLayout.stage,'final')
  assert.equal(saved.powerLayout.checkedCount,1)
  assert.ok(saved.powerLayout.issues.some(issue=>issue.code==='POWER_LAYOUT_OUTSIDE_FRAME'&&issue.uuid===uuid&&issue.frame==='Power module'))
  // The earlier plan was clean; its immutable diagnostics are not reported as final truth.
  assert.deepEqual(plan.diagnostics.unresolved,[])
  const content=parse(await readFile(saved.schematicPath,'utf8'))
  const symbol=children(content,'symbol')[0]!
  const val=children(symbol,'property').find(p=>value(p)==='Value')!
  const rotation = Number(value(children(symbol,'at')[0]!,3))
  const fieldAngle = Number(value(children(val,'at')[0]!,3))
  assert.equal((rotation + fieldAngle) % 180,0,'rotated power symbols keep horizontal value text')
}))

test('power planning can use one bend when every straight landing is obstructed', () => {
  const anchor: FlatPoint = [25.4,25.4]
  const offsets = [[0,0],[1.27,0],[-1.27,0],[0,1.27],[0,-1.27],[2.54,0],[-2.54,0],[0,2.54],[0,-2.54]] as const
  const obstacles = offsets.map(([dx,dy],index) => ({
    uuid: String(index),type:'text',
    bounds:{left:anchor[0]+dx+4.9,right:anchor[0]+dx+5.1,top:anchor[1]+dy+4.9,bottom:anchor[1]+dy+5.1},
  }))
  const result=planPowerLabels([{uuid:'label',net:'GND',at:anchor,type:'label',angle:0}],obstacles,
    ()=>({body:{left:4.9,right:5.1,top:4.9,bottom:5.1},textSize:[0.2,0.2]}),[100,100],{maxMoveMm:2.54,clearanceMm:0.1})
  assert.deepEqual(result.diagnostics.unresolved,[])
  const placement=result.placements.label!
  assert.equal(placement.via?.length,1)
  const [bend]=placement.via!
  assert.ok(bend![0]===anchor[0] || bend![1]===anchor[1])
  assert.ok(bend![0]===placement.at[0] || bend![1]===placement.at[1])
})

test('power planning rotates away from incoming wires while allowing pin contact', () => {
  const sch=build()
  const libraryPath=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/libraries/power.kicad_sym',import.meta.url))
  const nets={GND:'power:GND','+3V3':'power:+3V3'}
  const gnd=sch.label('GND',[50.8,50.8]), supply=sch.label('+3V3',[76.2,50.8])
  sch.wire([50.8,50.8],[50.8,55.88])
  sch.wire([76.2,50.8],[76.2,45.72])
  const {placements}=sch.planPowerPlacements({libraryPath,nets,maxMoveMm:0})
  assert.notEqual(placements[gnd]?.angle,0)
  assert.notEqual(placements[supply]?.angle,0)
  sch.replacePowerLabels({libraryPath,nets,placements})
  assert.ok(!sch.powerLayoutDiagnostics().issues.some(issue=>issue.code==='POWER_SYMBOL_WIRE_CROSSING'))
})

test('final diagnostics locate crossings on the generated lead and on an unsplit wire', () => {
  const sch=build()
  const libraryPath=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/libraries/power.kicad_sym',import.meta.url))
  const nets={GND:'power:GND'}
  const moved=sch.label('GND',[50.8,50.8]), middle=sch.label('GND',[76.2,50.8])
  sch.wire([76.2,45.72],[76.2,55.88])
  sch.replacePowerLabels({libraryPath,nets,placements:{[moved]:{at:[50.8,46.99],angle:0}}})
  const crossings=sch.powerLayoutDiagnostics().issues.filter(issue=>issue.code==='POWER_SYMBOL_WIRE_CROSSING')
  assert.deepEqual(crossings.map(issue=>({uuid:issue.uuid,net:issue.net,from:issue.from,to:issue.to})),[
    {uuid:moved,net:'GND',from:[50.8,50.8],to:[50.8,46.99]},
    {uuid:middle,net:'GND',from:[76.2,45.72],to:[76.2,55.88]},
  ])
})

test('power annotations are deduplicated by physical wires, with unjoined crossings and other modules preserved', () => {
  const sch=build({GND:'power:GND'})
  const owned=new Set<string>()
  const own=(...ids:string[])=>ids.forEach(id=>owned.add(id))
  own(...sch.wire([25.4,50.8],[50.8,50.8]))
  own(...sch.wire([38.1,50.8],[38.1,55.88]))
  own(...sch.wire([44.45,44.45],[44.45,57.15]))
  const kept=sch.label('GND',[25.4,50.8]), duplicate=sch.label('GND',[38.1,55.88])
  const crossing=sch.label('GND',[44.45,44.45]), unrelated=sch.label('GND',[50.8,50.8])
  own(kept,duplicate,crossing)
  const removed=sch.deduplicatePowerLabels(['GND'],[owned])
  assert.ok(removed.includes(duplicate))
  assert.equal(removed.length,2,'only the duplicate and its dedicated stub should disappear')
  assert.deepEqual(sch.powerLabelCatalog(['GND']).map(label=>label.uuid),[kept,crossing,unrelated])
  const libraryPath=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/libraries/power.kicad_sym',import.meta.url))
  sch.replacePowerLabels({libraryPath,nets:{GND:'power:GND'}})
  assert.equal(sch.checkPowerSymbols()[0]?.symbolCount,3)
})

test('mixed power presentation keeps the exact net name and UUID of global labels', () => {
  const sch=new Schematic({designPlan:testDesignPlan,projectName:'mixed_power',title:'Mixed power',paper:'A4',templateDir,
    requiredPowerSymbols:{GND:'power:GND'},allowGlobalPowerLabels:true})
  const libraryPath=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/libraries/power.kicad_sym',import.meta.url))
  const symbol=sch.label('GND',[50.8,50.8])
  const label=sch.label('GND',[76.2,50.8],180)
  const global=sch.globalLabel('GND',[76.2,76.2])
  const spec={libraryPath,nets:{GND:'power:GND'},keepAsGlobalLabels:new Set([label])}
  const plan=sch.planPowerPlacements(spec)
  assert.deepEqual(Object.keys(plan.placements),[symbol])
  sch.replacePowerLabels({...spec,placements:plan.placements})
  assert.deepEqual(sch.powerLabelCatalog(['GND']).map(({uuid,net,type})=>({uuid,net,type})),[
    {uuid:label,net:'GND',type:'global_label'},{uuid:global,net:'GND',type:'global_label'},
  ])
  assert.equal(sch.checkPowerSymbols()[0]?.symbolCount,1)
})

test('single-sheet power labels can retain their ordinary label style alongside symbols', () => {
  const sch=build({GND:'power:GND','+3V3':'power:+3V3'})
  const libraryPath=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/libraries/power.kicad_sym',import.meta.url))
  const symbol=sch.label('GND',[50.8,50.8])
  const branch=sch.label('GND',[76.2,50.8],180)
  const supply=sch.label('+3V3',[76.2,76.2])
  const spec={libraryPath,nets:{GND:'power:GND','+3V3':'power:+3V3'},keepAsLocalLabels:new Set([branch,supply])}
  assert.throws(()=>sch.checkPowerSymbols(),/POWER_SYMBOLS_REQUIRED/)
  const plan=sch.planPowerPlacements(spec)
  assert.deepEqual(Object.keys(plan.placements),[symbol])
  sch.replacePowerLabels({...spec,placements:plan.placements})
  assert.deepEqual(sch.powerLabelCatalog(['GND','+3V3']).map(({uuid,type})=>[uuid,type]),[[branch,'label'],[supply,'label']])
  assert.deepEqual(sch.checkPowerSymbols().map(status=>status.symbolCount),[1,0])
})

test('region field offsets are relative to a rotated symbol along sheet axes', async () => fixture(async (root, library) => {
  const sch=build()
  const region=sch.region({name:'Fields',description:'',origin:[20.32,20.32],size:[60.96,60.96]})
  region.addSymbol({libraryPath:library,libId:'power:GND',reference:'U1',at:[12.7,12.7],angle:90,
    referenceOffset:[-2.54,3.81],valueAt:[15.24,17.78]})
  const symbol=children(parse(await readFile(sch.save(join(root,'offsets')).schematicPath,'utf8')),'symbol')[0]!
  const position=(name:string)=>children(children(symbol,'property').find(p=>value(p)===name)!,'at')[0]!.items.slice(1,3).map(Number)
  assert.deepEqual(position('Reference'),[30.48,36.83])
  assert.deepEqual(position('Value'),[35.56,38.1])
}))

test('final diagnostics retain original module ownership after a manual move outside it',async()=>fixture(async(root,library)=>{
  const sch=build({GND:'power:GND'})
  sch.region({name:'Owned',description:'Stay inside',origin:[20.32,20.32],size:[60.96,60.96]})
  const uuid=sch.label('GND',[50.8,50.8])
  sch.replacePowerLabels({libraryPath:library,nets:{GND:'power:GND'},placements:{
    [uuid]:{at:[100.33,50.8],valueAt:[100.33,55.88]},
  }})
  assert.ok(sch.powerLayoutDiagnostics().issues.some(issue=>issue.code==='POWER_LAYOUT_OUTSIDE_FRAME'&&issue.frame==='Owned'))
  const clean=build({GND:'power:GND'})
  clean.region({name:'Safe',description:'Text reserved',origin:[20.32,20.32],size:[60.96,60.96]})
  clean.label('GND',[50.8,27.94])
  const plan=clean.planPowerPlacements({libraryPath:library,nets:{GND:'power:GND'}})
  clean.replacePowerLabels({libraryPath:library,nets:{GND:'power:GND'},placements:plan.placements})
  assert.ok(!clean.save(join(root,'safe')).powerLayout.issues.some(issue=>issue.code==='POWER_LAYOUT_OUTSIDE_FRAME'))
}))
