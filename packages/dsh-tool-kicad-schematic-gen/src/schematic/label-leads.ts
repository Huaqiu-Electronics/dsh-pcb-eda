import type {FlatPoint} from './flat.ts'

export interface LabelTarget {
 pin(reference:string,number:string):FlatPoint
 wire(from:FlatPoint,to:FlatPoint,via?:FlatPoint[]):unknown
 label(name:string,at:FlatPoint,angle?:number):unknown
}
/** Explicit, reusable label fanout. Caller chooses outward direction and clear lanes.
 * Coordinates stay in the target's coordinate system (sheet or region).
 * This does not infer pin orientation, avoid obstacles or validate connectivity.
 */
export function attachPinLabel(target:LabelTarget,spec:{reference:string;pin:string;net:string;direction:'left'|'right'|'up'|'down';length?:number;lane?:number;pitch?:number}){
 const {reference,pin,net,direction,length=5.08,lane=0,pitch=2.54}=spec
 const axis:Record<string,FlatPoint>={left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]},v=axis[direction]
 if(!v||!net.trim()||!Number.isFinite(length)||length<=0||!Number.isInteger(lane)||!Number.isFinite(pitch)||pitch<=0)throw new Error('Label lead needs a net, outward direction, positive length/pitch and integer lane')
 const round=(n:number)=>Math.round(n*1e6)/1e6
 const start=target.pin(reference,pin).map(round) as FlatPoint
 const elbow:FlatPoint=[round(start[0]+v[0]*length),round(start[1]+v[1]*length)]
 const end:FlatPoint=[round(elbow[0]-v[1]*lane*pitch),round(elbow[1]+v[0]*lane*pitch)]
 target.wire(start,end,lane?[elbow]:[])
 // Keep text horizontal; left-growing labels face away from a left exit.
 const label=target.label(net,end,direction==='left'?180:0)
 return {at:end,label}
}

/** One side of a symbol: straight leads and labels over wires by default.
 * Does not infer pin sides or reroute existing connections. Inspect warnings in preview.
 */
export function attachPinLabels(target:LabelTarget,spec:{
 reference:string;pins:{pin:string;net:string}[];direction:'left'|'right'|'up'|'down';
 length?:number;alignAt?:number;minPitch?:number;textPosition?:'overWire'|'outside'
}){
 const {reference,pins,direction,length=5.08,alignAt,minPitch=1.8,textPosition='overWire'}=spec
 const horizontal=direction==='left'||direction==='right'
 const sign=direction==='left'||direction==='up'?-1:1
 const axis=horizontal?0:1,other=horizontal?1:0
 if(!['left','right','up','down'].includes(direction)||!reference?.trim()||!Array.isArray(pins)||!pins.length||
   !Number.isFinite(length)||length<=0||!Number.isFinite(minPitch)||minPitch<=0||
   !['overWire','outside'].includes(textPosition)||
   (alignAt!==undefined&&!Number.isFinite(alignAt)))throw new Error('Label group needs pins, direction and positive length/minPitch; alignAt must be finite')
 const seen=new Set<string>(),round=(n:number)=>Math.round(n*1e6)/1e6
 // Resolve and validate the whole group before adding any wires or labels.
 const planned=pins.map(({pin,net})=>{
  if(!pin?.trim()||!net?.trim()||seen.has(pin))throw new Error('Label group needs unique pins and nonempty nets')
  seen.add(pin)
  const start=target.pin(reference,pin).map(round) as FlatPoint
  if(start.length!==2||start.some(n=>!Number.isFinite(n)))throw new Error('Label group pin coordinates must be finite')
  return {pin,net,start}
 })
 const edge=sign<0?Math.min(...planned.map(p=>p.start[axis])):Math.max(...planned.map(p=>p.start[axis]))
 // 1.27 mm font: conservative character-cell width, plus an inset and pin clearance.
 const textSpan=(net:string)=>Array.from(net).length*1.27+2.54
 const leadLength=textPosition==='overWire'?Math.max(length,...planned.map(p=>textSpan(p.net))):length
 const baseline=round(alignAt??edge+sign*leadLength)
 if(planned.some(p=>sign*(baseline-p.start[axis])<=0))throw new Error('Label baseline must be outside every selected pin')
 const ordered=[...planned].sort((a,b)=>a.start[other]-b.start[other])
 if(ordered.some((p,i)=>i>0&&p.start[other]===ordered[i-1]!.start[other]))throw new Error('Selected pins share a lead track; split the group or connect a common bus explicitly')
 const warnings=ordered.flatMap((p,i)=>i>0&&p.start[other]-ordered[i-1]!.start[other]<minPitch?
  [{code:'LABEL_PITCH_TIGHT' as const,pins:[ordered[i-1]!.pin,p.pin],pitch:round(p.start[other]-ordered[i-1]!.start[other])}]:[])
 const shortLeads=textPosition==='overWire'?planned.filter(p=>Math.abs(baseline-p.start[axis])+1e-6<textSpan(p.net)).map(p=>p.pin):[]
 const angles=textPosition==='overWire'?{left:0,right:180,up:270,down:90} as const:{left:180,right:0,up:90,down:270} as const
 const items=planned.map(({pin,net,start})=>{
  const end=[...start] as FlatPoint;end[axis]=baseline
  const at=[...end] as FlatPoint
  if(textPosition==='overWire')at[axis]=round(at[axis]-sign*Math.min(1.27,Math.abs(end[axis]-start[axis])/2))
  target.wire(start,end)
  return {pin,net,at,end,label:target.label(net,at,angles[direction])}
 })
 return {items,warnings:[...warnings,...(shortLeads.length?[{code:'LABEL_LEAD_SHORT' as const,pins:shortLeads}]:[])]}
}
