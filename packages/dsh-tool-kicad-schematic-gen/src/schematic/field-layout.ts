/** Bounded movement of default property text only. Pins, bodies and wires never move. */
import {applyEdits,children,parse,value} from './sexpr.ts'
import {flatTextSize,type FlatBounds,type FlatLayoutStyle} from './flat-layout.ts'
import type {FlatObject,FlatPoint} from './flat.ts'
import {gridPoint} from './grid.ts'
import {insideBounds,type PowerLayoutArea} from './power-layout.ts'
export interface DefaultFields {body:FlatBounds;at:FlatPoint;reference:boolean;value:boolean}
const overlap=(a:FlatBounds,b:FlatBounds)=>a.left<b.right+0.3&&a.right>b.left-0.3&&a.top<b.bottom+0.3&&a.bottom>b.top-0.3
const box=(p:FlatPoint,w:number,h:number):FlatBounds=>({left:p[0]-w/2,right:p[0]+w/2,top:p[1]-h/2,bottom:p[1]+h/2})
export function arrangeDefaultFields(instances:readonly string[],defaults:ReadonlyMap<string,DefaultFields>,objects:FlatObject[],areas:readonly PowerLayoutArea[],page:FlatPoint,style:FlatLayoutStyle){
 let movedCount=0
 const unresolved:string[]=[],current=new Map(objects.filter(o=>!['rectangle','junction','no_connect'].includes(o.type)).map(o=>[o.uuid,o.bounds]))
 const result=instances.map(source=>{
  const form=parse(source),uuid=children(form,'uuid')[0],id=uuid?value(uuid):'',spec=defaults.get(id)
  if(!spec)return source
  const area=areas.find(a=>spec.at[0]>=a.bounds.left&&spec.at[0]<=a.bounds.right&&spec.at[1]>=a.bounds.top&&spec.at[1]<=a.bounds.bottom)
  const allowed=area?.contentBounds??{left:0,top:0,right:page[0],bottom:page[1]}
  const properties=children(form,'property').filter(p=>['Reference','Value'].includes(value(p)))
  const reference=properties.find(p=>value(p)==='Reference')
  const identity=reference?value(reference,2):id
  const selected:FlatBounds[]=[],edits:Array<{start:number;end:number;text:string}>=[]
  const visible=properties.filter(p=>!children(p,'effects').some(e=>e.items.includes('hide')||children(e,'hide').some(h=>value(h)==='yes')))
  const instanceAngle=Number(children(form,'at')[0]?.items[3]??0)
  // Explicit property positions are obstacles and are never changed.
  for(const p of visible){
   if(value(p)==='Reference'?spec.reference:spec.value)continue
   const at=children(p,'at')[0]!;let [w,h]=flatTextSize(value(p,2),[1.27,1.27],style)
   if((Number(value(at,3))+instanceAngle)%180!==0)[w,h]=[h,w]
   selected.push(box([Number(value(at,1)),Number(value(at,2))],w,h))
  }
  for(const p of visible){
   if(!(value(p)==='Reference'?spec.reference:spec.value))continue
   const at=children(p,'at')[0]!,origin:FlatPoint=[Number(value(at,1)),Number(value(at,2))],angle=Number(value(at,3))
   let [w,h]=flatTextSize(value(p,2),[1.27,1.27],style);if((angle+instanceAngle)%180!==0)[w,h]=[h,w]
   const b=spec.body,cx=(b.left+b.right)/2,cy=(b.top+b.bottom)/2
   const candidates:FlatPoint[]=[origin]
   for(const gap of [1.27,3.81,6.35])candidates.push([cx,b.top-gap-h/2],[cx,b.bottom+gap+h/2],[b.right+gap+w/2,cy],[b.left-gap-w/2,cy])
   let best:{at:FlatPoint;bounds:FlatBounds;score:number;conflicts:number}|undefined
   for(const candidate of candidates){
    const at=candidate===origin?origin:gridPoint(candidate),bounds=box(at,w,h),distance=Math.abs(at[0]-origin[0])+Math.abs(at[1]-origin[1])
    if(distance>12.7||!insideBounds(bounds,allowed))continue
    const conflicts=[...current].filter(([other,bounds_])=>other!==id&&bounds_&&overlap(bounds,bounds_)).length
     +selected.filter(other=>overlap(bounds,other)).length+Number(overlap(bounds,b))
    const score=conflicts*10000+distance
    if(!best||score<best.score)best={at,bounds,score,conflicts}
   }
   if(!best){unresolved.push(`${identity}:${value(p)}`);continue}
   selected.push(best.bounds)
   if(best.conflicts)unresolved.push(`${identity}:${value(p)}`)
   if(best.at.some((v,i)=>Math.abs(v-origin[i]!)>1e-6)){
    edits.push({start:at.start,end:at.end,text:`(at ${best.at[0]} ${best.at[1]} ${angle})`});movedCount++
   }
  }
  if(selected.length)current.set(id,{left:Math.min(spec.body.left,...selected.map(b=>b.left)),right:Math.max(spec.body.right,...selected.map(b=>b.right)),top:Math.min(spec.body.top,...selected.map(b=>b.top)),bottom:Math.max(spec.body.bottom,...selected.map(b=>b.bottom))})
  return edits.length?applyEdits(source,edits):source
 })
 return {instances:result,movedCount,unresolved}
}
