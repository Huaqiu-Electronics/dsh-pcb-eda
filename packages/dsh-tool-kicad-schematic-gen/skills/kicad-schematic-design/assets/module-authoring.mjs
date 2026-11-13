/** Small role-based helpers. Circuit topology and routing remain explicit in the module script. */
import {snapGrid,SCHEMATIC_GRID_MM} from './runtime.mjs';

const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const angles=[0,90,180,270];
const round=n=>Number(n.toFixed(8));
export function createModuleDrawing(region,parts,mod,seriesPins){
 const part=role=>{
  const entry=parts[mod.partRoles[role]];
  if(!entry||!mod.references[role])throw new Error(`MODULE_ROLE_INVALID: ${role}`);
  return entry;
 };
 const offset=(at,dx,dy)=>{
  if(!point(at)||![dx,dy].every(Number.isFinite))throw new Error('MODULE_POINT_INVALID');
  return at.map((v,i)=>Number((v+[dx,dy][i]).toFixed(8)));
 };
 const pin=(role,name)=>{
  const number=part(role).pins?.[name];
  if(typeof number!=='string')throw new Error(`MODULE_PIN_ROLE_INVALID: ${role}.${name}`);
  return region.pin(mod.references[role],number);
 };
 const stub=(start,dx,dy,{net,angle=0,powerStyle}={})=>{
  const end=offset(start,dx,dy);
  if(dx!==0||dy!==0)region.wireOrthogonal(start,end,{axis:'x'});
  if(net!==undefined)region.label(net,end,angle,powerStyle);
  return end;
 };
 const put=(role,placement)=>{
  const {pins,units,...symbol}=part(role);
  const allowed=['at','angle','mirror','unit','referenceAt','valueAt','referenceOffset','valueOffset','fieldAngle','hideReference','hideValue'];
  if(!placement||Object.keys(placement).some(key=>!allowed.includes(key)))throw new Error('MODULE_PLACEMENT_INVALID: use placement/field options only; confirmed identity and value are fixed');
  return region.addSymbol({...symbol,...placement,reference:mod.references[role]});
 };
 return Object.freeze({
  put,
  putSeries(role,{from,input,output,...placement}){
   const {at,angle,unit,mirror}=placement,symbol=part(role);
   const invalid=reason=>{throw new Error(`MODULE_SERIES_PLACEMENT_INVALID: ${mod.id}.${role}: ${reason}`);};
   if(!point(from)||!point(at)||angle!==undefined&&!angles.includes(angle))invalid('provide a real source pin, a preferred position, and a cardinal angle if needed');
   const inputNumber=symbol.pins?.[input],outputNumber=symbol.pins?.[output];
   const native=seriesPins(symbol,unit??symbol.unit??1);
   const entry=native.find(p=>p.number===inputNumber),exit=native.find(p=>p.number===outputNumber);
   if(native.length!==2||!entry||!exit||entry===exit)invalid('select both distinct semantic pin roles of a two-pin symbol');

   const preferred=at.map((n,i)=>round(snapGrid(n+mod.region.origin[i])-mod.region.origin[i]));
   const delta=preferred.map((n,i)=>n-from[i]);
   const axes=Math.abs(delta[0])>=Math.abs(delta[1])?[0,1]:[1,0];
   const axisMirror=mirror??symbol.mirror;
   for(const axis of axes){
    if(!delta[axis])continue;
    const cross=1-axis,direction=Math.sign(delta[axis]);
    for(const candidate of angle===undefined?angles:[angle]){
     const rad=candidate*Math.PI/180;
     // Native positions are already in sheet axes (positive Y down).
     const rotate=([x,y])=>[
      round((x*Math.cos(rad)+y*Math.sin(rad))*(axisMirror==='y'?-1:1)),
      round((-x*Math.sin(rad)+y*Math.cos(rad))*(axisMirror==='x'?-1:1)),
     ];
     const a=rotate(entry.at),b=rotate(exit.at),outward=rotate(entry.outward),otherOutward=rotate(exit.outward);
     if(a[cross]!==b[cross]||outward[axis]!==-direction||otherOutward[axis]!==direction)continue;
     const aligned=[...preferred];
     aligned[cross]=round(from[cross]-a[cross]);
     if(direction*(aligned[axis]+a[axis]-from[axis])<SCHEMATIC_GRID_MM-1e-7)continue;
     if([aligned,...[a,b].map(p=>p.map((n,i)=>round(n+aligned[i])))].some(p=>p.some((n,i)=>n<0||n>mod.region.size[i])))continue;
     return put(role,{...placement,at:aligned,angle:candidate});
    }
   }
   return invalid('no straight approach within the module frame; move the preferred position or use draw.put and route explicitly');
  },
  pin,offset,
  row(start,count,step=10.16){
   if(!Number.isInteger(count)||count<1||count>100||!Number.isFinite(step))throw new Error('MODULE_ROW_INVALID');
   return Array.from({length:count},(_,i)=>offset(start,i*step,0));
  },
  wire:(a,b,route={axis:'x'})=>region.wireOrthogonal(a,b,route),
  wirePins(from,to,route={axis:'x'}){
   return region.wireOrthogonal(region.pin(from.reference,from.pin),region.pin(to.reference,to.pin),route);
  },
  stub(role,pinRole,dx,dy,options){return stub(pin(role,pinRole),dx,dy,options);},
  pinStub(reference,number,dx,dy,options){
   return stub(region.pin(reference,number),dx,dy,options);
  },
  label:(net,at,angle=0,options)=>region.label(net,at,angle,options?.powerStyle),
  junction:at=>region.marker('junction',at),
  nc:(role,name)=>region.marker('no_connect',pin(role,name)),
  ncPin:(reference,number)=>region.marker('no_connect',region.pin(reference,number)),
 });
}

/** An intentionally incomplete starter cannot pass as a generated circuit. Never overwrite an existing script. */
export function moduleStarter(mod){
 const ports=Object.fromEntries(Object.entries(mod.ports).map(([name,p])=>[name,{reference:p.reference,pin:p.pin,
  ...(p.labelAt?{labelAt:p.labelAt,angle:p.angle??0}:{})}]));
 const publicNets=new Set(Object.values(mod.ports).map(port=>port.net));
 const anchors=(mod.expectedConnections??[]).filter(group=>group.namePolicy!=='connectivity'&&!publicNets.has(group.net));
 const labels=anchors.map(({net,pins:[anchor]})=>
  `  // draw.pinStub(${JSON.stringify(anchor.reference)},${JSON.stringify(anchor.pin)},dx,dy,{net:${JSON.stringify(net)}});`).join('\n');
 const placements=Object.entries(mod.references).map(([role,ref])=>` // draw.put(${JSON.stringify(role)}, {at:[x,y]}); // ${ref}`).join('\n');
 return `/** ${mod.id}: fill confirmed placement and wiring; coordinates are local mm. */
export function place({draw,region,references,nets,bounds}){
${placements}
 throw new Error('MODULE_IMPLEMENTATION_REQUIRED: fill this module placement and connections');
 return {bounds,ports:${JSON.stringify(ports,null,2)},connect(){
  // Follow the confirmed nets in task.md. Resolve endpoints after placement.
  // Use draw.pin(role,pinRole) or region.pin(references.role,physicalPin).
  // draw.wirePins({reference,pin},{reference,pin},{axis:'x'}) for direct links.
  // draw.ncPin(reference,pin) for pins explicitly confirmed as unconnected.
  // Optional label anchors for named internal nets. Choose offsets and wire the remaining pins.
${labels}
 }};
}
`;
}
