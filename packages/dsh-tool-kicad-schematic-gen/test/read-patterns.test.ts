import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile,mkdtemp,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,basename,isAbsolute,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const skill=fileURLToPath(new URL('../skills/kicad-schematic-design/',import.meta.url))
const reader=join(skill,'scripts','read-patterns.mjs')
const run=(ids:string[],cwd?:string)=>spawnSync(process.execPath,[reader,...ids],{cwd,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024})
type Resource={path:string;kind:string;content:string}

test('selected patterns return complete code and deduplicated dependencies plus explicit image-read paths',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'pattern reader '))
 try{
  const result=run(['usb-c-device','reset-rc','usb-c-device'],cwd)
  assert.equal(result.status,0,result.stderr)
  const bundle=JSON.parse(result.stdout)
  assert.equal(bundle.kind,'drawing-pattern-reference-bundle')
  assert.equal(bundle.complete,true)
  assert.deepEqual(bundle.patterns.map((p:{id:string})=>p.id),['usb-c-device','reset-rc'])
  const resources:Resource[]=bundle.resources
  assert.equal(resources.filter(r=>basename(r.path)==='geometry.mjs').length,1)
  assert.ok(resources.some(r=>basename(r.path)==='reset-enable.md'))
  assert.ok(!resources.some(r=>basename(r.path)==='mcu-minimum.mjs'))
  for(const resource of resources){
   assert.ok(isAbsolute(resource.path));assert.equal(resource.content,await readFile(resource.path,'utf8'))
  }
  assert.deepEqual(bundle.readImagesNext.map((p:string)=>basename(p)),['usb-c-device.png','reset-rc.png'])
  assert.deepEqual(await readdir(cwd),[],'read-only discovery must not create designs or caches')
 }finally{await rm(cwd,{recursive:true,force:true})}
})

test('catalog entries all resolve to code, applicability notes and actual PNGs without loading maintenance generators',async()=>{
 const list=JSON.parse(run(['--list']).stdout)
 assert.ok(list.patterns.length>0)
 assert.equal(list.resources,undefined,'listing is metadata, not a claim that resources were read')
 const result=run(list.patterns.map((p:{id:string})=>p.id))
 assert.equal(result.status,0,result.stderr)
 const bundle=JSON.parse(result.stdout)
 for(const pattern of bundle.patterns){
  assert.ok(bundle.resources.some((r:Resource)=>r.path===pattern.codePath))
  for(const path of pattern.referencePaths)assert.ok(bundle.resources.some((r:Resource)=>r.path===path))
  const png=await readFile(pattern.imagePath)
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10])
 }
 for(const resource of bundle.resources as Resource[]){
  assert.ok(!relative(skill,resource.path).startsWith('..'))
  assert.ok(!/^generate|^render\.mjs/.test(basename(resource.path)))
 }
})

test('transitive code dependencies and label orientation images are selected precisely',()=>{
 const result=run(['mcu-external-crystal','dcdc-buck','label-sides','label-vertical'])
 assert.equal(result.status,0,result.stderr)
 const bundle=JSON.parse(result.stdout),names=bundle.resources.map((r:Resource)=>basename(r.path))
 for(const name of ['mcu-minimum.mjs','geometry.mjs','dcdc-geometry.mjs','label-alignment.mjs'])
  assert.equal(names.filter((n:string)=>n===name).length,1)
 assert.ok(names.includes('mcu-minimum.md'))
 assert.ok(bundle.readImagesNext.some((p:string)=>basename(p)==='label-sides.png'))
 assert.ok(bundle.readImagesNext.some((p:string)=>basename(p)==='label-vertical.png'))
 assert.deepEqual(bundle.runtimePaths,[join(skill,'assets','runtime.mjs')])
 assert.ok(!names.includes('runtime.mjs'),'public runtime is a boundary, not a reason to read implementation bundles')
})

test('unknown IDs, paths and maintenance commands fail without returning unrelated content',()=>{
 for(const ids of [[],['../runtime'],['constructor'],['generate-systems'],['--list','usb-c-device']]){
  const result=run(ids)
  assert.equal(result.status,1)
  assert.equal(result.stdout,'')
  assert.equal(JSON.parse(result.stderr).status,'error')
 }
})
