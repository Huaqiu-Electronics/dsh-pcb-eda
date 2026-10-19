/** Use the host's existing interactive schematic placement channel. */
export interface PlacementHost {
 context?:{getEditorType?:()=>string;getCurrent?:()=>{editorType?:string}|null}
 placeArtifact?:(request:{type:'schematic';artifactUri:string;filename:string;root:string})=>Promise<unknown>
}
export function placementHost(get:(()=>PlacementHost|undefined)|undefined){
 try{const host=get?.(),editor=host?.context?.getEditorType?.()??host?.context?.getCurrent?.()?.editorType;
 return host?.placeArtifact&&['sch','generic'].includes(editor??'')?host:null}catch{return null}
}
export async function placeOverview(host:PlacementHost,downloadUrl:string,request:typeof fetch=fetch){
 if(!/^\/api\/v1\/kicad-schematic-overview\/[0-9a-f-]{36}\/project\.zip$/.test(downloadUrl))throw new Error('无效的工程快照地址。')
 const response=await request(downloadUrl.replace(/project\.zip$/,'placement.json'))
 if(!response.ok)throw new Error('该快照不支持放置，请重新生成正式概览。')
 const data=await response.json()
 if(data.type!=='schematic'||typeof data.artifactUri!=='string'||!data.artifactUri.startsWith('file:')||typeof data.filename!=='string'||typeof data.root!=='string')throw new Error('放置数据无效。')
 const result=await host.placeArtifact!({type:'schematic',artifactUri:data.artifactUri,filename:data.filename,root:data.root}) as {ok?:boolean;message?:string}|undefined
 if(result?.ok===false)throw new Error(result.message??'编辑器拒绝放置。')
}
