/**
 * "Open in KiCad": hand a delivery snapshot to HQ Edge's import pipeline.
 *
 * The card owns no project directory and no KiCad knowledge: it posts the same
 * immutable ZIP it shows (and lets the user download) to
 * `/api/v1/import/kicad-b64`, and HQ Edge extracts it, moves it into the user's
 * projects directory and asks the EDA to open it. Everything the user needs to
 * see afterwards — where the project landed, whether the generating
 * conversation was carried into the project's workspace — comes back in the
 * response.
 *
 * The bridge's request proxy serializes object bodies to JSON, so the upload is
 * base64 rather than multipart (same reason the route exists in that shape).
 */

/** The subset of the `hqEdge` browser service this module needs. */
export interface ImportHost {
 api?:{request?:(request:{method:string;path:string;body?:unknown})=>Promise<unknown>}
}

export interface ImportResult {
 /** Absolute directory KiCad was asked to open. */
 projectDir:string
 projectName:string
 /** True when the generating conversation now lives in the project workspace. */
 sessionForked:boolean
 /** The projects directory HQ Edge used (the user's configured one). */
 projectsDir?:string
}

export interface ProjectsDirectory {
 directory:string
 defaultDirectory:string
 isDefault:boolean
}

const IMPORT_PATH='/api/v1/import/kicad-b64'
const DIRECTORY_PATH='/api/v1/import/directory'
/** Only our own immutable snapshots may be uploaded — never an arbitrary URL. */
const SNAPSHOT=/^\/api\/v1\/kicad-schematic-overview\/[0-9a-f-]{36}\/project\.zip$/
/** Mark the upload as a generated (not human-authored) design. */
const SOURCE_VENDOR='circuit_agent', SOURCE_FORMAT='kicad'
const MAX_BYTES=64*1024*1024

/** The host, when it can carry a request; undefined keeps the action hidden. */
export function importingHost(get:(()=>ImportHost|undefined)|undefined):Required<ImportHost>|null {
 try{const host=get?.();return host?.api?.request?{api:host.api as Required<ImportHost>['api']}:null}catch{return null}
}

/**
 * Base64 in bounded chunks: `String.fromCharCode(...bytes)` on a 64 MiB
 * snapshot overflows the call stack, and a per-byte loop is needlessly slow.
 */
export function toBase64(bytes:Uint8Array):string{
 let binary=''
 for(let i=0;i<bytes.length;i+=0x8000)
  binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000))
 return btoa(binary)
}

/**
 * Upload `downloadUrl`'s snapshot and open it in KiCad.
 *
 * `sessionId` is the conversation that produced the design: HQ Edge forks it
 * into the new project's workspace before the project is announced, so the AI
 * panel there opens on the design discussion instead of a blank chat.
 */
export async function openInKiCad(
 host:Required<ImportHost>,
 options:{downloadUrl:string;projectName:string;sessionId?:string},
 request:typeof fetch=fetch,
):Promise<ImportResult>{
 if(!SNAPSHOT.test(options.downloadUrl))throw new Error('无效的工程快照地址。')
 let bytes:Uint8Array
 try{
  const response=await request(options.downloadUrl)
  if(!response.ok)throw new Error(String(response.status))
  const buffer=await response.arrayBuffer()
  if(buffer.byteLength===0)throw new Error('empty snapshot')
  if(buffer.byteLength>MAX_BYTES)throw new Error('snapshot too large')
  bytes=new Uint8Array(buffer)
 }catch(error){throw new Error(`工程快照不可用，请重新生成后再打开（${message(error)}）。`)}

 const sessionId=options.sessionId?.trim()??''
 const payload:Record<string,unknown>={
  zip_b64:toBase64(bytes),
  filename:`${options.projectName||'design'}.zip`,
  project_name:options.projectName||'design',
  source_vendor:SOURCE_VENDOR,
  source_format:SOURCE_FORMAT,
 }
 if(sessionId.length>0)payload.session_id=sessionId

 let response:unknown
 try{response=await host.api.request!({method:'POST',path:IMPORT_PATH,body:payload})}
 catch(error){throw new Error(`打开失败：HQ Edge 未响应（${message(error)}）。`)}

 const body=(response??{}) as {project_dir?:unknown;project_name?:unknown;session_forked?:unknown;projects_dir?:unknown;error?:unknown;detail?:unknown}
 if(typeof body.project_dir!=='string'||body.project_dir.length===0)throw new Error(`打开失败：${describe(body)}`)
 return {
  projectDir:body.project_dir,
  projectName:typeof body.project_name==='string'&&body.project_name.length>0?body.project_name:options.projectName,
  sessionForked:body.session_forked===true,
  projectsDir:typeof body.projects_dir==='string'&&body.projects_dir.length>0?body.projects_dir:undefined,
 }
}

/** Where the NEXT project will be placed (and what the default would be). */
export async function readProjectsDirectory(host:Required<ImportHost>):Promise<ProjectsDirectory>{
 const response=await host.api.request!({method:'GET',path:DIRECTORY_PATH})
 return directoryOf(response)
}

/** Change (or reset with `null`) the directory new projects are placed in. */
export async function changeProjectsDirectory(host:Required<ImportHost>,directory:string|null):Promise<ProjectsDirectory>{
 try{
  const response=await host.api.request!({method:'PUT',path:DIRECTORY_PATH,body:{directory}})
  return directoryOf(response)
 }catch(error){throw new Error(`无法使用该目录：${message(error)}`)}
}

function directoryOf(response:unknown):ProjectsDirectory{
 const body=(response??{}) as {directory?:unknown;default_directory?:unknown;is_default?:unknown}
 if(typeof body.directory!=='string'||body.directory.length===0)throw new Error('目录设置不可用。')
 return {
  directory:body.directory,
  defaultDirectory:typeof body.default_directory==='string'?body.default_directory:body.directory,
  isDefault:body.is_default===true,
 }
}

function describe(body:{error?:unknown;detail?:unknown}):string{
 const text=typeof body.error==='string'&&body.error.length>0?body.error:typeof body.detail==='string'?body.detail:''
 return text.length>0?text:'HQ Edge 未返回工程目录。'
}

function message(error:unknown):string{return error instanceof Error?error.message:String(error)}
