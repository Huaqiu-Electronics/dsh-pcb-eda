/** Parameterized drawing only: topology and actual pin mappings must already be confirmed. */
const fail=message=>{throw new Error(`MODULE_TEMPLATE_INVALID: ${message}`);};
const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const equal=(a,b)=>a.every((n,i)=>Math.abs(n-b[i])<1e-7);
function part(args,key,role,at,angle){
 const spec=args.parts[key],reference=args.references[role];
 if(!spec||!reference||!point(at))fail('confirmed part key, reference role and position required');
 const {pins,units,...symbol}=spec;
 if(units?.length>1)fail('multi-unit symbols require a custom module');
 args.region.addSymbol({...symbol,reference,at,...(angle===undefined?{}:{angle})});
 return {reference,pins};
}
function present(args,ports){
 for(const [name,p] of Object.entries(ports)){
  if(!p||!Object.values(args.references).includes(p.reference)||typeof p.pin!=='string'||!point(p.labelAt))fail(`invalid port ${name}`);
 }
 return ports;
}

/** Map every header pin explicitly. Only planar left/right pin rows are supported. */
export function placeHeader(args,{partKey,role,at=[40.64,35.56],pinNets,ports={},confirmed=false,lead=7.62}){
 if(!confirmed||!pinNets||!Object.keys(pinNets).length||!Number.isFinite(lead)||lead<=0)fail('confirm header pin assignment and positive lead');
 const item=part(args,partKey,role,at),returned={},connections=[];
 const usedPorts=new Set();
 for(const [pin,net] of Object.entries(pinNets)){
  if(typeof net!=='string'||!net)fail(`missing net for ${pin}`);
  const p=args.region.pin(item.reference,pin);
  if(Math.abs(p[0]-at[0])<1e-7)fail('header must have left/right pins; use custom drawing for top/bottom pins');
  const left=p[0]<at[0],end=[p[0]+(left?-lead:lead),p[1]];
  const names=Object.keys(ports).filter(name=>ports[name]===pin);
  if(names.length>1)fail(`multiple ports on header pin ${pin}`);
  if(names.length){const name=names[0];usedPorts.add(name);returned[name]={reference:item.reference,pin,labelAt:end,angle:left?0:180};}
  else connections.push({p,end,net,angle:left?0:180});
 }
 if(usedPorts.size!==Object.keys(ports).length)fail('every public header port must occur in pinNets');
 return {bounds:args.bounds,ports:present(args,returned),connect(){
  for(const {p,end,net,angle} of connections){args.region.wire(p,end);args.region.label(net,end,angle);}
 }};
}

/** Pullup + shunt capacitor; no button, active driver or electrical-value inference. */
export function placePullupRc(args,{resistorKey,capacitorKey,resistorRole,capacitorRole,
 resistorAt=[25.4,25.4],capacitorAt=[45.72,45.72],supply,ground,signalPort='signal',confirmed=false}){
 if(!confirmed||!supply||!ground)fail('confirm pullup/shunt-capacitor topology and named power nets');
 const r=part(args,resistorKey,resistorRole,resistorAt),c=part(args,capacitorKey,capacitorRole,capacitorAt);
 const vertical=item=>{
  if(!item.pins?.top||!item.pins?.bottom)fail('parts must map top and bottom pins');
  const a=args.region.pin(item.reference,item.pins.top),b=args.region.pin(item.reference,item.pins.bottom);
  if(Math.abs(a[0]-b[0])>1e-7||a[1]>=b[1])fail('requires a vertical symbol with top above bottom');
  return {top:a,bottom:b};
 };
 const rp=vertical(r),cp=vertical(c);
 const node=[rp.bottom[0],cp.top[1]],end=[cp.top[0]+10.16,cp.top[1]];
 if(node[1]<=rp.bottom[1]||cp.top[0]<=rp.bottom[0])fail('capacitor must be below/right of pullup');
 return {bounds:args.bounds,ports:present(args,{[signalPort]:{reference:r.reference,pin:r.pins.bottom,labelAt:end,angle:0}}),connect(){
  const source=[rp.top[0],rp.top[1]-7.62],gnd=[cp.bottom[0],cp.bottom[1]+7.62];
  args.region.wire(rp.top,source);args.region.label(supply,source);
  args.region.wire(rp.bottom,node);if(!equal(node,cp.top))args.region.wire(node,cp.top);
  args.region.marker('junction',cp.top);
  args.region.wire(cp.bottom,gnd);args.region.label(ground,gnd);
 }};
}
