/** Version comparison narrows visual work; it never grants visual acceptance. */
import {createHash} from 'node:crypto'
import {parse,children,value,type Form} from './sexpr.ts'
import {listFlatObjects,inspectSchematicText} from './flat.ts'
import {unionFlatBounds,type FlatBounds,type FlatLayoutStyle} from './flat-layout.ts'
import type {PreviewRegion} from './preview-regions.ts'

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const canonical=(form:Form):unknown=>form.items.filter(item=>typeof item==='string'||!['uuid','instances'].includes(item.head))
 .map(item=>typeof item==='string'?item:canonical(item))
export interface ReviewSnapshot {
 version:1;contract:string;revision:string;global:string
 objects:Array<{key:string;bounds:FlatBounds|null}>
}
export function reviewSnapshot(source:string,style:FlatLayoutStyle,contract:string):ReviewSnapshot{
 const root=parse(source),objects=listFlatObjects(source,style),texts=inspectSchematicText(source,style)
 const byId=new Map(objects.map(object=>[object.uuid,object]))
 const records:ReviewSnapshot['objects']=[],globals:unknown[]=[]
 for(const form of root.items){
  if(typeof form==='string')continue
  const uuid=children(form,'uuid')[0],id=uuid?value(uuid):undefined,object=id?byId.get(id):undefined
  if(!object){if(!['uuid','generator','generator_version','sheet_instances'].includes(form.head))globals.push(canonical(form));continue}
  const boxes=[...(object.bounds?[object.bounds]:[]),...texts.filter(t=>t.ownerUuid===id).map(t=>t.bounds)]
  records.push({key:digest(canonical(form)),bounds:unionFlatBounds(boxes)})
 }
 return {version:1,contract,revision:digest(source),global:digest(globals),objects:records}
}

/** Include removed objects as well as their new positions when choosing the recheck area. */
export function changedReviewRegion(previous:ReviewSnapshot|undefined,current:ReviewSnapshot,frame:PreviewRegion,forceFull=false){
 if(forceFull||!previous||previous.version!==1||previous.contract!==current.contract||previous.global!==current.global)
  return {mode:'full' as const,regions:[frame],reason:forceFull?'explicit_full_review':'first_preview_or_shared_configuration_changed'}
 const remainder=[...previous.objects],changed:ReviewSnapshot['objects']=[]
 for(const object of current.objects){
  const index=remainder.findIndex(old=>old.key===object.key)
  if(index<0)changed.push(object);else remainder.splice(index,1)
 }
 changed.push(...remainder)
 if(!changed.length)return {mode:'unchanged' as const,regions:[],reason:'same_visible_content'}
 if(changed.some(object=>!object.bounds))return {mode:'full' as const,regions:[frame],reason:'changed_object_has_unknown_bounds'}
 const b=unionFlatBounds(changed.map(object=>object.bounds!))!
 const start:[number,number]=[b.left-3.81,b.top-3.81],end:[number,number]=[b.right+3.81,b.bottom+3.81]
 const area=(end[0]-start[0])*(end[1]-start[1]),frameArea=(frame.end[0]-frame.start[0])*(frame.end[1]-frame.start[1])
 if(area>frameArea*.6)return {mode:'full' as const,regions:[frame],reason:'changes_span_most_of_frame'}
 return {mode:'changed_regions' as const,regions:[{name:'changed objects and previous positions',pageName:frame.pageName,start,end}],reason:'compare_previous_preview_not_visual_approval'}
}

/** Every issue remains actionable in one response, even when image crops are merged. */
export function reviewIssues(report:any){
 return [
  ...(report.connectivity?.issues??report.issues??[]).map((issue:any)=>({category:'electrical',...issue})),
  ...(report.layout?.reviewIssues??[]).map((issue:any)=>({category:issue.code==='MODULE_LAYOUT_OUTSIDE_FRAME'?'frame':'visual_confirmation',...issue})),
  ...(report.result?.fieldLayout?.unresolved??[]).map((issue:any)=>({category:'visual_confirmation',...issue})),
 ]
}

/** Bounded batch feedback; the on-disk report remains the complete diagnostic source. */
export function summarizeReviewIssues(report:any,maxItems=12,maxChars=6000){
 const all=reviewIssues(report)
 if(!all.length&&report.status!=='passed')all.push({category:'electrical',code:report.code??'MODULE_CHECK_FAILED',message:report.error??'Module check failed; read the full report.'})
 const counts:Record<string,number>={}
 const rank=(issue:any)=>issue.category==='electrical'?0:issue.code==='MODULE_LAYOUT_OUTSIDE_FRAME'?1:issue.code==='TEXT_OVERLAP_REVIEW'?2:issue.code==='LAYOUT_OVERLAP_REVIEW'?4:3
 const issues:any[]=[],compact=(issue:any)=>{
  const item:Record<string,unknown>={category:issue.category,code:typeof issue.code==='string'?issue.code.slice(0,100):'FIELD_REVIEW'}
  for(const key of ['reference','pin','net','actualNet','field','moduleId','message','reason'])if(typeof issue[key]==='string'){
   item[key]=issue[key].slice(0,300);if(issue[key].length>300)item.detailsTruncated=true
  }
  if(Array.isArray(issue.references)){item.references=issue.references.slice(0,8).map((v:unknown)=>String(v).slice(0,60));if(issue.references.length>8){item.omittedReferences=issue.references.length-8;item.detailsTruncated=true}}
  for(const key of ['start','end','from','to'])if(Array.isArray(issue[key])&&issue[key].length===2&&issue[key].every(Number.isFinite))item[key]=issue[key]
  for(const key of ['actualNets','expectedNets','fields'])if(Array.isArray(issue[key])){
   item[key]=issue[key].slice(0,8).map((v:unknown)=>String(v).slice(0,100));if(issue[key].length>8)item.detailsTruncated=true
  }
  if(Array.isArray(issue.pins)){
   item.pins=issue.pins.slice(0,8).map((p:any)=>({reference:String(p.reference).slice(0,60),pin:String(p.pin).slice(0,60)}))
   if(issue.pins.length>8)item.detailsTruncated=true
  }
  return item
 }
 let chars=0
 for(const issue of [...all].sort((a,b)=>rank(a)-rank(b))){
  const key=issue.code??'FIELD_REVIEW';counts[key]=(counts[key]??0)+1
  const item=compact(issue),length=JSON.stringify(item).length
  if(issues.length<maxItems&&chars+length<=maxChars){issues.push(item);chars+=length}
 }
 const spaceFailure=['POWER_PLACEMENT_UNAVAILABLE','MODULE_SPACE_INSUFFICIENT'].includes(report.code)
 const stage=spaceFailure?'resize':report.status!=='passed'?'structure':all.some(i=>rank(i)<4)?'layout':'visual_review'
 return {issues,issueCount:all.length,omittedIssues:all.length-issues.length,counts,
  repairPlan:{stage,batchRequired:true,fullReportRequired:issues.length<all.length||issues.some(i=>i.detailsTruncated),
   nextAction:spaceFailure?'Ask the parent for one coordinated frame/route change before another build; include all space failures.':
    stage==='structure'?'Read all structural/connection defects (including omitted items in reportPath), fix them together, then rebuild once.':
    stage==='layout'?'Read the current frame and diagnostic images together; batch all confirmed layout defects before rebuilding.':
    'Review the current images. Approximate overlaps require confirmation; do not rebuild solely to clear conservative warnings.'}}
}

/** Keep all diagnostic areas covered without returning an unbounded number of images. */
export function batchReviewRegions(regions:PreviewRegion[]):PreviewRegion[]{
 const unique=regions.filter((region,index)=>regions.findIndex(other=>JSON.stringify([other.pageName,other.start,other.end])===JSON.stringify([region.pageName,region.start,region.end]))===index)
 if(unique.length<=8)return unique
 const pages=new Map<string,PreviewRegion[]>()
 for(const region of unique)pages.set(region.pageName,[...(pages.get(region.pageName)??[]),region])
 return [...pages].map(([pageName,items])=>({name:'all diagnostic areas',pageName,
  start:[Math.min(...items.map(r=>r.start[0])),Math.min(...items.map(r=>r.start[1]))],
  end:[Math.max(...items.map(r=>r.end[0])),Math.max(...items.map(r=>r.end[1]))]}))
}
