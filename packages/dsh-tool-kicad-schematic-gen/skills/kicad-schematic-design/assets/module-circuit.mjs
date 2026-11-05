/** Circuit recipes with deterministic drawing slots; no part selection or inferred pin mapping. */
import {placeHeader,placePullupRc} from './module-templates.mjs';
const fail=message=>{throw new Error(`MODULE_CIRCUIT_INVALID: ${message}`);};
const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const same=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-7);
function component(args,spec,at){
 const part=args.parts[spec?.partKey],reference=args.references[spec?.role];
 if(!part||!reference)fail('component needs a confirmed partKey and reference role');
 const {pins,units,...symbol}=part;
 if(units?.length>1)fail('multi-unit component requires custom drawing');
 args.region.addSymbol({...symbol,reference,at,...(spec.angle===undefined?{}:{angle:spec.angle})});
 return {reference,pins:spec.pins??pins,at};
}
function pin(args,item,name){
 const number=item.pins?.[name];if(typeof number!=='string'||!number)fail(`${item.reference}: explicit ${name} pin required`);
 return args.region.pin(item.reference,number);
}
function vertical(args,item,top,bottom){
 const a=pin(args,item,top),b=pin(args,item,bottom);
 if(Math.abs(a[0]-b[0])>1e-7||a[1]>=b[1])fail(`${item.reference}: requires ${top} above ${bottom}; choose a supported angle or custom drawing`);
 return {top:a,bottom:b};
}
function wire(args,a,b){if(!same(a,b))args.region.wireOrthogonal(a,b,{axis:'x'});}
function lead(args,item,name,net,ports,portName){
 if(typeof net!=='string'||!net)fail(`${name}: network required`);
 const p=pin(args,item,name),dx=p[0]-item.at[0],dy=p[1]-item.at[1];
 if(Math.abs(dx)<1e-7&&Math.abs(dy)<1e-7)fail(`${item.reference}: pin at body center requires custom lead`);
 const horizontal=Math.abs(dx)>=Math.abs(dy);
 const end=[p[0]+(horizontal?Math.sign(dx)*10.16:0),p[1]+(horizontal?0:Math.sign(dy)*10.16)];
 if(portName)ports[portName]={reference:item.reference,pin:item.pins[name],labelAt:end,angle:horizontal&&dx>0?180:0};
 return ()=>{if(!portName){wire(args,p,end);args.region.label(net,end,horizontal&&dx>0?180:0);}};
}
function ldo(args,block){
 if(block.confirmed!==true||!block.supply||!block.output||!block.ground)fail('confirm fixed LDO topology, capacitor requirements and power nets');
 const u=component(args,block.regulator,[55.88,35.56]);
 const mapped=Object.values(u.pins??{});
 if(new Set(mapped).size!==mapped.length)fail('regulator semantic pins must be distinct; list each physical output pin separately');
 const ci=component(args,block.inputCap,[20.32,40.64]),co=component(args,block.outputCap,[91.44,40.64]);
 const cip=vertical(args,ci,'top','bottom'),cop=vertical(args,co,'top','bottom'),ports={},connections=[];
 for(const [name,net] of [['vin',block.supply],['vout',block.output],['gnd',block.ground]])connections.push(lead(args,u,name,net,ports,block.ports?.[name]));
 for(const name of block.additionalOutputs??[])connections.push(lead(args,u,name,block.output,ports));
 if(u.pins.enable){
  if(block.enable!=='input')fail('enable pin requires explicit enable:"input" confirmation or custom drawing');
  connections.push(lead(args,u,'enable',block.supply,ports));
 }
 for(const [cap,p,net] of [[ci,cip,block.supply],[co,cop,block.output]]){
  connections.push(()=>{const top=[p.top[0],p.top[1]-7.62],bottom=[p.bottom[0],p.bottom[1]+7.62];
   wire(args,p.top,top);args.region.label(net,top);wire(args,p.bottom,bottom);args.region.label(block.ground,bottom);});
 }
 return {ports,connect(){for(const fn of connections)fn();if(u.pins.nc)args.region.marker('no_connect',pin(args,u,'nc'));}};
}
function led(args,block){
 if(block.confirmed!==true||!block.supply||!block.ground||!block.seriesNet)fail('confirm LED polarity, resistor value and seriesNet');
 const r=component(args,block.resistor,[35.56,25.4]),d=component(args,block.led,[35.56,50.8]);
 if(d.pins?.anode===d.pins?.cathode)fail('LED anode and cathode must be distinct');
 const rp=vertical(args,r,'top','bottom'),dp=vertical(args,d,'anode','cathode');
 if(dp.top[1]<=rp.bottom[1])fail('LED overlaps series resistor; requires custom drawing');
 return {ports:{},connect(){
  const top=[rp.top[0],rp.top[1]-7.62],bottom=[dp.bottom[0],dp.bottom[1]+7.62];
  wire(args,rp.top,top);args.region.label(block.supply,top);
  wire(args,rp.bottom,dp.top);args.region.label(block.seriesNet,rp.bottom);
  wire(args,dp.bottom,bottom);args.region.label(block.ground,bottom);
 }};
}
const templates={header:placeHeader,'pullup-rc':placePullupRc,'ldo-fixed':ldo,'led-indicator':led};
const sizes={header:[114.3,86.36],'pullup-rc':[86.36,86.36],'ldo-fixed':[114.3,86.36],'led-indicator':[76.2,86.36]};

/** Recipes omit physical coordinates. Slots are stacked vertically; insufficient space is explicit. */
export function placeModuleCircuit(args,recipe){
 if(recipe?.version!==1||!Array.isArray(recipe.blocks)||!recipe.blocks.length)fail('version:1 and blocks required');
 let y=0;const used=new Set(),ports={},results=[];
 // Check capacity before mutating the schematic; no silent scaling or frame changes.
 let height=0;
 for(const b of recipe.blocks){const size=sizes[b.kind];if(!size||!templates[b.kind])fail(`unsupported template ${b.kind}`);
  if(args.bounds.size[0]<size[0])fail(`frame too narrow for ${b.kind}; ask parent to enlarge`);height+=size[1];}
 if(args.bounds.size[1]<height)fail('frame too short for recipe; ask parent to enlarge or split modules');
 for(const block of recipe.blocks){
  const offset=y,translate=p=>{if(!point(p))fail('template produced an invalid point');return [p[0],p[1]+offset];};
  const region={
   addSymbol:s=>{if(used.has(s.reference))fail(`duplicate component ${s.reference}`);used.add(s.reference);
    const spec={...s,at:translate(s.at)};for(const k of ['referenceAt','valueAt'])if(s[k])spec[k]=translate(s[k]);return args.region.addSymbol(spec);},
   pin:(r,p)=>{const at=args.region.pin(r,p);return [at[0],at[1]-offset];},
   wire:(a,b,via=[])=>args.region.wire(translate(a),translate(b),via.map(translate)),
   wireOrthogonal:(a,b,route)=>args.region.wireOrthogonal(translate(a),translate(b),{...route,...(route?.laneY===undefined?{}:{laneY:route.laneY+offset})}),
   label:(net,at,angle)=>args.region.label(net,translate(at),angle),marker:(kind,at)=>args.region.marker(kind,translate(at)),
  };
  const result=templates[block.kind]({...args,region},block);
  for(const [name,p] of Object.entries(result.ports)){
   if(ports[name])fail(`duplicate public port ${name}`);
   ports[name]={...p,labelAt:translate(p.labelAt)};
  }
  results.push(result);y+=sizes[block.kind][1];
 }
 return {bounds:args.bounds,ports,connect(){for(const r of results)r.connect();}};
}
