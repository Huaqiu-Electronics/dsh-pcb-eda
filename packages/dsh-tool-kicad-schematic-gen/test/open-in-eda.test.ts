import {test} from 'node:test'
import assert from 'node:assert/strict'
import {importingHost,toBase64,openInKiCad,readProjectsDirectory,changeProjectsDirectory} from '../src/client/open-in-eda.ts'

const url='/api/v1/kicad-schematic-overview/12345678-1234-1234-1234-123456789abc/project.zip'

function hostOf(calls:{method:string;path:string;body?:unknown}[],reply:(path:string)=>unknown){
 return importingHost(()=>({api:{request:async(request)=>{calls.push(request);return reply(request.path)}}}))!
}

test('open in KiCad posts the immutable snapshot with the generating session so the fork can follow it',async()=>{
 const calls:{method:string;path:string;body?:unknown}[]=[]
 const host=hostOf(calls,()=>({design_id:'d1',status:'ok',project_dir:'/Users/me/Documents/design',project_name:'design',session_forked:true,projects_dir:'/Users/me/Documents'}))
 const bytes=new Uint8Array(0x8000+3).fill(7)
 const request=(async(input:unknown)=>{assert.equal(input,url);return new Response(bytes)}) as typeof fetch
 const result=await openInKiCad(host,{downloadUrl:url,projectName:'design',sessionId:'sess-42'},request)
 assert.equal(calls.length,1)
 const [call]=calls
 assert.equal(call!.method,'POST');assert.equal(call!.path,'/api/v1/import/kicad-b64')
 const body=call!.body as Record<string,unknown>
 assert.equal(body.session_id,'sess-42');assert.equal(body.filename,'design.zip');assert.equal(body.project_name,'design')
 assert.equal(body.source_vendor,'circuit_agent');assert.equal(body.source_format,'kicad')
 // 32 KiB + 3 bytes survives the chunked base64 encoder intact.
 assert.deepEqual(new Uint8Array(Buffer.from(String(body.zip_b64),'base64')),bytes)
 assert.deepEqual(result,{projectDir:'/Users/me/Documents/design',projectName:'design',sessionForked:true,projectsDir:'/Users/me/Documents'})
})

test('open in KiCad refuses foreign URLs, omits an absent session and reports refusals',async()=>{
 const calls:{method:string;path:string;body?:unknown}[]=[]
 const host=hostOf(calls,()=>({project_dir:'/p/design',project_name:'design'}))
 const request=(async()=>new Response(new Uint8Array([1,2,3]))) as typeof fetch
 await assert.rejects(openInKiCad(host,{downloadUrl:'https://external.example/design.zip',projectName:'design'},request),/无效/)
 await assert.rejects(openInKiCad(host,{downloadUrl:'/tmp/design.zip',projectName:'design'},request),/无效/)
 const result=await openInKiCad(host,{downloadUrl:url,projectName:'design',sessionId:'   '},request)
 assert.equal((calls[0]!.body as Record<string,unknown>).session_id,undefined)
 assert.equal(result.sessionForked,false);assert.equal(result.projectDir,'/p/design')
 // A snapshot that cannot be read is reported before anything is uploaded.
 const failing=(async()=>new Response('',{status:404})) as typeof fetch
 const before=calls.length
 await assert.rejects(openInKiCad(host,{downloadUrl:url,projectName:'design'},failing),/重新生成/)
 assert.equal(calls.length,before)
 // HQ Edge refusing the import surfaces its own message.
 const refusing=hostOf([],()=>({error:'Import failed',detail:'no .kicad_pro'}))
 await assert.rejects(openInKiCad(refusing,{downloadUrl:url,projectName:'design'},request),/HQ Edge 未返回工程目录|打开失败/)
})

test('projects directory can be read and changed, and rejects unusable answers',async()=>{
 const calls:{method:string;path:string;body?:unknown}[]=[]
 const host=hostOf(calls,(path)=>path==='/api/v1/import/directory'
  ?{directory:calls.length===1?'/Users/me/Documents':'/data/projects',default_directory:'/Users/me/Documents',is_default:calls.length===1}
  :{})
 assert.deepEqual(await readProjectsDirectory(host),{directory:'/Users/me/Documents',defaultDirectory:'/Users/me/Documents',isDefault:true})
 assert.equal(calls[0]!.method,'GET');assert.equal(calls[0]!.path,'/api/v1/import/directory');assert.equal(calls[0]!.body,undefined)
 assert.deepEqual(await changeProjectsDirectory(host,'/data/projects'),{directory:'/data/projects',defaultDirectory:'/Users/me/Documents',isDefault:false})
 assert.equal(calls[1]!.method,'PUT');assert.deepEqual(calls[1]!.body,{directory:'/data/projects'})
 await changeProjectsDirectory(host,null)
 assert.deepEqual((calls[2]!.body as {directory:unknown}).directory,null)
 const broken=hostOf([],()=>({}))
 await assert.rejects(readProjectsDirectory(broken),/目录设置不可用/)
 const failing=importingHost(()=>({api:{request:async()=>{throw new Error('HTTP 400: relative path')}}}))!
 await assert.rejects(changeProjectsDirectory(failing,'relative'),/无法使用该目录.*relative/)
 assert.equal(importingHost(()=>({api:{}})),null)
 assert.equal(importingHost(undefined),null)
 assert.equal(toBase64(new Uint8Array([])),'')
})
