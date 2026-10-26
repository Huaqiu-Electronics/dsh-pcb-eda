import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Schematic} from '../src/schematic/builder.ts'
import {gridPoint,snapGrid,onGrid} from '../src/schematic/grid.ts'
import {assertSchematicGrid} from '../src/schematic/grid-check.ts'
import {listFlatObjects} from '../src/schematic/flat.ts'
import {testDesignPlan} from './design-plan-fixture.ts'

const templateDir=fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url))
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'grid-50mil-')),library=join(root,'grid.kicad_sym')
 writeFileSync(library,`(kicad_symbol_lib (version 20211014) (generator test)
 (symbol "Pair" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
 (property "Value" "Pair" (at 0 0 0) (effects (font (size 1.27 1.27))))
 (symbol "Pair_1_1"
 (pin passive line (at -2.54 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
 (pin passive line (at 2.54 0 180) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`)
 const build=()=>new Schematic({designPlan:testDesignPlan,projectName:'grid',title:'Grid',paper:'A4',templateDir})
 return {root,library,build}
}

test('50 mil default snaps decimal, integer, negative and region coordinates, preserving exact wire-pin contacts',()=>{
 assert.deepEqual(gridPoint([50,-50]),[49.53,-49.53])
 assert.equal(snapGrid(1.27+1e-10),1.27)
 const {root,library,build}=fixture(),sch=build()
 const region=sch.region({name:'core',description:'grid',origin:[30,30],size:[100,60]})
 region.addSymbol({libraryPath:library,libId:'Grid:Pair',reference:'U1',at:[20,20]})
 region.addSymbol({libraryPath:library,libId:'Grid:Pair',reference:'U2',at:[60,20]})
 region.wire({reference:'U1',pin:'2'},{reference:'U2',pin:'1'})
 region.label('NET',{reference:'U1',pin:'2'})
 region.marker('junction',{reference:'U1',pin:'2'})
 region.marker('no_connect',{reference:'U1',pin:'1'})
 const result=sch.save(join(root,'candidate')),source=readFileSync(result.schematicPath,'utf8')
 assertSchematicGrid(source)
 const objects=listFlatObjects(source),wire=objects.find(o=>o.type==='wire')!
 assert.deepEqual(wire.from,sch.pin('U1','2'));assert.deepEqual(wire.to,sch.pin('U2','1'))
 assert.ok(objects.filter(o=>o.type==='symbol').every(o=>o.at!.every(onGrid)&&o.pins!.every(p=>p.at.every(onGrid))))
 assert.equal(JSON.parse(readFileSync(result.projectPath,'utf8')).schematic.connection_grid_size,50)
})

test('rotation and mirror retain on-grid pins; incompatible library pin geometry fails before placement',()=>{
 const {library,build}=fixture()
 for(const angle of [0,90,180,270] as const)for(const mirror of ['x','y'] as const){
  const sch=build();sch.addSymbol({libraryPath:library,libId:'Grid:Pair',reference:'U1',at:[103,203],angle,mirror})
  assertSchematicGrid(sch.render().schematic)
 }
 writeFileSync(library,readFileSync(library,'utf8').replace('(at -2.54 0 0)','(at -1 0 0)'))
 assert.throws(()=>build().addSymbol({libraryPath:library,libId:'Grid:Pair',reference:'U1',at:[50,50]}),/SYMBOL_PIN_OFF_GRID/)
})

test('off-grid imported circuits are rejected without silently rounding wires or pins; translation is snapped as a group',()=>{
 const {root,library,build}=fixture(),original=build()
 original.addSymbol({libraryPath:library,libId:'Grid:Pair',reference:'U1',at:[50,50]})
 original.label('OUT',{reference:'U1',pin:'2'})
 const source=original.save(join(root,'source')).schematicPath
 const sch=build();sch.importModule({sourcePath:source,name:'core',offset:[10,20],nets:{OUT:'OUT'}})
 assertSchematicGrid(sch.render().schematic)
 assert.deepEqual(sch.pin('U1','2'),[62.23,69.85])
 const bad=readFileSync(source,'utf8').replace('(at 49.53 49.53 0)','(at 50 50 0)')
 writeFileSync(source,bad)
 assert.throws(()=>build().importModule({sourcePath:source,name:'bad',offset:[10,20],nets:{}}),/SCHEMATIC_OFF_GRID/)
 assert.equal(readFileSync(source,'utf8'),bad)
})

test('off-grid wire, bus, labels, junctions, sheet pins and NC markers cannot pass publication checks',()=>{
 const {library,build}=fixture(),sch=build()
 sch.addSymbol({libraryPath:library,libId:'Grid:Pair',reference:'U1',at:[50,50]})
 const valid=sch.render().schematic
 const fixtures=[
  '(wire (pts (xy 1 0) (xy 2.54 0)) (stroke (width 0) (type default)) (uuid "bad"))',
  '(bus (pts (xy 0 0) (xy 1 0)))',
  '(label "BAD" (at 1 0 0) (uuid "bad"))',
  '(junction (at 0 1) (uuid "bad"))',
  '(no_connect (at 1 0) (uuid "bad"))',
  '(sheet (at 0 0) (pin "P" passive (at 1 0 0)))',
 ]
 for(const form of fixtures)assert.throws(()=>assertSchematicGrid(valid.trim().slice(0,-1)+form+')'),/SCHEMATIC_OFF_GRID/)
 const {root}=fixture()
 assert.throws(()=>sch.wire([0,0],[0.1,0]),/collapses/)
 assert.equal(existsSync(join(root,'candidate')),false)
})
