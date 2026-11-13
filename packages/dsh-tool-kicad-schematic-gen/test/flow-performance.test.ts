import {testDesignPlan} from './design-plan-fixture.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {summarizeFootprint} from '../src/components/models.ts'
import {Schematic} from '../src/schematic/builder.ts'
import {inspectSchematicText} from '../src/schematic/flat.ts'
import {attachPinLabel} from '../src/schematic/label-leads.ts'
import {summarizeReviewIssues} from '../src/schematic/review-plan.ts'
import {packModuleColumns} from '../src/schematic/module-packing.ts'

test('sheet packing aligns planned columns and keeps all translations on grid',()=>{
 const items=[
  {bounds:{left:50.8,top:38.1,right:101.6,bottom:76.2},reserved:{start:[25.4,25.4],end:[127,101.6]}},
  {bounds:{left:38.1,top:139.7,right:114.3,bottom:165.1},reserved:{start:[25.4,127],end:[127,203.2]}},
  {bounds:{left:177.8,top:50.8,right:254,bottom:127},reserved:{start:[152.4,25.4],end:[279.4,203.2]}},
 ] as Parameters<typeof packModuleColumns>[0]
 assert.deepEqual(packModuleColumns(items,[297,210]),[[-40.64,-27.94],[-27.94,-83.82],[-83.82,-40.64]])
 assert.equal(packModuleColumns(items,[100,60]),undefined)
})

test('candidate feedback prioritizes required fixes and preserves field identities when bounded',()=>{
 const report={
  status:'passed',
  layout:{reviewIssues:[
   {code:'LAYOUT_OVERLAP_REVIEW',references:['U1','R1']},
   {code:'MODULE_LAYOUT_OUTSIDE_FRAME',references:['C1']},
  ]},
  result:{fieldLayout:{unresolved:['R1:Value']}},
 }
 const summary=summarizeReviewIssues(report,2)
 assert.deepEqual(summary.priorityCounts,{must_fix:1,visual_check:1,advisory:1})
 assert.deepEqual(summary.issues.map(issue=>issue.priority),['must_fix','visual_check'])
 assert.equal(summary.issues[1]?.field,'R1:Value')
 assert.equal(summary.omittedIssues,1)
 assert.equal(summary.repairPlan.fullReportRequired,true)
})

const legacy='(module "SOD-123" (layer F.Cu) (tedit 0) (fp_line (start -1 0) (end 1 0) (layer F.SilkS) (width 0.15)) (pad "1" smd rect (at -1 0) (size 1 1) (layers F.Cu F.Mask)) (pad "2" smd rect (at 1 0) (size 1 1) (layers F.Cu F.Mask)))'
const footprint='(footprint "SOD-123" (layer "F.Cu") (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Mask")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Mask")))'
test('modern footprints are parsed and obsolete module roots are rejected',()=>{
 const summary=summarizeFootprint(footprint)
 assert.equal(summary.status,'parsed')
 if(summary.status!=='parsed')throw new Error('Expected parsed footprint')
 assert.equal(summary.padCount,2)
 assert.throws(()=>summarizeFootprint(legacy),/Unsupported footprint format/)
})

test('script launcher preserves Unicode UTF-8 reports, stderr and nonzero exit without shell parsing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'design runner '))
 try{
  const script=join(root,'test design.mjs'),report=join(root,'report.json')
  await writeFile(script,"console.log(JSON.stringify({title:'电源',output:process.argv[2]}));console.error('诊断');process.exitCode=3",'utf8')
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../skills/kicad-schematic-design/scripts/run-design.mjs',import.meta.url)),script,join(root,'candidate'),report,'--plan',testDesignPlan.path,'--plan-sha256',testDesignPlan.sha256],{encoding:'utf8'})
  assert.equal(run.status,3);const data=JSON.parse(await readFile(report,'utf8'));assert.equal(data.exitCode,3);assert.equal(JSON.parse(data.stdout).title,'电源');assert.match(data.stderr,/诊断/)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('launcher recovers one JSON-lines result, preserves full diagnostics and rejects ambiguous summaries',async()=>{
 const root=await mkdtemp(join(tmpdir(),'build result '))
 try{
  const script=join(root,'design.mjs'),report=join(root,'report.json')
  const runner=fileURLToPath(new URL('../skills/kicad-schematic-design/scripts/run-design.mjs',import.meta.url))
  const run=()=>spawnSync(process.execPath,[runner,script,join(root,'candidate'),report,
   '--plan',testDesignPlan.path,'--plan-sha256',testDesignPlan.sha256],{encoding:'utf8'})
  const result={schematicPath:join(root,'电源.kicad_sch'),projectPath:join(root,'电源.kicad_pro'),
   powerLayout:{stage:'final',checkedCount:1,issues:Array.from({length:25},(_,i)=>({code:'POWER_LAYOUT_OVERLAP',uuid:String(i)})),unmeasuredObjectUuids:[]}}
  await writeFile(script,`console.log(JSON.stringify({plannedCount:1}));console.log(${JSON.stringify(JSON.stringify(result))});console.error('完整诊断');`)
  let processResult=run();assert.equal(processResult.status,0,processResult.stderr)
  let envelope=JSON.parse(processResult.stdout)
  assert.equal(envelope.summaryStatus,'recovered');assert.equal(envelope.summary.schematicPath,result.schematicPath)
  assert.equal(envelope.summary.powerLayout.issueCount,25);assert.equal(envelope.summary.powerLayout.issues.length,20)
  assert.equal(envelope.summary.powerLayout.omittedIssues,5)
  let saved=JSON.parse(await readFile(report,'utf8'));assert.match(saved.stderr,/完整诊断/)
  assert.equal(JSON.parse(saved.stdout.trim().split('\n')[1]).powerLayout.issues.length,25)
  await writeFile(script,`console.log(${JSON.stringify(JSON.stringify(result))});`)
  envelope=JSON.parse(run().stdout);assert.equal(envelope.summaryStatus,'ready')
  await writeFile(script,`console.log(${JSON.stringify(JSON.stringify(result))});console.log(${JSON.stringify(JSON.stringify(result))});`)
  processResult=run();envelope=JSON.parse(processResult.stdout)
  assert.equal(processResult.status,0,'summary failure must not rewrite the actual script exit code')
  assert.equal(envelope.summaryStatus,'unavailable');assert.equal(envelope.summary,null);assert.match(envelope.summaryError,/Multiple build results/)
  await writeFile(script,"console.log('not a build result')")
  envelope=JSON.parse(run().stdout);assert.equal(envelope.summaryStatus,'unavailable');assert.match(envelope.summaryError,/No build result/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('label leads work in real region coordinates and reject invalid plans before mutation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'label-leads-'))
 try{
  const library=join(root,'demo.kicad_sym');await writeFile(library,'(kicad_symbol_lib (version 20211014) (generator test) (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1 1)))) (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54) (name "IN" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))')
  const sch=new Schematic({designPlan:testDesignPlan,projectName:'demo',title:'demo',paper:'A4',templateDir:fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url))})
  const region=sch.region({name:'test',description:'test',origin:[30,30],size:[80,80]});region.addSymbol({libraryPath:library,libId:'Demo:Demo',reference:'U1',at:[20,20]})
  region.addSymbol({libraryPath:library,libId:'Demo:Demo',reference:'U2',at:[40,40],angle:90,mirror:'x',
   referenceAt:[38.1,36.83],hideReference:true})
  const catalog=sch.pinCatalog({includeBounds:true})
  assert.deepEqual(catalog.find(o=>o.reference==='U1')?.pins?.[0]?.outward,[-1,0])
  const rotated=catalog.find(o=>o.reference==='U2')
  assert.deepEqual(rotated?.pins?.[0]?.outward,[0,-1])
  assert.deepEqual(rotated?.fields?.find(f=>f.name==='Reference'),{name:'Reference',at:region.at([38.1,36.83]),angle:90,hidden:true})
  const normalize=(text:string)=>text.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,'UUID');const before=normalize(sch.render().schematic)
  assert.throws(()=>attachPinLabel(region,{reference:'U1',pin:'1',net:'NET',direction:'left',length:0}),/positive/);assert.equal(normalize(sch.render().schematic),before)
  attachPinLabel(region,{reference:'U1',pin:'1',net:'NET',direction:'left',lane:1})
  assert.match(sch.render().schematic,/\(label "NET"/);assert.equal((sch.render().schematic.match(/\(wire/g)??[]).length,2)
  const planned=sch.render().resolvedFrames[0]!
  sch.fitRegionFrame('test',catalog.map(o=>o.uuid))
  const fitted=sch.render().resolvedFrames[0]!
  assert.ok(fitted.start.every((n,i)=>n>=planned.start[i]!))
  assert.ok(fitted.end.every((n,i)=>n<planned.end[i]!))
  assert.deepEqual(sch.pin('U1','1'),region.at([20,20]))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('fixed resistor and capacitor fields follow the sheet orientation and preserve explicit offsets',async()=>{
 const templates=new URL('../skills/kicad-schematic-design/templates/',import.meta.url)
 const style=JSON.parse(await readFile(new URL('frame-style.json',templates),'utf8'))
 const libraryPath=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/drawing-patterns/reference-symbols.kicad_sym',import.meta.url))
 const sch=new Schematic({designPlan:testDesignPlan,projectName:'fields',title:'fields',paper:'A4',templateDir:fileURLToPath(templates)})
 for(const [index,angle,mirror] of [[1,0,undefined],[2,180,undefined],[3,0,'y'],[4,180,'y']] as const){
  sch.addSymbol({libraryPath,libId:'Reference:C',reference:`C${index}`,value:'100nF',at:[index*25.4,50.8],angle,mirror})
 }
 sch.addSymbol({libraryPath,libId:'Reference:R',reference:'R1',value:'22R',at:[50.8,76.2],angle:90,referenceOffset:[0,-12.7]})
 const texts=inspectSchematicText(sch.render().schematic,style)
 const field=(reference:string,name:string)=>texts.find(item=>item.reference===reference&&item.field===name)!
 for(const ref of ['C1','C2','C3','C4']){
  const reference=field(ref,'Reference'),value=field(ref,'Value')
  assert.equal(reference.bounds.left,value.bounds.left)
  assert.equal(value.at[0],value.bounds.left)
  assert.ok(reference.bounds.bottom<value.bounds.top)
 }
 assert.deepEqual(field('R1','Reference').at,[50.8,63.5])
 assert.ok(field('R1','Value').bounds.bottom<76.2)
})

test('native NC pins get a blue marker while their library type is retained',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-nc-'))
 try{
  const library=join(root,'demo.kicad_sym')
  await writeFile(library,'(kicad_symbol_lib (version 20211014) (generator test) (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1 1)))) (symbol "Demo_1_1" (pin no_connect line (at 0 0 0) (length 2.54) (name "NC" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))) (pin passive line (at 0 2.54 0) (length 2.54) (name "IO" (effects (font (size 1 1)))) (number "2" (effects (font (size 1 1))))))))')
  const sch=new Schematic({designPlan:testDesignPlan,projectName:'demo',title:'demo',paper:'A4',templateDir:fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url))})
  sch.addSymbol({libraryPath:library,libId:'Demo:Demo',reference:'U1',at:[50.8,50.8]})
  const declared=[{reference:'U1',pin:'2'}]
  assert.deepEqual(sch.ensureNoConnectMarkers(declared),sch.ensureNoConnectMarkers(declared))
  const {schematic}=sch.render()
  assert.match(schematic,/\(pin no_connect line/)
  assert.equal((schematic.match(/\(no_connect \(at/g)??[]).length,2)
  sch.wire([50.8,50.8],[45.72,50.8])
  assert.throws(()=>sch.render(),/MODULE_NO_CONNECT_INVALID: U1\.1/)
 }finally{await rm(root,{recursive:true,force:true})}
})
