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

const assets=new URL('../skills/kicad-schematic-design/assets/drawing-patterns/',import.meta.url)
test('system drawing examples preserve power, data, debug and inductive load branches on 50 mil grid',()=>{
 const root=join(mkdtempSync(join(tmpdir(),'system-pattern-test-')),'examples')
 const run=spawnSync(process.execPath,[fileURLToPath(new URL('generate-systems.mjs',assets)),root],{encoding:'utf8'})
 assert.equal(run.status,0,run.stderr)
 assert.equal(run.stdout.trim().split('\n').length,5)
 for(const id of ['mcu-minimum','mcu-external-crystal','usb-c-device','mosfet-low-side','swd-header']){
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
  if(id.startsWith('mcu-')){
   check('U1','16',['U1.5','C1.1','C2.1'],['U1.15','C1.2','C2.2'])
   assert.deepEqual(check('R1','2',['C3.1','U1.4'],['R1.1','C3.2','U1.1']).names,['NRST'])
   assert.deepEqual(contacts('U1','4').names,['NRST'])
   assert.deepEqual(check('R2','1',['U1.1'],['U1.4','R2.2']).names,['BOOT0'])
   assert.deepEqual(contacts('U1','1').names,['BOOT0'])
   assert.deepEqual(contacts('U1','19').names,['SWDIO'])
   assert.deepEqual(contacts('U1','20').names,['SWCLK'])
   if(id==='mcu-external-crystal'){
    assert.deepEqual(contacts('U1','2').names,['OSC_IN'])
    assert.deepEqual(check('Y1','1',['C4.1'],['U1.3','Y1.2','C5.1','C4.2','R2.1']).names,['OSC_IN'])
    assert.deepEqual(contacts('U1','3').names,['OSC_OUT'])
    assert.deepEqual(check('Y1','2',['C5.1'],['U1.2','C4.1','C5.2','R2.1']).names,['OSC_OUT'])
   }
  }else if(id==='usb-c-device'){
   assert.deepEqual(check('J1','A6',['J1.B6'],['J1.A7','J1.B7','J1.A5','J1.B5']).names,['USB_DP'])
   assert.deepEqual(check('J1','A7',['J1.B7'],['J1.A6']).names,['USB_DM'])
   assert.deepEqual(check('J1','A5',[],['J1.B5']).names,['USB_CC1'])
   assert.deepEqual(contacts('J1','B5').names,['USB_CC2'])
   assert.deepEqual(contacts('R1','1').names,['USB_CC1'])
   assert.deepEqual(contacts('R2','1').names,['USB_CC2'])
   check('J1','A4',['J1.A9','J1.B4','J1.B9'],['J1.A1'])
   check('J1','A1',['J1.A12','J1.B1','J1.B12','J1.S1'],['J1.A4'])
  }else if(id==='mosfet-low-side'){
   check('Q1','D',['J1.2','D1.2'],['J1.1','D1.1','Q1.S','Q1.G'])
   check('J1','1',['D1.1'],['D1.2'])
   check('Q1','G',['R1.2','R2.1'],['R1.1','R2.2','Q1.S'])
   check('Q1','S',['R2.2'],['Q1.D'])
   assert.deepEqual(contacts('R1','1').names,['LOAD_EN'])
  }else{
   for(const [pin,name] of [['1','VTREF_3V3'],['2','SWDIO'],['4','SWCLK'],['5','NRST']]){
    const result=contacts('J1',pin!)
    assert.deepEqual(result.names,[name])
    assert.deepEqual([...result.pins],[`J1.${pin}`])
   }
  }
 }
})

test('system drawing examples require explicit mode and pinout confirmation',async()=>{
 for(const name of ['mcu-minimum','mcu-external-crystal','usb-c-device','mosfet-low-side','swd-header']){
  const {place}=await import(new URL(`${name}.mjs`,assets).href)
  assert.throws(()=>place({at:[0,0]}),/Confirm/)
 }
})
