/** Immutable, bounded snapshots for the browser; never accepts browser file paths. */
import {randomUUID,createHash} from 'node:crypto'
import {mkdir,readFile,writeFile,readdir,realpath,rename,rm} from 'node:fs/promises'
import {basename,dirname,join,relative,isAbsolute,extname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {zipSync} from 'fflate'
import type {Context} from '@deepseek-ai/cordis'
import {homedir} from 'node:os'

export const OVERVIEW_ROUTE='/api/v1/kicad-schematic-overview'
const legacyCache=fileURLToPath(new URL('../.overview-cache/',import.meta.url))
/** Store generated data outside installed code, including read-only plugin installations. */
export function overviewCacheDirectory(env:NodeJS.ProcessEnv=process.env):string{
 const home=env.DSH_HOME;
 if(home&&isAbsolute(home))return join(home,'plugin-data','dsh-tool-kicad-schematic-gen','overview-cache');
 const userData=env.LOCALAPPDATA&&isAbsolute(env.LOCALAPPDATA)?env.LOCALAPPDATA:join(homedir(),'.local','share');
 return join(userData,'deepseek-harness','dsh-tool-kicad-schematic-gen','overview-cache');
}
const MAX_BYTES=64*1024*1024
export interface Overview {
 projectKey:string;createdAt:number
 title:string; revision:string; pages:{name:string;imageUrl:string}[]
 downloadUrl:string;filename:string;fileCount:number;size:number
}
export async function createOverview(input:{workspace:string;projectDir:string;schematicPath:string;revision:string;pages:{exportedPageName:string;pngPath:string}[];sources?:{schematicPath:string;sha256:string}[]},store=overviewCacheDirectory()):Promise<Overview>{
 const workspace=await realpath(input.workspace),project=await realpath(input.projectDir)
 function inside(root:string,path:string){const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel))}
 if(!inside(workspace,project)||!inside(project,await realpath(input.schematicPath)))throw new Error('Overview projectDir must contain the schematic and stay inside the workspace')
 const files:Record<string,Uint8Array>={};let total=0
 async function bounded(path:string){
  if(!inside(workspace,await realpath(path)))throw new Error('Overview file escapes workspace')
  const {stat}=await import('node:fs/promises');const info=await stat(path)
  if(info.size+total>MAX_BYTES)throw new Error('Overview snapshot exceeds 64 MiB')
  const bytes=await readFile(path);total+=bytes.length
  if(total>MAX_BYTES)throw new Error('Overview snapshot exceeds 64 MiB')
  return bytes
 }
 async function collect(dir:string){
  for(const entry of await readdir(dir,{withFileTypes:true})){
   if(entry.isSymbolicLink())throw new Error('Overview archive does not follow symbolic links')
   const path=join(dir,entry.name)
   if(entry.isDirectory()){
    if(!entry.name.startsWith('.')&&!['previews','scripts','history','node_modules'].includes(entry.name))await collect(path)
   }else if(entry.isFile()&&(['.kicad_sch','.kicad_pro','.kicad_sym','.kicad_mod','.step','.stp','.wrl'].includes(extname(entry.name).toLowerCase())||['sym-lib-table','fp-lib-table'].includes(entry.name)||(extname(entry.name)==='.json'&&relative(project,path).replaceAll('\\','/').startsWith('libraries/mappings/')))){
    if(Object.keys(files).length>=2000)throw new Error('Overview archive exceeds 2000 files')
    files[relative(project,path).replaceAll('\\','/')]=await bounded(path)
   }
  }
 }
 await collect(project)
 for(const source of input.sources??[]){
  const key=relative(project,source.schematicPath).replaceAll('\\','/')
  if(!files[key]||createHash('sha256').update(files[key]!).digest('hex')!==source.sha256)throw new Error('Project changed or referenced sheet is outside projectDir; refresh the formal preview before delivery')
 }
 const images=await Promise.all(input.pages.map(async page=>({name:page.exportedPageName,bytes:await bounded(page.pngPath)})))
 const id=randomUUID(),directory=join(store,id),pending=join(store,`.pending-${id}`);
 const zip=zipSync(files,{level:6});await mkdir(pending,{recursive:true});
 try{
  await writeFile(join(pending,'project.zip'),zip,{flag:'wx'})
  await writeFile(join(pending,'placement.json'),JSON.stringify({type:'schematic',artifactUri:pathToFileURL(join(directory,'project.zip')).href,filename:`${basename(input.schematicPath,'.kicad_sch')}.zip`,root:relative(project,input.schematicPath).replaceAll('\\','/')}),{flag:'wx'})
  for(let i=0;i<images.length;i++)await writeFile(join(pending,`page-${i}.png`),images[i]!.bytes,{flag:'wx'})
  await rename(pending,directory)
 }catch(error){await rm(pending,{recursive:true,force:true});throw error}
 return {projectKey:createHash('sha256').update(join(project,relative(project,input.schematicPath))).digest('hex'),createdAt:Date.now(),title:basename(input.schematicPath,'.kicad_sch'),revision:input.revision,
  pages:images.map((page,i)=>({name:page.name,imageUrl:`${OVERVIEW_ROUTE}/${id}/page-${i}.png`})),
  downloadUrl:`${OVERVIEW_ROUTE}/${id}/project.zip`,filename:`${basename(input.schematicPath,'.kicad_sch')}.zip`,fileCount:Object.keys(files).length,size:zip.length}
}

export function overviewHandler(store=overviewCacheDirectory(),legacyStore:string|undefined=store===overviewCacheDirectory()?legacyCache:undefined){return async(req:IncomingMessage,res:ServerResponse)=>{
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return}
 const path=(req.url??'').split('?')[0]??''
 const match=path.slice(OVERVIEW_ROUTE.length).match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(project\.zip|placement\.json|page-\d+\.png)$/)
 if(!path.startsWith(OVERVIEW_ROUTE)||!match){res.writeHead(404);res.end();return}
 try{
  let bytes:Buffer;
  try{bytes=await readFile(join(store,match[1]!,match[2]!))}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT'||!legacyStore)throw error;
   // Existing conversation cards remain readable; never write into installed code.
   bytes=await readFile(join(legacyStore,match[1]!,match[2]!))
  }
  res.writeHead(200,{'content-type':match[2]==='project.zip'?'application/zip':match[2]==='placement.json'?'application/json':'image/png','content-length':bytes.length,'cache-control':'private, max-age=31536000, immutable','x-content-type-options':'nosniff',...(match[2]==='project.zip'?{'content-disposition':'attachment; filename="project.zip"'}:{})})
  res.end(req.method==='HEAD'?undefined:bytes)
 }catch{res.writeHead(404);res.end()}
}}
export function registerOverview(ctx:Pick<Context,'get'|'effect'>):boolean{
 const server=ctx.get?.('webServer') as {register?:(route:unknown)=>(()=>void)}|undefined
 if(typeof server?.register!=='function')return false
 ctx.effect(()=>server.register!({kind:'prefix',path:OVERVIEW_ROUTE,handler:overviewHandler()}))
 return true
}
