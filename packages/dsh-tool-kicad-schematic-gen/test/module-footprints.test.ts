import {testDesignPlan} from './design-plan-fixture.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {Schematic} from '../src/schematic/builder.ts'
import {registerSchematicTools} from '../src/schematic/tools.ts'
import {resolveConfig} from '../src/config.ts'
import {moduleFootprintIndex,planModuleFootprints} from '../src/schematic/module-footprint-plan.ts'
import {createHash} from 'node:crypto'
import {footprintRequirements,auditFootprints} from '../src/schematic/footprint-links.ts'
import {downloadIntoWorkspace} from '../src/modules/download-core/save.ts'
import {zipSync,strToU8} from 'fflate'

const symbol=`(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor)
 (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
 (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54)
 (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`;
const footprint=`(footprint "Demo_Package" (version 20240108) (layer "F.Cu")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`;
const templateDir=fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url));
function builder(){return new Schematic({designPlan:testDesignPlan,projectName:'demo',title:'demo',paper:'A4',templateDir})}
async function fixture(fn:(x:any)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'module-footprints-')),ctx=new Context();
 try{
  await ctx.plugin(LocalFileSystem,{cwd:root});const library=join(root,'Demo.kicad_sym');await writeFile(library,symbol);
  const sch=builder();sch.addSymbol({libraryPath:library,libId:'Old:Demo',reference:'U1',at:[30,30],footprint:'Vendor:Demo_Package'});sch.wire([30,30],[35,30]);
  sch.hierarchicalLabel('IN',[35,30]);
  const source=sch.save(join(root,'source')).schematicPath,project=join(root,'project');await mkdir(project);
  const local=join(root,'archive.kicad_mod');await writeFile(local,footprint);
  await fn({root,ctx,source,project,local,library});
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})}
}

const downloadConfig={apiBaseUrl:'https://www.eda.cn',requestTimeoutMs:1000,maxDetailBytes:10000,maxZipBytes:100000,maxSchematicBytes:10000,maxProjectBytes:10000,maxArchiveEntries:20}

async function downloadModule(ctx:any, root:string, source:string, id:string, assets:Record<string,string>){
 const archive=zipSync({'demo.kicad_sch':strToU8(source),...Object.fromEntries(Object.entries(assets).map(([path,text])=>[path,strToU8(text)]))})
 const fetcher=(async(url:any)=>String(url).includes('/detail')
  ? Response.json({result:{id,name:id,file_zip:'/demo.zip'}})
  : new Response(archive)) as typeof fetch
 return downloadIntoWorkspace(id,root,root,downloadConfig,ctx.fs,undefined,new AbortController().signal,fetcher)
}

test('downloaded footprints bind automatically across two flat modules and deduplicate in the saved project',async()=>fixture(async({ctx,root,source,project})=>{
 const before=await readFile(source,'utf8')
 const first=await downloadModule(ctx,root,before,'one',{'Vendor.pretty/Demo_Package.kicad_mod':footprint})
 const second=await downloadModule(ctx,root,before,'two',{'Vendor.pretty/Demo_Package.kicad_mod':footprint})
 await writeFile(join(project,'fp-lib-table'),'(fp_lib_table (version 7) (lib (name "Existing")(type "KiCad")(uri "${KIPRJMOD}/Existing.pretty")))\n')
 const sch=builder()
 sch.importModule({sourcePath:first.schematicPath,name:'one',offset:[0,0],nets:{}})
 sch.importModule({sourcePath:second.schematicPath,name:'two',offset:[38.1,0],nets:{}})
 const result=await readFile(sch.save(project).schematicPath,'utf8')
 const parts=footprintRequirements(result)
 assert.equal(parts.length,2)
 assert.notEqual(parts[0]!.reference,parts[1]!.reference)
 assert.equal(parts[0]!.footprintId,parts[1]!.footprintId)
 assert.equal((await auditFootprints(result,project,ctx.fs,new AbortController().signal)).resolved,2)
 assert.equal((await readdir(join(project,'libraries','footprints'))).length,1)
 assert.match(await readFile(join(project,'fp-lib-table'),'utf8'),/Existing/)
 assert.equal(await readFile(first.schematicPath,'utf8'),before)
}));

test('missing, ambiguous and incompatible packaged footprints fail before writing a project',async()=>fixture(async({ctx,root,source,project})=>{
 const before=await readFile(source,'utf8')
 const missing=await downloadModule(ctx,root,before,'missing',{})
 const sch=builder()
 assert.throws(()=>sch.importModule({sourcePath:missing.schematicPath,name:'core',offset:[0,0],nets:{}}),/MODULE_FOOTPRINTS_UNAVAILABLE.*U1/)
 assert.throws(()=>planModuleFootprints(before,[
  {path:'first.kicad_mod',raw:footprint},
  {path:'second.kicad_mod',raw:footprint.replace('(size 1 1)','(size 2 2)')},
 ]),/ambiguous/)
 assert.throws(()=>planModuleFootprints(before,[{path:'bad.kicad_mod',raw:footprint.replace('(pad "1"','(pad "2"')}]),/PIN_PAD_MISMATCH/)
 assert.deepEqual(await readdir(project),[])
}));

test('existing footprintMappingPath still applies and rejects a stale source',async()=>fixture(async({root,source})=>{
 const before=await readFile(source,'utf8'),mapping=join(root,'legacy.json')
 await writeFile(mapping,JSON.stringify({version:1,sourceHash:createHash('sha256').update(before).digest('hex'),mappings:{U1:'Legacy:Demo'}}))
 const spec={sourcePath:source,name:'core',offset:[0,0] as [number,number],nets:{},footprintMappingPath:mapping}
 const sch=builder()
 sch.importModule(spec)
 assert.equal(footprintRequirements(sch.render().schematic)[0]!.footprintId,'Legacy:Demo')
 await writeFile(source,before+'\n')
 assert.throws(()=>builder().importModule(spec),/does not match/)
}));

test('hierarchy uses root page capacity and publishes packaged footprints for twelve child sheets',async()=>fixture(async({ctx,root,source,project})=>{
 const downloaded=await downloadModule(ctx,root,await readFile(source,'utf8'),'child',{'Vendor.pretty/Demo_Package.kicad_mod':footprint})
 const plan=join(root,'plan.md')
 await writeFile(plan,await readFile(testDesignPlan.path))
 const tools=new Map<string,any>()
 const fs={resolve:ctx.fs.resolve.bind(ctx.fs),contains:ctx.fs.contains.bind(ctx.fs),stat:ctx.fs.stat.bind(ctx.fs),
  readText:ctx.fs.readText.bind(ctx.fs),writeText:ctx.fs.writeText.bind(ctx.fs),readBytes:(target:{displayPath:string})=>readFile(target.displayPath)}
 registerSchematicTools({fs,effect:(fn:()=>unknown)=>fn(),tools:{register:(tool:any)=>tools.set(tool.name,tool)}} as never,resolveConfig().schematic)
 const signal=new AbortController().signal
 const hierarchy=tools.get('create_kicad_hierarchy')
 const args={projectName:'parent',title:'parent',targetDir:project,designPlan:{path:plan,sha256:testDesignPlan.sha256}}
 const exec={agent:{session:{header:{cwd:root}}},signal}
 const childSheets=(count:number)=>Array.from({length:count},(_,index)=>({
  name:`child_${index+1}`,sourcePath:downloaded.schematicPath,connections:[{port:'IN',net:'INPUT'}],
 }))
 await assert.rejects(hierarchy.execute({...args,sheets:[]},exec),/at least one module/)
 await assert.rejects(hierarchy.execute({...args,sheets:26},exec),/at least one module/)
 await assert.rejects(hierarchy.execute({...args,sheets:childSheets(26)},exec),/exceeds the A0 root page height/)
 assert.deepEqual(await readdir(project),[])
 const result=await hierarchy.execute({...args,sheets:childSheets(12)},exec)
 assert.equal(result.sheets.length,12)
 assert.match(await readFile(result.rootPath,'utf8'),/\(paper "A1"\)/)
 for(const sheet of result.sheets){
  assert.equal((await auditFootprints(await readFile(sheet.schematicPath,'utf8'),project,ctx.fs,signal)).resolved,1)
 }
}));

test('module ZIP retains bounded footprint assets and rejects traversal paths before saving',async()=>fixture(async({ctx,root})=>{
 const config={apiBaseUrl:'https://www.eda.cn',requestTimeoutMs:1000,maxDetailBytes:10000,maxZipBytes:100000,maxSchematicBytes:10000,maxProjectBytes:10000,maxArchiveEntries:20};
 const make=(entry:string)=>{const zip=zipSync({'demo.kicad_sch':strToU8('(kicad_sch (version 20250114))'),[entry]:strToU8(footprint)});return (async(url:any)=>String(url).includes('/detail')?Response.json({result:{id:'demo',name:'demo',file_zip:'/demo.zip'}}):new Response(zip)) as typeof fetch};
 const out=join(root,'downloads');await mkdir(out);
 const first=await downloadIntoWorkspace('demo',out,root,config,ctx.fs,undefined,new AbortController().signal,make('parts.pretty/Demo.kicad_mod'));
 assert.match(await readFile(moduleFootprintIndex(first.schematicPath),'utf8'),/parts.pretty/);
 assert.equal(first.footprints.length,1);assert.equal(await readFile(first.footprints[0]!.footprintPath,'utf8'),footprint);
 await assert.rejects(downloadIntoWorkspace('demo',out,root,config,ctx.fs,undefined,new AbortController().signal,make('../escape.kicad_mod')),/Unsafe/);
}));
