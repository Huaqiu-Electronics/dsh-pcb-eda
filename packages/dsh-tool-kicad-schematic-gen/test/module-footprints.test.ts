import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {Schematic} from '../src/schematic/builder.ts'
import {localizeFootprints,inspectModuleFootprints} from '../src/components/module-footprints.ts'
import {footprintRequirements,auditFootprints,assignFootprintText} from '../src/schematic/footprint-links.ts'
import {downloadIntoWorkspace} from '../src/modules/download-core/save.ts'
import {zipSync,strToU8} from 'fflate'

const symbol=`(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor)
 (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
 (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54)
 (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`;
const footprint=`(footprint "Demo_Package" (version 20240108) (layer "F.Cu")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`;
const options={requestTimeoutMs:1000,maxModelBytes:10000};
const templateDir=fileURLToPath(new URL('../skills/kicad-schematic-design/templates',import.meta.url));
function builder(){return new Schematic({projectName:'demo',title:'demo',paper:'A4',templateDir})}
async function fixture(fn:(x:any)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'module-footprints-')),ctx=new Context();
 try{
  await ctx.plugin(LocalFileSystem,{cwd:root});const library=join(root,'Demo.kicad_sym');await writeFile(library,symbol);
  const sch=builder();sch.addSymbol({libraryPath:library,libId:'Old:Demo',reference:'U1',at:[30,30],footprint:'kicad_api_lib:Demo'});sch.wire([30,30],[35,30]);
  const source=sch.save(join(root,'source')).schematicPath,project=join(root,'project');await mkdir(project);
  const local=join(root,'archive.kicad_mod');await writeFile(local,footprint);
  await fn({root,ctx,source,project,local,library});
 }finally{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})}
}

test('archive footprints localize once and survive module renumbering and repeated rebuilds',async()=>fixture(async({ctx,root,source,project,local,library})=>{
 const before=await readFile(source,'utf8');assert.equal(footprintRequirements(before)[0]!.footprintId,'kicad_api_lib:Demo');
 const input={schematicPath:source,projectDir:project,assignments:[{references:['U1'],footprintPath:local}]};
 const first=await localizeFootprints(input,root,options,ctx.fs,undefined,new AbortController().signal);
 assert.equal(first.validation.status,'ready');assert.equal(await readFile(source,'utf8'),before);
 assert.equal(first.stage,'prepared');assert.equal(first.sourceUpdated,false);
 const prepared=await inspectModuleFootprints(source,project,root,ctx.fs,new AbortController().signal,true);
 assert.equal(prepared.status,'ready');assert.equal(prepared.validationScope,'source_with_mapping_applied');
 assert.equal((await inspectModuleFootprints(source,project,root,ctx.fs,new AbortController().signal)).status,'unresolved');
 assert.ok(first.mappingPath.includes(join('libraries','mappings')));
 const patched=assignFootprintText(before,first.mappings);assert.ok(patched.includes('(wire'));assert.equal((await auditFootprints(patched,project,ctx.fs,new AbortController().signal)).resolved,1);
 assert.equal((await auditFootprints(before,project,ctx.fs,new AbortController().signal)).status,'unresolved');
 const second=await localizeFootprints(input,root,options,ctx.fs,undefined,new AbortController().signal);assert.deepEqual(second.mappings,first.mappings);
 assert.equal((await readdir(join(project,'libraries','footprints'))).length,1);
 for(let i=0;i<2;i++){
  const target=builder();target.addSymbol({libraryPath:library,libId:'Existing:Demo',reference:'U1',at:[60,30]});
  const imported=target.importModule({sourcePath:source,name:'core',offset:[0,0],nets:{},footprintMappingPath:first.mappingPath});
  const parts=footprintRequirements(target.render().schematic);
  assert.equal(parts.find(p=>p.reference===imported.references.U1)!.footprintId,first.mappings.U1);
 }
 await writeFile(source,before+'\n');assert.throws(()=>builder().importModule({sourcePath:source,name:'stale',offset:[0,0],nets:{},footprintMappingPath:first.mappingPath}),/does not match/);
}));

test('vendor symbol cache aliases use the same normalization as module import',async()=>fixture(async({ctx,root,source,project,local})=>{
 const before=await readFile(source,'utf8');
 // Vendor modules sometimes retain a suffixed cache key, while instances keep lib:name.
 const vendor=before.replace('(symbol "Old:Demo"','(symbol "Old:Demo_2"').replaceAll('"Demo_1_1"','"Demo_2_1_1"');
 await writeFile(source,vendor);
 assert.equal(footprintRequirements(vendor)[0]!.pinNumbers[0],'1');
 await localizeFootprints({schematicPath:source,projectDir:project,assignments:[{references:['U1'],footprintPath:local}]},root,options,ctx.fs,undefined,new AbortController().signal);
 assert.equal(await readFile(source,'utf8'),vendor);
}));

test('concurrent module imports preserve all project library registrations',async()=>fixture(async({ctx,root,source,project})=>{
 const source2=join(root,'second.kicad_sch');await writeFile(source2,(await readFile(source,'utf8'))+'\n');
 const fetcher=(async(url:any,init:any)=>String(url).endsWith('.kicad_mod')?new Response(footprint):Response.json({code:200000,result:{mpn:JSON.parse(init.body).mpn,cadUrlList:[{type:'footprint',fileUrl:'https://example.test/Demo.kicad_mod'}]}})) as typeof fetch;
 await Promise.all([source,source2].map((path,i)=>localizeFootprints({schematicPath:path,projectDir:project,assignments:[{references:['U1'],manufacturer_id:'7189',mpn:`Demo${i}`}]},root,options,ctx.fs,undefined,new AbortController().signal,fetcher)));
 assert.equal((await readFile(join(project,'fp-lib-table'),'utf8')).match(/\(lib /g)?.length,2);
}));

test('exact online footprint download is cached and never replaces the module symbol',async()=>fixture(async({ctx,root,source,project})=>{
 let requests=0;const fetcher=(async(url:any)=>{requests++;return String(url).endsWith('.kicad_mod')?new Response(footprint):Response.json({code:200000,result:{mpn:'Demo',cadUrlList:[{type:'footprint',fileUrl:'https://example.test/Demo.kicad_mod'}]}})}) as typeof fetch;
 const input={schematicPath:source,projectDir:project,assignments:[{references:['U1'],manufacturer_id:'7189',mpn:'Demo'}]};
 await localizeFootprints(input,root,options,ctx.fs,undefined,new AbortController().signal,fetcher);assert.equal(requests,2);
 await localizeFootprints(input,root,options,ctx.fs,undefined,new AbortController().signal,fetcher);assert.equal(requests,2);
 assert.equal((await readdir(project)).some(n=>n.endsWith('.kicad_sym')),false);
}));

test('pin mismatch writes no libraries; extra numbered pads require explicit explanation',async()=>fixture(async({ctx,root,source,project,local})=>{
 await assert.rejects(localizeFootprints({schematicPath:source,projectDir:project,targetPath:join(root,'..','outside.kicad_sch'),assignments:[{references:['U1'],footprintPath:local}]},root,options,ctx.fs,undefined,new AbortController().signal),/workspace/);
 assert.deepEqual(await readdir(project),[]);
 await writeFile(local,footprint.replace('(pad "1"','(pad "2"'));
 const input={schematicPath:source,projectDir:project,assignments:[{references:['U1'],footprintPath:local}]};
 await assert.rejects(localizeFootprints(input,root,options,ctx.fs,undefined,new AbortController().signal),/PIN_PAD_MISMATCH/);
 assert.deepEqual(await readdir(project),[]);
 await writeFile(local,footprint.replace(/\)$/, '(pad "2" np_thru_hole circle (at 2 2) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask")))'));
 await assert.rejects(localizeFootprints({...input,assignments:[{...input.assignments[0]!,allowedExtraPads:['2']}]},root,options,ctx.fs,undefined,new AbortController().signal),/explanation/);
 assert.deepEqual(await readdir(project),[]);
}));

test('module ZIP retains bounded footprint assets and rejects traversal paths before saving',async()=>fixture(async({ctx,root})=>{
 const config={apiBaseUrl:'https://www.eda.cn',requestTimeoutMs:1000,maxDetailBytes:10000,maxZipBytes:100000,maxSchematicBytes:10000,maxProjectBytes:10000,maxArchiveEntries:20};
 const make=(entry:string)=>{const zip=zipSync({'demo.kicad_sch':strToU8('(kicad_sch (version 20250114))'),[entry]:strToU8(footprint)});return (async(url:any)=>String(url).includes('/detail')?Response.json({result:{id:'demo',name:'demo',file_zip:'/demo.zip'}}):new Response(zip)) as typeof fetch};
 const out=join(root,'downloads');await mkdir(out);
 const first=await downloadIntoWorkspace('demo',out,root,config,ctx.fs,undefined,new AbortController().signal,make('parts.pretty/Demo.kicad_mod'));
 assert.equal(first.footprints.length,1);assert.equal(await readFile(first.footprints[0]!.footprintPath,'utf8'),footprint);
 await assert.rejects(downloadIntoWorkspace('demo',out,root,config,ctx.fs,undefined,new AbortController().signal,make('../escape.kicad_mod')),/Unsafe/);
}));
