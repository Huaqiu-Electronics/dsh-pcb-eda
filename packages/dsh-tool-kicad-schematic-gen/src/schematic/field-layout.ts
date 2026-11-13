/** Bounded movement of default property text only. Pins, bodies and wires never move. */
import {applyEdits,children,parse,value} from './sexpr.ts'
import {textBounds,type FlatBounds,type FlatLayoutStyle} from './flat-layout.ts'
import type {FlatObject,FlatPoint} from './flat.ts'
import {gridPoint} from './grid.ts'
import {insideBounds,type PowerLayoutArea} from './power-layout.ts'
export interface DefaultFields {body:FlatBounds;at:FlatPoint;reference:boolean;value:boolean}
const overlap=(a:FlatBounds,b:FlatBounds)=>a.left<b.right+0.3&&a.right>b.left-0.3&&a.top<b.bottom+0.3&&a.bottom>b.top-0.3
export function arrangeDefaultFields(instances:readonly string[],defaults:ReadonlyMap<string,DefaultFields>,objects:FlatObject[],areas:readonly PowerLayoutArea[],page:FlatPoint,style:FlatLayoutStyle){
 let movedCount=0
 const unresolved:string[]=[]
 const current=new Map<string,FlatBounds[]>(objects.flatMap(o=>o.bounds&&!['rectangle','junction','no_connect'].includes(o.type)?[[o.uuid,[o.bounds]]]:[]))
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
  const mirror=children(form,'mirror')[0]
  const instanceMirror=mirror?value(mirror):''
  // Explicit property positions are obstacles and are never changed.
  for(const p of visible){
   if(value(p)==='Reference'?spec.reference:spec.value)continue
   selected.push(textBounds(p,value(p,2),style,instanceAngle,instanceMirror)!)
  }
  const automatic=visible.filter(p=>value(p)==='Reference'?spec.reference:spec.value)
  const choices=automatic.map((p,index)=>{
   const at=children(p,'at')[0]!,origin:FlatPoint=[Number(value(at,1)),Number(value(at,2))],angle=Number(value(at,3))
   const originalBounds=textBounds(p,value(p,2),style,instanceAngle,instanceMirror)!
   const offsetX=(originalBounds.left+originalBounds.right)/2-origin[0]
   const offsetY=(originalBounds.top+originalBounds.bottom)/2-origin[1]
   const w=originalBounds.right-originalBounds.left,h=originalBounds.bottom-originalBounds.top
   const b=spec.body,cx=(b.left+b.right)/2,cy=(b.top+b.bottom)/2
   const candidates:FlatPoint[]=[origin]
   // Put Reference above Value on either side when both can move.
   const row=automatic.length===2?(index===0?-1.27:1.27):0
   for(const gap of [1.27,3.81,6.35])candidates.push(
    [cx,b.top-gap-h/2+row-Math.abs(row)],[cx,b.bottom+gap+h/2+row+Math.abs(row)],
    [b.right+gap+w/2,cy+row],[b.left-gap-w/2,cy+row])
   const options=candidates.flatMap((candidate,i)=>{
    const position=i===0?origin:gridPoint([candidate[0]-offsetX,candidate[1]-offsetY])
    const dx=position[0]-origin[0],dy=position[1]-origin[1]
    const bounds={left:originalBounds.left+dx,right:originalBounds.right+dx,
     top:originalBounds.top+dy,bottom:originalBounds.bottom+dy}
    const distance=Math.abs(position[0]-origin[0])+Math.abs(position[1]-origin[1])
    if(i>0&&(distance>12.7||!insideBounds(bounds,allowed)))return []
    const conflicts=[...current].filter(([other,boxes])=>other!==id&&boxes.some(otherBox=>overlap(bounds,otherBox))).length
     +selected.filter(other=>overlap(bounds,other)).length+Number(overlap(bounds,b))+Number(!insideBounds(bounds,allowed))
    return [{position,bounds,distance,conflicts}]
   })
   return {p,at,angle,options}
  })
  type Option = typeof choices[number]['options'][number]
  const combinations:Option[][]=choices.reduce<Option[][]>((groups,choice)=>
   groups.flatMap(group=>choice.options.map(option=>[...group,option])),[[]])
  const collides=(group:Option[])=>group.length===2&&overlap(group[0]!.bounds,group[1]!.bounds)
  const score=(group:Option[])=>group.reduce((sum,o)=>sum+o.conflicts*10000+o.distance,0)
   +Number(collides(group))*20000+(group.length===2?Math.min(20,
    (Math.abs(group[0]!.position[0]-group[1]!.position[0])+Math.abs(group[0]!.position[1]-group[1]!.position[1]))/2):0)
  const best=combinations.reduce((best,group)=>score(group)<score(best)?group:best)
  const fieldsOverlap=collides(best)
  for(const [{p,at,angle,options},placement] of choices.map((choice,i)=>[choice,best[i]!] as const)){
   selected.push(placement.bounds)
   if(placement.conflicts||fieldsOverlap)unresolved.push(`${identity}:${value(p)}`)
   if(placement.position!==options[0]!.position){
    edits.push({start:at.start,end:at.end,text:`(at ${placement.position[0]} ${placement.position[1]} ${angle})`});movedCount++
   }
  }
  if(selected.length)current.set(id,[spec.body,...selected])
  return edits.length?applyEdits(source,edits):source
 })
 return {instances:result,movedCount,unresolved}
}
