import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {Schematic} from '../src/schematic/builder.ts'
import {children,parse,value} from '../src/schematic/sexpr.ts'
import {testDesignPlan} from './design-plan-fixture.ts'

test('mixed example runs through the documented launcher with config, footprints and shared power',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mixed example '))
 try{
  const skill=fileURLToPath(new URL('../skills/kicad-schematic-design/',import.meta.url))
  const library=join(root,'parts.kicad_sym'),powerLibrary=join(root,'power.kicad_sym')
  const pin=(n:string,y:number)=>`(pin passive line (at 0 ${y} 90) (length 2.54) (name "P${n}" (effects (font (size 1 1)))) (number "${n}" (effects (font (size 1 1)))))`
  await writeFile(library,`(kicad_symbol_lib (version 20211014) (generator test) (symbol "R" (property "Reference" "R" (at 0 0 0) (effects (font (size 1 1)))) (symbol "R_1_1" ${pin('1',2.54)} ${pin('2',-2.54)})))`)
  await writeFile(powerLibrary,'(kicad_symbol_lib (version 20211014) (generator test) (symbol "GND" (power) (property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1 1)) hide)) (property "Value" "GND" (at 0 -2.54 0) (effects (font (size 1 1)))) (symbol "GND_1_1" (pin power_in line (at 0 0 0) (length 0) (name "GND" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))')
  const source=new Schematic({designPlan:testDesignPlan,projectName:'source',title:'Source',paper:'A4',templateDir:join(skill,'templates')})
  source.addSymbol({libraryPath:library,libId:'Parts:R',reference:'R1',at:[30.48,30.48],footprint:'Local:Source'})
  source.label('OUT',source.pin('R1','1'));source.label('GND',source.pin('R1','2'))
  const sourcePath=source.save(join(root,'source')).schematicPath
  const config=join(root,'config.json'),output=join(root,'candidate'),report=join(root,'report.json')
  await writeFile(config,JSON.stringify({projectName:'mixed',title:'Mixed',paper:'A4',
   source:{sourcePath,name:'core',offset:[0,0],nets:{OUT:'SIGNAL',GND:'GND'}},
   sourceTitle:'Core',sourceDescription:'Inspected source',signalPort:'OUT',groundNet:'GND',
   powerSymbols:{libraryPath:powerLibrary,nets:{GND:'power:GND'}},
   loadRegion:{name:'Load',description:'Additional load',origin:[160,30],size:[70,80]},
   resistor:{libraryPath:library,libId:'Parts:R',footprint:'Local:Load',unit:1,value:'10k',pins:{signal:'1',ground:'2'}}}))
  const run=spawnSync(process.execPath,[join(skill,'scripts','run-design.mjs'),join(skill,'assets','mixed-design','design.mjs'),output,report,
   '--plan',testDesignPlan.path,'--plan-sha256',testDesignPlan.sha256,config],{encoding:'utf8',windowsHide:true})
  assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`)
  const envelope=JSON.parse(run.stdout)
  assert.equal(envelope.summaryStatus,'ready')
  assert.equal(envelope.summary.powerLayout.stage,'final')
  const saved=JSON.parse(JSON.parse(await readFile(report,'utf8')).stdout)
  assert.equal(saved.powerPlan.stage,'automatic')
  assert.equal(saved.powerLayout.stage,'final')
  assert.equal(saved.schematicPath,join(output,'mixed.kicad_sch'))
  assert.notEqual(saved.loadReference,saved.importedReferences.R1)
  const schematic=parse(await readFile(saved.schematicPath,'utf8'))
  const symbols=children(schematic,'symbol')
  const load=symbols.find(s=>children(s,'property').some(p=>value(p)==='Reference'&&value(p,2)===saved.loadReference))!
  assert.ok(children(load,'property').some(p=>value(p)==='Footprint'&&value(p,2)==='Local:Load'))
  assert.ok(symbols.some(s=>children(s,'lib_id').some(id=>value(id)==='power:GND')))
  assert.ok(!children(schematic,'label').some(label=>value(label)==='GND'))
  assert.ok(children(schematic,'label').some(label=>value(label)==='SIGNAL'))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('modular example uses separate layout settings and emits one complete build result',async()=>{
 const root=await mkdtemp(join(tmpdir(),'modular example '))
 try{
  const skill=fileURLToPath(new URL('../skills/kicad-schematic-design/',import.meta.url))
  const reference=await readFile(join(skill,'assets','drawing-patterns','reference-symbols.kicad_sym'),'utf8')
  // The example's Device/power lookups use a deterministic, bundled fixture rather than the host installation.
  await writeFile(join(root,'Device.kicad_sym'),reference)
  await writeFile(join(root,'power.kicad_sym'),reference)
  const output=join(root,'candidate'),report=join(root,'report.json')
  const run=spawnSync(process.execPath,[join(skill,'scripts','run-design.mjs'),join(skill,'assets','modular-design','design.mjs'),output,report,
   '--plan',testDesignPlan.path,'--plan-sha256',testDesignPlan.sha256],
   {encoding:'utf8',windowsHide:true,env:{...process.env,KICAD_SYMBOL_DIR:root}})
  assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`)
  const envelope=JSON.parse(run.stdout)
  assert.equal(envelope.summaryStatus,'ready')
  assert.equal(envelope.summary.frames,2)
  assert.equal(envelope.summary.powerLayout.checkedCount,2)
  const saved=JSON.parse(JSON.parse(await readFile(report,'utf8')).stdout)
  assert.equal(saved.powerPlan.stage,'automatic')
  assert.equal(saved.powerLayout.stage,'final')
  assert.ok(!saved.powerLayout.issues.some((issue:{code:string})=>issue.code==='POWER_LAYOUT_OUTSIDE_FRAME'))
 }finally{await rm(root,{recursive:true,force:true})}
})
