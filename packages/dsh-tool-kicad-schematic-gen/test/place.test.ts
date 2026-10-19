import {test} from 'node:test'
import assert from 'node:assert/strict'
import {placementHost,placeOverview} from '../src/client/place.ts'
test('editor placement uses the immutable ZIP and explicit hierarchy root, with host gating and failure reporting',async()=>{
 const calls:unknown[]=[]
 const host={context:{getEditorType:()=> 'sch'},placeArtifact:async(r:unknown)=>{calls.push(r);return {ok:true}}}
 assert.equal(placementHost(()=>host),host)
 assert.equal(placementHost(()=>({...host,context:{getEditorType:()=> 'pcb'}})),null)
 assert.equal(placementHost(undefined),null)
 const url='/api/v1/kicad-schematic-overview/12345678-1234-1234-1234-123456789abc/project.zip'
 const data={type:'schematic',artifactUri:'file:///D:/snapshot/project.zip',filename:'design.zip',root:'root.kicad_sch'}
 const request=(async(input:unknown)=>{assert.equal(input,url.replace('project.zip','placement.json'));return Response.json(data)}) as typeof fetch
 await placeOverview(host,url,request);assert.deepEqual(calls,[data])
 await assert.rejects(placeOverview(host,'https://external/file',request),/无效/)
 await assert.rejects(placeOverview(host,url,(async()=>new Response('',{status:404})) as typeof fetch),/重新生成/)
 await assert.rejects(placeOverview({...host,placeArtifact:async()=>({ok:false,message:'host refused'})},url,request),/host refused/)
})
