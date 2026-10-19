import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {prepareBatch,downloadFootprint} from '../src/components/footprint-download.ts'
import {summarizeFootprint} from '../src/components/models.ts'
import {Schematic} from '../src/schematic/builder.ts'
import {attachPinLabel} from '../src/schematic/label-leads.ts'

const legacy='(module "SOD-123" (layer F.Cu) (tedit 0) (fp_line (start -1 0) (end 1 0) (layer F.SilkS) (width 0.15)) (pad "1" smd rect (at -1 0) (size 1 1) (layers F.Cu F.Mask)) (pad "2" smd rect (at 1 0) (size 1 1) (layers F.Cu F.Mask)))'
test('legacy module footprint pads are read without rewriting geometry',()=>{
 assert.deepEqual(summarizeFootprint(legacy),{status:'parsed',name:'SOD-123',padCount:2,pads:[{number:'1',type:'smd'},{number:'2',type:'smd'}]})
 assert.throws(()=>summarizeFootprint(legacy.slice(0,-1)),/unbalanced/)
})
test('preparation bounds concurrent work, settles failures, and preserves input order',async()=>{
 let active=0,max=0,finished=0
 await assert.rejects(prepareBatch([0,1,2,3,4,5],async n=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;finished++;if(n===2)throw new Error('invalid model');return n}),/FOOTPRINT_BATCH_FAILED/)
 assert.equal(max,4);assert.equal(active,0);assert.equal(finished,6)
 assert.deepEqual(await prepareBatch([3,2,1],async n=>n*2),[6,4,2])
})
test('successful downloads survive another item failing, with bounded cache and no failure caching',async()=>{
 let gets=0
 const fetcher=(async(url:any,init:any)=>{
  gets++;if(String(url).endsWith('.kicad_mod'))return new Response(legacy)
  const mpn=JSON.parse(init.body).mpn;if(mpn==='bad')throw new Error('network')
  return Response.json({code:200000,result:{mpn,cadUrlList:[{type:'footprint',fileUrl:'https://example.test/model.kicad_mod'}]}})
 }) as typeof fetch
 const signal=new AbortController().signal,options={requestTimeoutMs:1000,maxModelBytes:10000}
 await assert.rejects(prepareBatch(['good','bad'],mpn=>downloadFootprint('7189',mpn,options,signal,fetcher)),/network/)
 const after=gets;await downloadFootprint('7189','good',options,signal,fetcher);assert.equal(gets,after)
 await assert.rejects(downloadFootprint('7189','bad',options,signal,fetcher));assert.equal(gets,after+1)
 await assert.rejects(downloadFootprint('7189','good',{...options,maxModelBytes:10},signal,fetcher),/exceeds/)
})
test('script launcher preserves Unicode UTF-8 reports, stderr and nonzero exit without shell parsing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'design runner '))
 try{
  const script=join(root,'test design.mjs'),report=join(root,'report.json')
  await writeFile(script,"console.log(JSON.stringify({title:'电源',output:process.argv[2]}));console.error('诊断');process.exitCode=3",'utf8')
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../skills/kicad-schematic-design/scripts/run-design.mjs',import.meta.url)),script,join(root,'candidate'),report],{encoding:'utf8'})
  assert.equal(run.status,3);const data=JSON.parse(await readFile(report,'utf8'));assert.equal(data.exitCode,3);assert.equal(JSON.parse(data.stdout).title,'电源');assert.match(data.stderr,/诊断/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('label leads work in real region coordinates and reject invalid plans before mutation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'label-leads-'))
 try{
  const library=join(root,'demo.kicad_sym');await writeFile(library,'(kicad_symbol_lib (version 20211014) (generator test) (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1 1)))) (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54) (name "IN" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))')
  const sch=new Schematic({projectName:'demo',title:'demo',paper:'A4',templateDir:fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url))})
  const region=sch.region({name:'test',description:'test',origin:[30,30],size:[80,80]});region.addSymbol({libraryPath:library,libId:'Demo:Demo',reference:'U1',at:[20,20]})
  const normalize=(text:string)=>text.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,'UUID');const before=normalize(sch.render().schematic)
  assert.throws(()=>attachPinLabel(region,{reference:'U1',pin:'1',net:'NET',direction:'left',length:0}),/positive/);assert.equal(normalize(sch.render().schematic),before)
  attachPinLabel(region,{reference:'U1',pin:'1',net:'NET',direction:'left',lane:1})
  assert.match(sch.render().schematic,/\(label "NET"/);assert.equal((sch.render().schematic.match(/\(wire/g)??[]).length,2)
 }finally{await rm(root,{recursive:true,force:true})}
})
