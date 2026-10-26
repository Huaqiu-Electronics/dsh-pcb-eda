import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,copyFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {Schematic} from '../src/schematic/builder.ts'
import {registerSchematicTools,collectPreviewSources} from '../src/schematic/tools.ts'
import {renderModulePreview} from '../src/schematic/preview.ts'
import {resolveConfig} from '../src/config.ts'
import {testDesignPlan} from './design-plan-fixture.ts'

test('candidate preflight checks real library files and formal delivery reports its own outcome',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'preflight-'))),ctx=new Context()
 const previousHome=process.env.HQ_EDGE_HOME
 process.env.HQ_EDGE_HOME=join(root,'user-data')
 try{
  await ctx.plugin(LocalFileSystem,{cwd:root})
  // The npm filesystem predates the host's bounded readBytes API.
  ctx.fs.readBytes=async(target,signal,maxBytes)=>{
   const bytes=await readFile(target.displayPath)
   signal.throwIfAborted()
   if(maxBytes!==undefined&&bytes.length>maxBytes)throw new Error('Read exceeds byte limit')
   return bytes
  }
  const project=join(root,'project'),outputDir=join(root,'previews'),library=join(root,'demo.kicad_sym')
  await writeFile(library,'(kicad_symbol_lib (version 20211014) (generator test) (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1 1)))) (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54) (name "IN" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1))))))))')
  const sch=new Schematic({designPlan:testDesignPlan,projectName:'demo',title:'Demo',paper:'A4',templateDir:fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url))})
  sch.addSymbol({libraryPath:library,libId:'Parts:Demo',reference:'U1',at:[25.4,25.4],footprint:'Parts:Demo'})
  const schematicPath=await realpath(sch.save(project).schematicPath)
  const config=resolveConfig({}).schematic,signal=new AbortController().signal
  const tools=new Map<string,any>();let cardService=false
  const harness={fs:ctx.fs,effect:(fn:()=>unknown)=>fn(),get:()=>cardService?{register:()=>()=>{}}:undefined,
   tools:{register:(tool:any)=>{tools.set(tool.name,tool);return()=>{}}}}
  const exec={signal,agent:{session:{header:{cwd:root}}}}
  async function prime(path:string){
   const sources=await collectPreviewSources(ctx.fs,root,{path,text:await readFile(path,'utf8')},config.maxSchematicBytes,signal)
   const revision=createHash('sha256').update(JSON.stringify(sources)).digest('hex')
   await renderModulePreview(outputDir,path,revision,config,signal,sources,async(_file,args)=>{
    await writeFile(join(args[4]!,'demo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50"><path d="M5 5 L45 45" stroke="black" stroke-width="1"/></svg>')
    return {exitCode:0,stdout:'',stderr:'',timedOut:false}
   })
  }
  registerSchematicTools(harness as never,config)
  const preview=()=>tools.get('render_kicad_module_preview')
  await prime(schematicPath)
  // Ordinary previews without projectDir retain the inexpensive render-only path.
  const review=await preview().execute({schematicPath,outputDir,regions:[]},exec)
  assert.equal(review.renderStatus,'ok');assert.equal(review.deliveryStatus,'not_requested');assert.equal(review.footprintCheck,null)
  // Candidates may check prepared libraries outside the candidate directory.
  const candidate=join(root,'candidate');await mkdir(candidate)
  const candidatePath=join(candidate,'demo.kicad_sch');await copyFile(schematicPath,candidatePath);await prime(candidatePath)
  const missing=await preview().execute({schematicPath:candidatePath,projectDir:project,outputDir,regions:[]},exec)
  assert.equal(missing.renderStatus,'ok');assert.equal(missing.status,'error')
  assert.equal(missing.footprintCheck.status,'blocked');assert.equal(missing.footprintCheck.sheets[0].unresolved[0].reference,'U1')
  const blocked=await preview().execute({schematicPath,projectDir:project,outputDir,regions:[],delivery:true},exec)
  assert.equal(blocked.status,'error');assert.equal(blocked.deliveryStatus,'blocked');assert.equal(blocked.overview,null)
  assert.match(blocked.overviewError,/FOOTPRINTS_UNRESOLVED/);assert.equal(blocked.pages.length,1)
  const footprints=join(project,'libraries','footprints','Parts.pretty');await mkdir(footprints,{recursive:true})
  await writeFile(join(footprints,'Demo.kicad_mod'),'(footprint "Demo" (layer "F.Cu"))')
  await writeFile(join(project,'fp-lib-table'),'(fp_lib_table (lib (name "Parts") (type "KiCad") (uri "${KIPRJMOD}/libraries/footprints/Parts.pretty")))')
  const ready=await preview().execute({schematicPath:candidatePath,projectDir:project,outputDir,regions:[]},exec)
  assert.equal(ready.footprintCheck.status,'ready');assert.equal(ready.status,'ok');assert.equal(ready.cached,true)
  const unavailable=await preview().execute({schematicPath,projectDir:project,outputDir,regions:[],delivery:true},exec)
  assert.equal(unavailable.renderStatus,'ok');assert.equal(unavailable.deliveryStatus,'blocked');assert.equal(unavailable.status,'error')
  assert.match(unavailable.overviewError,/service unavailable/)
  cardService=true;tools.clear();registerSchematicTools(harness as never,config)
  const delivered=await preview().execute({schematicPath,projectDir:project,outputDir,regions:[],delivery:true},exec)
  assert.equal(delivered.deliveryStatus,'ready');assert.equal(delivered.status,'ok');assert.equal(delivered.overviewError,null)
  assert.ok(delivered.overview.downloadUrl.endsWith('/project.zip'))
 }finally{
  if(previousHome===undefined)delete process.env.HQ_EDGE_HOME;else process.env.HQ_EDGE_HOME=previousHome
  await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})
 }
})
