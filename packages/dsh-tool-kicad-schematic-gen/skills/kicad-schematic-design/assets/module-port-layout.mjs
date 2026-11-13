import {attachPinLabels,SCHEMATIC_GRID_MM} from './runtime.mjs';

const eps=1e-6, directions={'-1,0':'left','1,0':'right','0,-1':'up','0,1':'down'};
const same=(a,b)=>a.every((n,i)=>Math.abs(n-b[i])<eps);
const between=(n,a,b)=>n>=Math.min(a,b)-eps&&n<=Math.max(a,b)+eps;
const onWire=(p,{from,to})=>between(p[0],from[0],to[0])&&between(p[1],from[1],to[1])&&
 Math.abs((to[0]-from[0])*(p[1]-from[1])-(to[1]-from[1])*(p[0]-from[0]))<eps;
const box=(a,b,pad=0)=>({left:Math.min(a[0],b[0])-pad,right:Math.max(a[0],b[0])+pad,
 top:Math.min(a[1],b[1])-pad,bottom:Math.max(a[1],b[1])+pad});
const overlaps=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;
const toSheet=(at,origin)=>at.map((n,i)=>n+origin[i]);

/** Plan only free signal-pin stubs. Existing branches, explicit bends and cross-module wires retain their authored layout. */
export function planModulePortLabels(mod,ports,objects,powerNets,linked){
 const groups=new Map(),automatic=new Map(),issues=[],occupied=[];
 const wires=objects.filter(o=>o.type==='wire'&&o.from&&o.to);
 const attached=at=>wires.some(w=>onWire(at,w))||
  objects.some(o=>['label','global_label','hierarchical_label','no_connect'].includes(o.type)&&o.at&&same(o.at,at));
 const [x,y]=mod.region.origin,[width,height]=mod.region.size;
 const inside=b=>b.left>=x&&b.right<=x+width&&b.top>=y&&b.bottom<=y+height;
 for(const [name,port] of Object.entries(mod.ports)){
  const presentation=ports[name];
  if(Object.hasOwn(powerNets,port.net)||linked.has(name)||presentation.labelLayout==='manual')continue;
  const owner=objects.find(o=>o.reference===port.reference&&o.pins?.some(p=>p.number===port.pin));
  const pin=owner?.pins.find(p=>p.number===port.pin),direction=directions[pin?.outward?.join(',')];
  if(!direction||attached(pin.at)||objects.some(o=>o.pins?.some(p=>p!==pin&&same(p.at,pin.at))))continue;
  const axis=pin.outward[0]?0:1;
  if(presentation.labelAt){
   const at=toSheet(presentation.labelAt,mod.region.origin);
   if(attached(at)||Math.abs(at[1-axis]-pin.at[1-axis])>eps
      ||(at[axis]-pin.at[axis])*pin.outward[axis]<-eps)continue;
  }
  const key=[owner.uuid,direction,pin.at[axis]].join('/');
  const group=groups.get(key)??{owner,direction,axis,entries:[]};
  group.entries.push({name,port,pin,presentation});
  groups.set(key,group);
 }
 for(const {owner,direction,axis,entries} of groups.values()){
  // Stacked pins share a track. Leave the author in control of those connections.
  if(new Set(entries.map(entry=>entry.pin.at[1-axis])).size!==entries.length)continue;
  let accepted,blockingObject;
  for(const steps of [4,5,6]){
   const proposed=[];
   const pinFor=number=>entries.find(entry=>entry.pin.number===number).pin.at;
   const target={pin:(_reference,number)=>pinFor(number),wire:()=>{},label:(_net,_at,angle)=>angle};
   const {items}=attachPinLabels(target,{reference:owner.reference,direction,textPosition:'outside',length:steps*SCHEMATIC_GRID_MM,
    pins:entries.map(({port})=>({pin:port.pin,net:port.net}))});
   for(const item of items){
    const entry=entries.find(e=>e.pin.number===item.pin);
    const lead=box(entry.pin.at,item.end,0.08);
    // Conservative envelope for 1.27 mm text drawn outward from the endpoint.
    const tip=item.at.map((n,i)=>n+entry.pin.outward[i]*(Array.from(entry.port.net).length*1.27+0.64));
    const text=box(item.at,tip,0.85);
    const blocked=objects.find(o=>o.bounds&&!['rectangle','junction','no_connect'].includes(o.type)
      &&(overlaps(text,o.bounds)||(o.uuid!==owner.uuid&&overlaps(lead,o.bounds))));
    const crossesPin=objects.some(o=>o.pins?.some(p=>!same(p.at,entry.pin.at)&&onWire(p.at,{from:entry.pin.at,to:item.end})));
    if(!inside(lead)||!inside(text)||blocked||crossesPin||
       [...occupied,...proposed].some(p=>overlaps(text,p.text)||overlaps(text,p.lead)||overlaps(lead,p.text)||overlaps(lead,p.lead))){
     blockingObject=blocked;
     break;
    }
    proposed.push({entry,item,lead,text});
   }
   if(proposed.length===entries.length){accepted=proposed;break;}
  }
  if(accepted){
   for(const {entry,item} of accepted)automatic.set(entry.name,{at:item.at,angle:item.label});
   occupied.push(...accepted);
  }else{
   const points=entries.flatMap(({pin,presentation})=>[pin.at,...(presentation.labelAt?[toSheet(presentation.labelAt,mod.region.origin)]:[])]);
   issues.push({code:'PORT_LABEL_LAYOUT_REVIEW',reference:owner.reference,pins:entries.map(({port})=>({reference:port.reference,pin:port.pin})),
    bounds:box([Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1]))],[Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))],1.27),
    message:`No clear short aligned lead was found on this side${blockingObject?` near ${blockingObject.reference??blockingObject.name??blockingObject.type}${blockingObject.at?` at ${blockingObject.at.join(', ')} mm`:''}`:''}. Review the current labels or specify a deliberate manual layout.`});
  }
 }
 return {automatic,issues};
}
