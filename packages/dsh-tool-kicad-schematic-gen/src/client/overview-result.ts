/** Parse only the preview tool's public card fields, never local paths. */
export interface CardResult {
 projectKey?:string;createdAt?:number
 status:string; title:string; pages:{name:string;imageUrl:string}[]
 downloadUrl:string; filename:string; size:number; fileCount:number
}
const asset=/^\/api\/v1\/kicad-schematic-overview\/[0-9a-f-]{36}\/(?:page-\d+\.png|project\.zip)$/
export function parseCard(block:unknown):{kind:'running'|'error'|'review'|'delivery';message?:string;result?:CardResult;formal?:boolean}{
 if(!block||typeof block!=='object')return {kind:'running'}
 const b=block as {content?:{type?:string;text?:string}[];isError?:boolean}
 if(!Array.isArray(b.content))return {kind:'running'}
 const text=b.content.find(c=>c.type==='text'&&typeof c.text==='string')?.text??''
 if(b.isError)return {kind:'error',message:'原理图预览失败，请检查工具返回的错误。'}
 let formal=false
 try{
  const o=JSON.parse(text),v=o.overview
  formal=!!v||!!o.overviewError
  if(o.overviewError)return {kind:'error',message:String(o.overviewError),formal:true}
  if(!v)return o.status==='error'?{kind:'error',message:'未能生成预览'}:{kind:'review'}
  if(typeof v.title!=='string'||typeof v.filename!=='string'||!asset.test(v.downloadUrl)||!v.downloadUrl.endsWith('/project.zip')||!Array.isArray(v.pages)||!v.pages.length||v.pages.some((p:unknown)=>!p||typeof p!=='object'||typeof (p as any).name!=='string'||!asset.test((p as any).imageUrl)||!(p as any).imageUrl.endsWith('.png')))throw new Error('Invalid overview')
  return {kind:'delivery',result:{status:o.status,title:v.title,pages:v.pages,downloadUrl:v.downloadUrl,filename:v.filename,size:v.size,fileCount:v.fileCount,projectKey:typeof v.projectKey==='string'?v.projectKey:undefined,createdAt:typeof v.createdAt==='number'&&Number.isFinite(v.createdAt)?v.createdAt:undefined}}
 }catch{return {kind:'error',message:'概览数据不可用，请查看本地预览文件。',formal}}
}
