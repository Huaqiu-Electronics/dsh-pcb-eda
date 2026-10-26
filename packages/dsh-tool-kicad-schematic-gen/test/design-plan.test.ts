import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,writeFileSync,existsSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {readDesignPlan,loadDesignPlan} from '../src/schematic/design-plan.ts'
import {Schematic} from '../src/schematic/builder.ts'
import {readWorkspaceDesignPlan} from '../src/schematic/tools.ts'
import {apply} from '../src/schematic/index.ts'
import {planText,testDesignPlan} from './design-plan-fixture.ts'

const templateDir=fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url))
const runner=fileURLToPath(new URL('../skills/kicad-schematic-design/scripts/run-design.mjs',import.meta.url))
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'design-plan-')),path=join(root,'project-brief.md')
 writeFileSync(path,planText)
 const {sha256}=readDesignPlan(path)
 return {root,path,sha256}
}

test('missing, empty, placeholder-only and changed plans block generation before output',()=>{
 const {root,path,sha256}=fixture(),options={projectName:'demo',title:'demo',paper:'A4' as const,templateDir}
 const env={...process.env};delete process.env.DSH_DESIGN_BRIEF_PATH;delete process.env.DSH_DESIGN_BRIEF_SHA256
 try{
  assert.throws(()=>new Schematic(options),/DESIGN_PLAN_REQUIRED/)
  assert.throws(()=>loadDesignPlan({path:join(root,'missing.md'),sha256}),/DESIGN_PLAN_UNAVAILABLE/)
  for(const text of ['','# Plan\n\n## TODO\n']){
   writeFileSync(path,text);assert.throws(()=>loadDesignPlan({path,sha256}),/DESIGN_PLAN_INCOMPLETE/)
  }
  writeFileSync(path,planText)
  const sch=new Schematic({...options,designPlan:{path,sha256}})
  writeFileSync(path,planText+'\nChanged load to 500 mA.\n')
  assert.throws(()=>sch.save(join(root,'candidate')),/DESIGN_PLAN_CHANGED/)
  assert.equal(existsSync(join(root,'candidate')),false)
 }finally{
  for(const key of ['DSH_DESIGN_BRIEF_PATH','DSH_DESIGN_BRIEF_SHA256'])if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key]
 }
})

test('runner reads the saved plan, refuses to start without its version, and records the exact input',()=>{
 const {root,path,sha256}=fixture(),script=join(root,'design.mjs'),marker=join(root,'started'),report=join(root,'report.json')
 writeFileSync(script,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');console.log(JSON.stringify({plan:process.env.DSH_DESIGN_BRIEF_SHA256}));`)
 const run=(args:string[])=>spawnSync(process.execPath,[runner,...args],{encoding:'utf8'})
 const read=run(['--read-plan',path]);assert.equal(read.status,0,read.stderr)
 assert.equal(JSON.parse(read.stdout).content,planText)
 const args=[script,join(root,'candidate'),report]
 const missing=run(args);assert.notEqual(missing.status,0);assert.match(missing.stderr,/DESIGN_PLAN_REQUIRED/);assert.equal(existsSync(marker),false)
 const stale=run([...args,'--plan',path,'--plan-sha256','0'.repeat(64)])
 assert.notEqual(stale.status,0);assert.match(stale.stderr,/DESIGN_PLAN_CHANGED/);assert.equal(existsSync(marker),false)
 const valid=run([...args,'--plan',path,'--plan-sha256',sha256]);assert.equal(valid.status,0,valid.stderr)
 const data=JSON.parse(readFileSync(report,'utf8'))
 assert.equal(data.designPlan.sha256,sha256);assert.equal(data.designPlan.content,planText);assert.match(data.scriptSha256,/^[a-f0-9]{64}$/)
 assert.equal(JSON.parse(data.stdout).plan,sha256)
})

test('workspace plan validation uses canonical containment and rejects stale versions',async()=>{
 const {root,path,sha256}=fixture(),signal=new AbortController().signal
 const fs={resolve:async(p:string,options?:{cwd?:string})=>({displayPath:resolve(options?.cwd??root,p)}),
  contains:(a:{displayPath:string},b:{displayPath:string})=>{const rel=relative(a.displayPath,b.displayPath);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel))},
  stat:async()=>({type:'file'}),readBytes:async()=>Buffer.from(planText)}
 assert.equal((await readWorkspaceDesignPlan(fs as never,root,{path,sha256},signal)).sha256,sha256)
 await assert.rejects(readWorkspaceDesignPlan(fs as never,root,{path:join(root,'..','outside.md'),sha256},signal),/DESIGN_PLAN_UNAVAILABLE/)
 await assert.rejects(readWorkspaceDesignPlan(fs as never,root,{path,sha256:'0'.repeat(64)},signal),/DESIGN_PLAN_CHANGED/)
})

test('both tool generation routes reject missing plans and preserve read-only tool access',async()=>{
 const tools=new Map<string,any>();let fsCalls=0
 apply({effect:(fn:()=>unknown)=>fn(),tools:{register:(tool:any)=>tools.set(tool.name,tool)},fs:new Proxy({},{get(){fsCalls++;throw new Error('unexpected filesystem access')}})} as never,
  {flatTemplateDir:templateDir,flatListLimit:120,maxSchematicBytes:1000000,kicadCliPath:'kicad-cli',previewDensity:288,previewMaxWidth:2400,previewMaxPages:4,previewPadding:32,previewTimeoutMs:30000,previewTrimThreshold:10})
 const exec={agent:{session:{header:{cwd:resolve('.')}}},signal:new AbortController().signal}
 await assert.rejects(tools.get('create_kicad_hierarchy').execute({projectName:'demo',title:'demo',targetDir:'.',sheets:[{}]},exec),/DESIGN_PLAN_REQUIRED/)
 await assert.rejects(tools.get('edit_kicad_flat_schematic').execute({action:'create',sourcePath:'source.kicad_sch',targetDir:'.',projectName:'demo'},exec),/DESIGN_PLAN_REQUIRED/)
 assert.equal(fsCalls,0)
 const schema=tools.get('create_kicad_hierarchy').parameters
 assert.ok(schema.required.includes('designPlan'))
 assert.deepEqual(tools.get('edit_kicad_flat_schematic').parameters.required,['action','sourcePath'])
 assert.equal(loadDesignPlan(testDesignPlan).sha256,testDesignPlan.sha256)
})
