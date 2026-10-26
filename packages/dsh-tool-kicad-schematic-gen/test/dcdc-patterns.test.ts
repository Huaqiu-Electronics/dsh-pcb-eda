import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {listFlatObjects} from '../src/schematic/flat.ts'
import {inspectPinConnections} from '../src/schematic/connections.ts'
import {assertSchematicGrid} from '../src/schematic/grid-check.ts'

test('DC-DC examples preserve physical switch, diode, output and feedback branches on 50 mil grid',()=>{
 const root=join(mkdtempSync(join(tmpdir(),'dcdc-pattern-test-')),'examples')
 const script=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/drawing-patterns/generate-supplement.mjs',import.meta.url))
 const run=spawnSync(process.execPath,[script,root,'--dcdc'],{encoding:'utf8'})
 assert.equal(run.status,0,run.stderr)
 assert.equal(run.stdout.trim().split('\n').length,2)
 for(const id of ['dcdc-buck','dcdc-boost']){
  const source=readFileSync(join(root,id,`${id}.kicad_sch`),'utf8')
  assertSchematicGrid(source)
  const objects=listFlatObjects(source)
  const contacts=(ref:string,pin:string)=>{
   const connected=inspectPinConnections(objects,ref,pin)
   return {pins:new Set(connected.objects.flatMap(o=>(o.pins??[]).map(p=>`${o.reference}.${p.number}`))),names:connected.netNames}
  }
  const check=(ref:string,pin:string,included:string[],excluded:string[]=[])=>{
   const result=contacts(ref,pin)
   for(const other of included) assert.ok(result.pins.has(other),`${id}: ${ref}.${pin} must reach ${other}`)
   for(const other of excluded) assert.ok(!result.pins.has(other),`${id}: ${ref}.${pin} must not reach ${other}`)
   return result
  }
  if(id==='dcdc-buck'){
   check('U1','1',['C1.1'],['U1.2','C1.2'])
   check('U1','2',['L1.1','D1.1'],['L1.2','D1.2','C2.1'])
   check('L1','2',['C2.1','R1.1'],['U1.2','R1.2'])
   check('U1','3',['C1.2','C2.2','D1.2','R2.2'],['U1.1'])
   assert.deepEqual(contacts('U1','4').names,['FB_BUCK'])
   assert.deepEqual(check('R1','2',['R2.1'],['R1.1','R2.2']).names,['FB_BUCK'])
  }else{
   check('U1','5',['U1.4','C1.1','L1.1'],['U1.1','C1.2'])
   check('U1','1',['L1.2','D1.2'],['D1.1','C2.1'])
   check('D1','1',['C2.1','R1.1'],['U1.1','R1.2'])
   check('U1','2',['C1.2','C2.2','R2.2'],['U1.5'])
   assert.deepEqual(contacts('U1','3').names,['FB_BOOST'])
   assert.deepEqual(check('R1','2',['R2.1'],['R1.1','R2.2']).names,['FB_BOOST'])
  }
 }
})
