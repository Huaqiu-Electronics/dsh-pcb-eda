/** Collect independent configuration defects before any module worker or circuit code runs. */
import {existsSync,statSync} from 'node:fs';

export function throwIssues(issues){
 if(!issues.length)return;
 const code=issues.length===1?issues[0].code:'MODULE_PLAN_PREFLIGHT_FAILED';
 const error=new Error(`${code}: fix these ${issues.length} configuration issue(s) together before dispatch/build:\n`
  +issues.map(issue=>`${issue.code} [${issue.moduleId||issue.path||'project'}]: ${issue.message}`).join('\n'));
 error.code=code;error.issues=issues;throw error;
}

export function inspectPlanInputs(contract,projectPath){
 const {plan}=contract,issues=[];
 const add=(code,message,extra={})=>issues.push({code,message,...extra});
 const refs=new Set(),names=new Set(),voltages=new Map();
 const page={A4:[297,210],A3:[420,297],A2:[594,420],A1:[841,594],A0:[1189,841]}[plan.project.paper];
 const onGrid=n=>Number.isFinite(n)&&Math.abs(n/1.27-Math.round(n/1.27))<1e-6;
 const boxes=[];
 for(const mod of plan.modules){
  if(!mod||typeof mod!=='object')continue;
  for(const ref of Object.values(mod.references||{})){
   if(!/^[A-Za-z]+[1-9][0-9]*$/.test(ref)||refs.has(ref))add('MODULE_REFERENCE_CONFLICT',`invalid or repeated reference ${ref}`,{moduleId:mod.id});
   refs.add(ref);
  }
  if(!mod.ports||typeof mod.ports!=='object'||!Object.keys(mod.ports).length)
   add('MODULE_PORT_INVALID',`modules.${mod.id}.ports must declare at least one public port`,{moduleId:mod.id});
  const allowedNets=new Set([...Object.values(mod.nets||{}),...Object.values(mod.ports||{}).map(p=>p?.net)]);
  const plannedPins=new Map();
  for(const group of Array.isArray(mod.expectedConnections)?mod.expectedConnections:[]){
   if(group?.namePolicy!==undefined&&!['exact','connectivity'].includes(group.namePolicy))
    add('MODULE_CONNECTION_PLAN_INVALID','namePolicy must be exact or connectivity',{moduleId:mod.id});
   if(group?.namePolicy==='connectivity'&&(Object.keys(plan.power?.nets??{}).includes(group.net)
    ||plan.modules.some(other=>Object.values(other?.ports??{}).some(p=>p?.net===group.net))))
    add('MODULE_CONNECTION_PLAN_INVALID','public and power nets require exact names',{moduleId:mod.id});
   if(typeof group?.net==='string'&&!allowedNets.has(group.net)&&!group.net.startsWith(`${mod.id}__`))
    add('MODULE_NET_UNDECLARED',`expectedConnections net ${group.net} must be declared in modules.${mod.id}.nets or ports`,{moduleId:mod.id});
   for(const pin of Array.isArray(group?.pins)?group.pins:[]){
    const key=`${pin?.reference}.${pin?.pin}`;
    if(plannedPins.has(key)&&plannedPins.get(key)!==group.net)
     add('MODULE_PIN_NET_CONFLICT',`${key} is assigned to both ${plannedPins.get(key)} and ${group.net}`,{moduleId:mod.id});
    plannedPins.set(key,group.net);
   }
  }
  for(const [name,port] of Object.entries(mod.ports||{})){
   if(!port||!Object.values(mod.references||{}).includes(port.reference)||typeof port.pin!=='string'||!port.pin||!port.net||!port.voltage)
    add('MODULE_PORT_INVALID',`port ${name} must name an owned reference, real pin, net and voltage`,{moduleId:mod.id});
   else{
    const key=`${port.reference}.${port.pin}`;
    if(plannedPins.has(key)&&plannedPins.get(key)!==port.net)
     add('MODULE_PORT_CONNECTION_CONFLICT',`${name}: ${key} port net ${port.net} conflicts with expectedConnections net ${plannedPins.get(key)}`,{moduleId:mod.id});
    else plannedPins.set(key,port.net);
    if(voltages.has(port.net)&&voltages.get(port.net)!==port.voltage)add('MODULE_LINK_INVALID',`public net ${port.net} has inconsistent voltage contracts`,{moduleId:mod.id});
    voltages.set(port.net,port.voltage);
   }
  }
  const region=mod.region;
  if(!region||!Array.isArray(region.origin)||!Array.isArray(region.size)||region.origin.length!==2||region.size.length!==2)continue;
  const coords=[...region.origin,...region.size];
  if(!coords.every(onGrid))add('MODULE_LAYOUT_OFF_GRID','origin and size must use 1.27 mm grid; fix the shared layout before placing symbols',{moduleId:mod.id});
  if(!coords.every(Number.isFinite)||region.size.some(n=>n<=0))continue;
  const [x,y]=region.origin,[w,h]=region.size,box={id:mod.id,x,y,right:x+w,bottom:y+h};
  if(x<0||y<0||box.right>page[0]+1e-6||box.bottom>page[1]+1e-6)add('MODULE_LAYOUT_OUTSIDE_PAGE',`frame extends beyond ${plan.project.paper} ${page.join('x')} mm`,{moduleId:mod.id});
  if(names.has(region.name))add('MODULE_LAYOUT_NAME_CONFLICT',`duplicate frame name ${region.name}`,{moduleId:mod.id});
  names.add(region.name);
  for(const other of boxes)if(x<other.right-1e-6&&box.right>other.x+1e-6&&y<other.bottom-1e-6&&box.bottom>other.y+1e-6)
   add('MODULE_LAYOUT_OVERLAP',`frame overlaps ${other.id}; adjust shared origin/size and route channels together`,{moduleId:mod.id});
  boxes.push(box);
 }
 for(const path of new Set([plan.parts,...plan.sharedSources,...plan.resources,...(plan.power?.library&&plan.power.library!=='bundled'?[plan.power.library]:[])])){
  try{
   const file=projectPath(contract,path);
   if(!existsSync(file)||!statSync(file).isFile())add('MODULE_RESOURCE_MISSING','required input file does not exist; reuse imported paths instead of guessing a drive',{path});
  }catch(error){add('MODULE_PATH_INVALID',error.message,{path});}
 }
 return issues;
}
