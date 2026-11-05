/** Small role-based helpers. Circuit topology and routing remain explicit in the module script. */
const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
export function createModuleDrawing(region,parts,mod){
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
 return Object.freeze({
  put(role,placement){
   const {pins,units,...symbol}=part(role);
   const allowed=['at','angle','mirror','unit','referenceAt','valueAt','fieldAngle','hideReference','hideValue'];
   if(!placement||Object.keys(placement).some(key=>!allowed.includes(key)))throw new Error('MODULE_PLACEMENT_INVALID: use placement/field options only; confirmed identity and value are fixed');
   return region.addSymbol({...symbol,...placement,reference:mod.references[role]});
  },
  pin,offset,
  row(start,count,step=10.16){
   if(!Number.isInteger(count)||count<1||count>100||!Number.isFinite(step))throw new Error('MODULE_ROW_INVALID');
   return Array.from({length:count},(_,i)=>offset(start,i*step,0));
  },
  wire:(a,b,route={axis:'x'})=>region.wireOrthogonal(a,b,route),
  stub(role,pinRole,dx,dy,{net,angle=0}={}){
   const start=pin(role,pinRole),end=offset(start,dx,dy);
   region.wireOrthogonal(start,end,{axis:'x'});
   if(net!==undefined)region.label(net,end,angle);
   return end;
  },
  label:(net,at,angle=0)=>region.label(net,at,angle),
  junction:at=>region.marker('junction',at),
  nc:(role,name)=>region.marker('no_connect',pin(role,name)),
 });
}

/** An intentionally incomplete starter cannot pass as a generated circuit. Never overwrite an existing script. */
export function moduleStarter(mod){
 const ports=Object.fromEntries(Object.entries(mod.ports).map(([name,p])=>[name,{reference:p.reference,pin:p.pin}]));
 return `/** ${mod.id}: fill confirmed placement and wiring; coordinates are local mm. */\nexport function place({draw,nets,bounds}){\n // Roles: ${Object.entries(mod.references).map(([role,ref])=>`${role}=${ref}`).join(', ')}\n // draw.put(role,{at:[x,y],angle:0}); draw.pin(role,pinRole);\n // draw.offset(at,dx,dy); draw.row(start,count,step);\n // draw.wire(a,b,{axis:'x'}); draw.label(net,at); draw.junction(at); draw.nc(role,pinRole);\n throw new Error('MODULE_IMPLEMENTATION_REQUIRED: fill this module placement and connections');\n return {bounds,ports:${JSON.stringify(ports,null,2)},connect(){\n  // Resolve draw.pin here; draw.stub(role,pinRole,dx,dy,{net}) keeps lead/label attached after moves.\n }};\n}\n`;
}
