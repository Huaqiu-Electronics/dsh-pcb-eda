import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir,homedir} from 'node:os'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {unzipSync} from 'fflate'
import {createOverview,overviewHandler,overviewCacheDirectory,OVERVIEW_ROUTE} from '../src/schematic/overview.ts'
import {parseCard} from '../src/client/overview-result.ts'

test('delivery snapshots include local paired libraries, exclude scripts, survive replay and reject arbitrary paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kicad-overview-')),project=join(root,'project'),store=join(root,'store')
 await mkdir(join(project,'libraries','footprints','parts.pretty'),{recursive:true});await mkdir(join(project,'scripts'));await mkdir(join(project,'previews'))
 const source=join(project,'design.kicad_sch'),png=join(project,'previews','design.png')
 await mkdir(join(project,'libraries','symbols'),{recursive:true});await writeFile(source,'schematic-v1');await writeFile(join(project,'design.kicad_pro'),'{}')
 await writeFile(join(project,'libraries','symbols','parts.kicad_sym'),'symbols');await writeFile(join(project,'libraries','footprints','parts.pretty','part.kicad_mod'),'footprint')
 await writeFile(join(project,'fp-lib-table'),'footprint table');await writeFile(join(project,'sym-lib-table'),'symbol table')
 await mkdir(join(project,'libraries','mappings'),{recursive:true});await writeFile(join(project,'libraries','mappings','module.json'),'{"version":1}')
 await writeFile(join(project,'scripts','secret.mjs'),'not exported');await writeFile(png,'png-v1')
 const input={workspace:root,projectDir:project,schematicPath:source,revision:'v1',pages:[{exportedPageName:'root',pngPath:png}],sources:[{schematicPath:source,sha256:createHash('sha256').update('schematic-v1').digest('hex')}]}
 const card=await createOverview(input,store)
 assert.equal(card.fileCount,7)
 assert.match(card.projectKey,/^[0-9a-f]{64}$/);assert.ok(card.createdAt>0)
 await writeFile(source,'schematic-v2');await writeFile(png,'png-v2')
 const server=createServer(overviewHandler(store));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`
  const image=await fetch(base+card.pages[0]!.imageUrl);assert.equal(await image.text(),'png-v1')
  const archive=await fetch(base+card.downloadUrl);assert.equal(archive.headers.get('content-type'),'application/zip')
  const files=unzipSync(new Uint8Array(await archive.arrayBuffer()))
  assert.equal(Buffer.from(files['design.kicad_sch']!).toString(),'schematic-v1')
  assert.ok(files['libraries/footprints/parts.pretty/part.kicad_mod']);assert.ok(!files['scripts/secret.mjs'])
  assert.ok(files['libraries/mappings/module.json'])
  const placement=await (await fetch(base+card.downloadUrl.replace('project.zip','placement.json'))).json() as any
  assert.equal(placement.type,'schematic');assert.equal(placement.root,'design.kicad_sch')
  const {fileURLToPath}=await import('node:url')
  assert.equal(Buffer.from(unzipSync(await readFile(fileURLToPath(placement.artifactUri)))['design.kicad_sch']!).toString(),'schematic-v1')
  assert.equal((await fetch(base+OVERVIEW_ROUTE+'/../package.json')).status,404)
  assert.equal((await fetch(base+card.downloadUrl,{method:'POST'})).status,405)
  await assert.rejects(createOverview(input,store),/Project changed/)
  await assert.rejects(createOverview({...input,workspace:join(root,'store')},store),/inside the workspace/)
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('card distinguishes review, delivery and failure and rejects nonlocal asset URLs',()=>{
 const block=(o:unknown)=>({content:[{type:'text',text:JSON.stringify(o)}]})
 assert.equal(parseCard(undefined).kind,'running')
 assert.deepEqual(parseCard(block({status:'ok',overview:null})),{kind:'review'})
 assert.equal(parseCard(block({status:'error',overview:null})).kind,'error')
 const id='12345678-1234-1234-1234-123456789abc'
 const overview={title:'design',filename:'design.zip',size:1024,fileCount:4,downloadUrl:`${OVERVIEW_ROUTE}/${id}/project.zip`,pages:[{name:'root',imageUrl:`${OVERVIEW_ROUTE}/${id}/page-0.png`}]}
 assert.equal(parseCard(block({status:'partial',overview})).result?.status,'partial')
 assert.equal(parseCard(block({overview:{...overview,downloadUrl:'https://external.example/file'}})).kind,'error')
 assert.equal(parseCard(block({overviewError:'archive unavailable'})).kind,'error')
 assert.deepEqual(parseCard(block({status:'error',renderStatus:'ok',deliveryStatus:'not_requested',footprintCheck:{status:'blocked',error:'Missing U1 footprint'}})),{kind:'error',message:'Missing U1 footprint'})
})

test('cache follows the current user HQ Edge home independently of runtime and install directories',()=>{
 const suffix=['plugin-data','dsh-tool-kicad-schematic-gen','overview-cache'];
 const expected=join(homedir(),'.hq-edge',...suffix);
 assert.equal(overviewCacheDirectory({}),expected);
 assert.equal(overviewCacheDirectory({DSH_HOME:join(tmpdir(),'runtime'),LOCALAPPDATA:join(tmpdir(),'app-data')}),expected);
 assert.equal(overviewCacheDirectory({HQ_EDGE_HOME:'relative-home'}),expected);
 assert.equal(overviewCacheDirectory({HQ_EDGE_HOME:''}),expected);
 for(const user of ['user-a','user-b']){
  const home=join(tmpdir(),user,'.hq-edge');
  assert.equal(overviewCacheDirectory({HQ_EDGE_HOME:home,DSH_HOME:join(tmpdir(),'runtime')}),join(home,...suffix));
 }
})

test('missing snapshots return 404 even when the snapshot exists outside the configured store',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kicad-cache-'));
 const store=join(root,'new-cache'),legacy=join(root,'old-cache'),id='12345678-1234-1234-1234-123456789abc';
 await mkdir(join(legacy,id),{recursive:true});await writeFile(join(legacy,id,'page-0.png'),'old-image');
 const server=createServer(overviewHandler(store));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address() as {port:number};
  const response=await fetch(`http://127.0.0.1:${address.port}${OVERVIEW_ROUTE}/${id}/page-0.png`);
  assert.equal(response.status,404);
  assert.equal(await readFile(join(legacy,id,'page-0.png'),'utf8'),'old-image');
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('built browser module renders formal previews only in the completed turn tail',async()=>{
 const {runInNewContext}=await import('node:vm')
 let module:any,view:any
 const react={createElement:(type:unknown,props:unknown,...children:unknown[])=>({type,props,children}),useState:(value:unknown)=>[value,()=>{}],useEffect:()=>{}}
 const script=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
 runInNewContext(script,{window:{__ModuleLoader__:{load:(options:any)=>{module=options.factory(()=>react)}}}})
 module.apply({get:()=>({context:{getEditorType:()=> 'sch'},placeArtifact:async()=>({ok:true})}),slots:{inject:(_name:string,fn:()=>unknown)=>fn(),register:(spec:any,component:any)=>{assert.equal(spec.name,'conversation.chat.turnTail');assert.equal(spec.id,'huaqiu-schematic-overview');view=component;return()=>{}}},effect:(fn:()=>unknown)=>fn()})
 const turn={turn:4,status:'closed',end:{data:{reason:{kind:'completed'}}}}
 const render=(block:unknown,owner=turn)=>view({turn:owner,useChat:(select:any)=>select({locations:{getTurn:()=>['tool']},nodes:{get:()=>({kind:'tool-call',data:{root:{kind:'tool-result',seq:20,call:{name:'render_kicad_module_preview'},...(block as object)}}})}})})
 assert.equal(render({content:[{type:'text',text:JSON.stringify({status:'ok',overview:null})}]}),null)
 assert.equal(render({isError:true,content:[{type:'text',text:'preview failed'}]}),null)
 assert.equal(view({}),null)
 assert.match(JSON.stringify(render({content:[{type:'text',text:JSON.stringify({overviewError:'formal snapshot failed'})}]})),/formal snapshot failed/)
 const id='12345678-1234-1234-1234-123456789abc'
 const block={content:[{type:'text',text:JSON.stringify({status:'ok',overview:{title:'demo',filename:'demo.zip',size:2048,fileCount:3,downloadUrl:`${OVERVIEW_ROUTE}/${id}/project.zip`,pages:[{name:'root',imageUrl:`${OVERVIEW_ROUTE}/${id}/page-0.png`}]}})}]}
 assert.equal(render(block,{turn:4,status:'open',end:undefined} as any),null)
 assert.equal(render(block,{...turn,end:{data:{reason:{kind:'aborted'}}}}),null)
 const tree=JSON.stringify(render(block))
 assert.match(tree,/原理图概览/);assert.match(tree,/下载工程 ZIP/);assert.match(tree,/放置到编辑器/);assert.ok(!tree.includes('重新生成'));assert.ok(!tree.includes('详情'))
})
