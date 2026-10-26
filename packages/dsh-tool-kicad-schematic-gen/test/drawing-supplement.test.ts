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

test('supplementary drawing examples generate on-grid circuits with distinct intended branches',()=>{
 const root=join(mkdtempSync(join(tmpdir(),'drawing-pattern-test-')),'examples')
 const script=fileURLToPath(new URL('../skills/kicad-schematic-design/assets/drawing-patterns/generate-supplement.mjs',import.meta.url))
 const run=spawnSync(process.execPath,[script,root],{encoding:'utf8'})
 assert.equal(run.status,0,run.stderr)
 const ids=['ldo-three-pin','reset-rc','i2c-pullups','crystal-load']
 assert.equal(run.stdout.trim().split('\n').length,ids.length)
 const objects=Object.fromEntries(ids.map(id=>{
  const source=readFileSync(join(root,id,`${id}.kicad_sch`),'utf8')
  assertSchematicGrid(source)
  return [id,listFlatObjects(source)]
 }))
 const contacts=(id:string,ref:string,pin:string)=>{
  const connected=inspectPinConnections(objects[id]!,ref,pin)
  return {pins:new Set(connected.objects.flatMap(o=>(o.pins??[]).map(p=>`${o.reference}.${p.number}`))),names:connected.netNames}
 }
 // Actual KiCad AMS1117 pins: 3=VIN, 2=VOUT, 1=GND (the old synthetic fixture used different numbers).
 const vin=contacts('ldo-three-pin','U1','3'),vout=contacts('ldo-three-pin','U1','2')
 assert.ok(vin.pins.has('C1.1'));assert.ok(!vin.pins.has('U1.2'));assert.ok(!vin.pins.has('C1.2'))
 assert.ok(vout.pins.has('C3.1'));assert.ok(!vout.pins.has('U1.1'))
 const reset=contacts('reset-rc','R1','2')
 assert.ok(reset.pins.has('SW1.1'));assert.ok(reset.pins.has('C1.1'));assert.ok(!reset.pins.has('C1.2'));assert.deepEqual(reset.names,['RESET_N'])
 const sda=contacts('i2c-pullups','R1','2'),scl=contacts('i2c-pullups','R2','2')
 assert.deepEqual(sda.names,['SDA']);assert.deepEqual(scl.names,['SCL']);assert.ok(!sda.pins.has('R2.2'))
 assert.ok(contacts('i2c-pullups','R1','1').pins.has('R2.1'))
 const left=contacts('crystal-load','Y1','1'),right=contacts('crystal-load','Y1','2')
 assert.ok(left.pins.has('C1.1'));assert.ok(!left.pins.has('Y1.2'));assert.deepEqual(left.names,['OSC_IN'])
 assert.ok(right.pins.has('C2.1'));assert.deepEqual(right.names,['OSC_OUT'])
 // Re-running maintenance must not overwrite already generated references.
 const repeat=spawnSync(process.execPath,[script,root],{encoding:'utf8'})
 assert.notEqual(repeat.status,0);assert.match(repeat.stderr,/unused output root/)
})
