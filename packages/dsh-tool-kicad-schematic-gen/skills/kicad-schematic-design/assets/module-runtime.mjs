/** Versioned contracts for independently authored modules. Trusted project code, not a sandbox. */
import {readFileSync,realpathSync,existsSync,statSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Schematic,templateDir,powerLibraryPath,validatePowerSymbolMapping} from './runtime.mjs';
import {validateReferencePatterns} from './pattern-references.mjs';
import {inspectPlanInputs,throwIssues} from './module-preflight.mjs';
import {createModuleDrawing} from './module-authoring.mjs';
import {describeSchematicReadability} from './module-layout.mjs';
import {assessModuleSpace} from './module-space.mjs';
import {inspectModuleReuse} from './module-reuse.mjs';
import {planModulePortLabels} from './module-port-layout.mjs';

export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message)=>{throw new Error(`${code}: ${message}`);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const point=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite);
const text=value=>typeof value==='string'&&value.trim().length>0;
const freeze=value=>{if(object(value)||Array.isArray(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
export function jsonFile(path){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)));}

export function preflightModuleReuse(contract,options){
 throwIssues(inspectModuleReuse(contract,projectPath,options));
}

/** All writable/project paths are relative to the manifest directory, including symlink checks. */
export function projectPath(contract,path){
 if(!text(path)||isAbsolute(path))fail('MODULE_PATH_INVALID',String(path));
 const target=resolve(contract.root,path),inside=p=>{const rel=relative(contract.root,p);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
 if(!inside(target))fail('MODULE_PATH_INVALID',path);
 let ancestor=target;
 while(!existsSync(ancestor)&&dirname(ancestor)!==ancestor)ancestor=dirname(ancestor);
 if(!inside(realpathSync(ancestor)))fail('MODULE_PATH_INVALID',`symlink escapes project: ${path}`);
 return target;
}

export async function loadModulePlan(path){
 const file=realpathSync(path),root=dirname(file),bytes=readFileSync(file),plan=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 const contract={file,root,plan,manifestSha256:digest(bytes)};
 if(plan.version!==1||!object(plan.project)||!text(plan.project.name)||!text(plan.project.title)
  ||!['A4','A3','A2','A1','A0'].includes(plan.project.paper)||!Array.isArray(plan.modules)||!plan.modules.length)
  fail('MODULE_PLAN_INVALID','version=1, project{name,title,paper} and nonempty modules are required');
 if(!Number.isSafeInteger(plan.maxParallel)||plan.maxParallel<1)fail('MODULE_PLAN_INVALID','maxParallel must be a positive safe integer');
 if(plan.project.compactLayout!==undefined&&typeof plan.project.compactLayout!=='boolean')
  fail('MODULE_PLAN_INVALID','project.compactLayout must be boolean');
 for(const field of ['sharedSources','resources','links'])if(!Array.isArray(plan[field]))fail('MODULE_PLAN_INVALID',`${field} must be an array`);
 for(const source of [plan.parts,...plan.sharedSources,...plan.resources])projectPath(contract,source);
 if(!['.json','.mjs'].includes(extname(plan.parts)))fail('MODULE_PLAN_INVALID','parts must be .json (recommended) or .mjs');
 for(const source of plan.sharedSources)if(extname(source)!=='.mjs')fail('MODULE_PLAN_INVALID','sharedSources must be .mjs files');
 // Import through the installed runtime's plugin location rather than discovering another installation.
 const plugin=process.env.DSH_SCHEMATIC_PLUGIN_DIR||resolve(dirname(realpathSync(new URL(import.meta.url))), '../../..');
 const builder=await import(pathToFileURL(resolve(plugin,'lib/builder.js')).href);
 contract.builderPath=resolve(plugin,'lib/builder.js');
 const brief={...plan.designPlan};
 if(text(brief.path)&&!isAbsolute(brief.path))brief.path=projectPath(contract,brief.path);
 contract.designPlan=builder.loadDesignPlan(brief);
 throwIssues(inspectPlanInputs(contract,projectPath));
 const ids=new Set(),refs=new Set(),voltages=new Map(),owned=new Set([plan.parts,...plan.sharedSources,...plan.resources].map(p=>projectPath(contract,p)));
 for(const mod of plan.modules){
  if(!/^[a-z][a-z0-9-]*$/.test(mod.id)||ids.has(mod.id)||!text(mod.goal)||!object(mod.references)||!Object.keys(mod.references).length||!object(mod.partRoles)
   ||!object(mod.nets)||!object(mod.ports)||!Object.keys(mod.ports).length||!object(mod.region)||!text(mod.region.name)||!text(mod.region.description)
   ||!point(mod.region.origin)||!point(mod.region.size)||mod.region.size.some(n=>n<=0)||!Array.isArray(mod.dependsOn)||!Array.isArray(mod.sources))
   fail('MODULE_PLAN_INVALID',`invalid module ${mod.id}`);
  ids.add(mod.id);
  if(mod.region.autoFit!==undefined&&typeof mod.region.autoFit!=='boolean')
   fail('MODULE_PLAN_INVALID',`${mod.id}: region.autoFit must be boolean`);
  if(mod.referencePatterns!==undefined)validateReferencePatterns(mod.referencePatterns);
  if(Object.keys(mod.references).sort().join('\0')!==Object.keys(mod.partRoles).sort().join('\0')||!Object.values(mod.partRoles).every(text))
   fail('MODULE_PLAN_INVALID',`${mod.id}: partRoles must map every reference role to a shared parts key`);
  for(const source of [mod.entry,...mod.sources]){
   const canonical=projectPath(contract,source);
   if(extname(canonical)!=='.mjs'||owned.has(canonical))fail('MODULE_FILE_CONFLICT',source);
   owned.add(canonical);
  }
  for(const ref of Object.values(mod.references)){
   if(!/^[A-Za-z]+[1-9][0-9]*$/.test(ref)||refs.has(ref))fail('MODULE_REFERENCE_CONFLICT',String(ref));
   refs.add(ref);
  }
  for(const net of Object.values(mod.nets))if(!text(net))fail('MODULE_PLAN_INVALID',`invalid net in ${mod.id}`);
  if(mod.expectedConnections!==undefined){
   if(!Array.isArray(mod.expectedConnections)||!mod.expectedConnections.length)fail('MODULE_CONNECTION_PLAN_INVALID',mod.id);
   const seen=new Set();
   for(const group of mod.expectedConnections){
    if(!text(group.net)||!Array.isArray(group.pins)||!group.pins.length
     ||(group.namePolicy!==undefined&&!['exact','connectivity'].includes(group.namePolicy)))fail('MODULE_CONNECTION_PLAN_INVALID',mod.id);
    if(group.namePolicy==='connectivity'&&(Object.keys(plan.power?.nets??{}).includes(group.net)||plan.modules.some(other=>Object.values(other?.ports??{}).some(p=>p?.net===group.net))))
     throwIssues([{code:'MODULE_CONNECTION_PLAN_INVALID',moduleId:mod.id,message:'public and power nets require exact names'}]);
    for(const p of group.pins){
     const key=`${p.reference}/${p.pin}`;
     if(!Object.values(mod.references).includes(p.reference)||!text(p.pin)||seen.has(key))fail('MODULE_CONNECTION_PLAN_INVALID',`${mod.id}: ${key}`);
     seen.add(key);
    }
   }
  }
  for(const [name,port] of Object.entries(mod.ports)){
   if(!object(port)||!Object.values(mod.references).includes(port.reference)||!text(port.pin)||!text(port.net)||!text(port.voltage))
    fail('MODULE_PORT_INVALID',`${mod.id}.${name} needs owned reference, pin, net, voltage`);
   if(voltages.has(port.net)&&voltages.get(port.net)!==port.voltage)fail('MODULE_LINK_INVALID',`public net ${port.net} has inconsistent voltage contracts`);
   voltages.set(port.net,port.voltage);
  }
  if(mod.expectedNoConnects!==undefined){
   if(!Array.isArray(mod.expectedNoConnects))fail('MODULE_NO_CONNECT_PLAN_INVALID',mod.id);
   const assigned=new Set([...Object.values(mod.ports),...(mod.expectedConnections??[]).flatMap(group=>group.pins)]
    .map(p=>`${p.reference}/${p.pin}`));
   for(const p of mod.expectedNoConnects){
    if(!object(p)||!Object.values(mod.references).includes(p.reference)||!text(p.pin))
     fail('MODULE_NO_CONNECT_PLAN_INVALID',`${mod.id}: expected an owned reference and physical pin number`);
    const key=`${p.reference}/${p.pin}`;
    if(assigned.has(key))fail('MODULE_NO_CONNECT_PLAN_INVALID',`${mod.id}: ${key} is repeated or already assigned to a net or port`);
    assigned.add(key);
   }
  }
 }
 const visiting=new Set(),visited=new Set();
 const visit=id=>{
  if(visiting.has(id))fail('MODULE_DEPENDENCY_CYCLE',id);
  if(visited.has(id))return;
  const mod=plan.modules.find(m=>m.id===id);if(!mod)fail('MODULE_DEPENDENCY_MISSING',id);
  visiting.add(id);for(const dep of mod.dependsOn)visit(dep);visiting.delete(id);visited.add(id);
 };for(const id of ids)visit(id);
 for(const link of plan.links){
  const lookup=end=>plan.modules.find(m=>m.id===end?.module)?.ports[end?.port];
  const a=lookup(link.from),b=lookup(link.to);
  const route=Number.isFinite(link.laneX)?link.via===undefined:Array.isArray(link.via)&&link.via.every(point);
  if(!a||!b||a.net!==b.net||a.voltage!==b.voltage||!route)
   fail('MODULE_LINK_INVALID','link endpoints must exist and agree on net and voltage; provide laneX or via[]');
 }
 if(!object(plan.power)||!object(plan.power.nets)||!Object.keys(plan.power.nets).length)fail('MODULE_PLAN_INVALID','power.nets required');
 if(plan.power.library!=='bundled')projectPath(contract,plan.power.library);
 return contract;
}

export function moduleById(contract,id){
 const mod=contract.plan.modules.find(m=>m.id===id);
 if(!mod)fail('MODULE_NOT_FOUND',id);
 return mod;
}
export const moduleReportPath=(contract,id)=>projectPath(contract,`work/modules/${id}/check.json`);
const libraryPath=contract=>contract.plan.power.library==='bundled'?powerLibraryPath:projectPath(contract,contract.plan.power.library);

/** Scope plan changes to this module and declared dependencies; shared inputs remain conservative. */
export function moduleContractSha256(contract,id){
 const visited=new Set(),modules=[];
 const visit=key=>{if(visited.has(key))return;visited.add(key);const mod=moduleById(contract,key);modules.push(mod);for(const dep of mod.dependsOn)visit(dep);};
 visit(id);modules.sort((a,b)=>a.id.localeCompare(b.id));
 const {project,designPlan,parts,sharedSources,resources,power}=contract.plan;
 const {compactLayout,...moduleProject}=project;
 const shared=[parts,...sharedSources,...resources].sort().map(path=>({path,sha256:digest(readFileSync(projectPath(contract,path)))}));
 return digest(JSON.stringify({version:2,project:moduleProject,designPlan,parts,sharedSources,resources,power,modules,shared}));
}

/** Snapshot explicitly declared transitive inputs; unlisted dynamic imports are unsupported. */
export function moduleInputs(contract,id){
 const sources=new Set([contract.plan.parts,...contract.plan.sharedSources]);
 const visited=new Set();
 const visit=key=>{if(visited.has(key))return;visited.add(key);const mod=moduleById(contract,key);sources.add(mod.entry);for(const src of mod.sources)sources.add(src);for(const dep of mod.dependsOn)visit(dep);};
 visit(id);
 const files=[...sources,...contract.plan.resources].sort().map(path=>({path,sha256:digest(readFileSync(projectPath(contract,path)))}));
 files.push({path:'$power',sha256:digest(readFileSync(libraryPath(contract)))});
 for(const [path,file] of [['$moduleRuntime',new URL(import.meta.url)],['$moduleAuthoring',new URL('./module-authoring.mjs',import.meta.url)],['$moduleTemplates',new URL('./module-templates.mjs',import.meta.url)],['$moduleCircuit',new URL('./module-circuit.mjs',import.meta.url)],['$modulePreflight',new URL('./module-preflight.mjs',import.meta.url)],['$moduleSpace',new URL('./module-space.mjs',import.meta.url)],['$moduleNetlist',new URL('./module-netlist.mjs',import.meta.url)],['$moduleLayout',new URL('./module-layout.mjs',import.meta.url)],['$runtime',new URL('./runtime.mjs',import.meta.url)],['$builder',contract.builderPath]])files.push({path,sha256:digest(readFileSync(file))});
 files.push({path:'$modulePortLayout',sha256:digest(readFileSync(new URL('./module-port-layout.mjs',import.meta.url)))});
 return {sha256:digest(JSON.stringify({contract:moduleContractSha256(contract,id),files})),files,sources:[...sources]};
}

export function preflightModule(contract,id){
 const inputs=moduleInputs(contract,id);
 for(const path of inputs.sources){
  const file=projectPath(contract,path);
  try{new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file));}
  catch{fail('MODULE_INVALID_UTF8',path);}
  if(extname(file)==='.json')continue;
  const check=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});
  if(check.status!==0)fail('MODULE_SYNTAX_ERROR',`${path}: ${check.error?.message||check.stderr}`);
 }
 return inputs;
}

/** JSON parts paths are relative to the manifest, never the shell cwd or plugin installation. */
export async function loadConfirmedParts(contract){
 const source=projectPath(contract,contract.plan.parts);
 let raw;
 try{
  new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(source));
  if(extname(source)==='.json')raw=jsonFile(source);
  else{
   // Legacy executable catalogs use a fresh process: never reuse stale ESM imports in a long-lived DSH host.
   const read=spawnSync(process.execPath,['--input-type=module','-e',
    "const {parts}=await import(process.argv[1]);process.stdout.write(JSON.stringify(parts));",pathToFileURL(source).href],
    {encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});
   if(read.status!==0)throw new Error(read.error?.message||read.stderr);
   raw=JSON.parse(read.stdout);
  }
 }catch(error){fail('MODULE_PARTS_INVALID',`${contract.plan.parts}: ${error.message}`);}
 if(!object(raw))fail('MODULE_PARTS_INVALID','parts must contain a keyed object');
 const parts={},issues=[];
 for(const [key,part] of Object.entries(raw)){
  if(!object(part)){issues.push({code:'MODULE_PARTS_INVALID',path:key,message:'expected an object'});continue;}
  try{
   const path=realpathSync(isAbsolute(part.libraryPath||'')?part.libraryPath:projectPath(contract,part.libraryPath));
   const inside=relative(contract.root,path);
   if(inside.startsWith('..')||isAbsolute(inside)||!existsSync(path))throw new Error(`symbol library is missing or outside the project: ${path}`);
   if(!contract.plan.resources.some(resource=>realpathSync(projectPath(contract,resource))===path))throw new Error(`declare symbol library ${path} in resources so checks are version-bound`);
   parts[key]={...part,libraryPath:realpathSync(path)};
  }catch(error){issues.push({code:'MODULE_PART_LIBRARY_INVALID',path:key,message:error.message});}
 }
 throwIssues(issues);return freeze(parts);
}

/** Validate confirmed symbols and every public port in memory; no candidate files or layout inference. */
export async function preflightConfirmedParts(contract,{requireValues=false,checkSpace=false}={}){
 const parts=await loadConfirmedParts(contract),issues=[];
 for(const [net,libId] of Object.entries(contract.plan.power.nets)){
  try{validatePowerSymbolMapping({libraryPath:libraryPath(contract),nets:{[net]:libId}});}
  catch(error){issues.push({code:'POWER_SYMBOL_MAPPING_INVALID',path:`power.nets.${net}`,
   message:error.message,expectedNet:net,actualValue:error.actualValue??null,libId,
   nextAction:'Parent must reconcile the confirmed net and symbol Value before dispatch; do not rename or merge power domains silently.'});}
 }
 const probe=new Schematic({projectName:'parts_preflight',title:'Parts input validation',paper:'A4',templateDir,
  designPlan:{path:contract.designPlan.path,sha256:contract.designPlan.sha256}});
 const valid=new Set(),checkedValues=new Set();
 for(const mod of contract.plan.modules)for(const [role,reference] of Object.entries(mod.references)){
  const part=parts[mod.partRoles[role]];
  if(!part){issues.push({code:'MODULE_PARTS_INVALID',moduleId:mod.id,message:`${reference}: missing parts.${mod.partRoles[role]}`});continue;}
  const key=mod.partRoles[role];
  if(requireValues&&!checkedValues.has(key)){
   checkedValues.add(key);
   if(!text(part.value)||/^(R(?:_US)?|C|L|D|LED)$/i.test(part.value.trim()))
    issues.push({code:'MODULE_PART_VALUE_REQUIRED',moduleId:mod.id,path:`parts.${key}.value`,
     message:`${reference}: fill parts.${key}.value with the confirmed component value/model before delegation; do not use a generic symbol name`});
  }
  try{
   const {pins,units,...symbol}=part;
   for(const unit of units??[part.unit??1])probe.addSymbol({...symbol,unit,reference,at:[50.8,50.8]});
   valid.add(reference);
   for(const [name,number] of Object.entries(pins??{})){
    try{probe.pin(reference,number);}
    catch(error){issues.push({code:'MODULE_PART_PIN_INVALID',moduleId:mod.id,message:`${reference} parts pin ${name}: ${error.message}`});}
   }
  }catch(error){issues.push({code:'MODULE_PART_INVALID',moduleId:mod.id,message:`${reference}: ${error.message}`});}
 }
 for(const mod of contract.plan.modules)for(const [name,port] of Object.entries(mod.ports)){
  if(!valid.has(port.reference))continue;
  try{probe.pin(port.reference,port.pin);}
  catch(error){issues.push({code:'MODULE_PORT_PIN_INVALID',moduleId:mod.id,message:`${name}: ${error.message}`});}
 }
 for(const mod of contract.plan.modules)for(const group of mod.expectedConnections??[])for(const pin of group.pins){
  if(!valid.has(pin.reference))continue;
  try{probe.pin(pin.reference,pin.pin);}
  catch(error){issues.push({code:'MODULE_CONNECTION_PIN_INVALID',moduleId:mod.id,message:`${group.net}: ${error.message}`});}
 }
 for(const mod of contract.plan.modules)for(const {reference,pin} of mod.expectedNoConnects??[]){
  if(!valid.has(reference))continue;
  try{probe.pin(reference,pin);}
  catch(error){issues.push({code:'MODULE_NO_CONNECT_PLAN_INVALID',moduleId:mod.id,message:`${reference}.${pin}: ${error.message}`});}
 }
 if(checkSpace&&!issues.length){
  const catalog=probe.pinCatalog({includeBounds:true}),style=jsonFile(new URL('../templates/frame-style.json',import.meta.url));
  contract.spaceAssessment=contract.plan.modules.map(mod=>assessModuleSpace(mod,catalog,style,{paper:contract.plan.project.paper}));
  for(const assessment of contract.spaceAssessment)if(assessment.status==='insufficient')issues.push({
   code:'MODULE_SPACE_INSUFFICIENT',moduleId:assessment.moduleId,message:'Fixed pin geometry does not fit the available frame content area; parent must review the frame before dispatch.',...assessment});
 }
 throwIssues(issues);return parts;
}

/** Exact native geometry at origin, before worker placement; no circuit inference. */
export function describeModuleParts(contract,mod,parts){
 const probe=new Schematic({projectName:'module_geometry',title:'Module geometry',paper:'A4',templateDir,
  designPlan:{path:contract.designPlan.path,sha256:contract.designPlan.sha256}});
 for(const [role,reference] of Object.entries(mod.references)){
  const {pins,units,angle,mirror,...symbol}=parts[mod.partRoles[role]];
  for(const unit of units??[symbol.unit??1])probe.addSymbol({...symbol,reference,unit,angle:0,at:[50.8,50.8]});
 }
 const relativePoint=at=>at.map(v=>Number((v-50.8).toFixed(8)));
 return probe.pinCatalog({includeBounds:true}).map(o=>({reference:o.reference,libId:o.libId,unit:o.unit,
  bounds:o.bounds?Object.fromEntries(Object.entries(o.bounds).map(([k,v])=>[k,Number((v-50.8).toFixed(8))])):undefined,
  fields:o.fields?.map(field=>({...field,at:relativePoint(field.at)})),
  pins:o.pins?.map(p=>({...p,at:relativePoint(p.at)}))}));
}

/** A passed claim is usable only with real, project-local candidate files. Not visual/electrical approval. */
export function assertModuleArtifacts(contract,id,report){
 let candidate;
 for(const key of ['schematicPath','projectPath']){
  const file=report.result?.[key];
  if(!text(file)||!isAbsolute(file))fail('MODULE_ARTIFACT_MISSING',`${id}: ${key}`);
  const base=realpathSync(projectPath(contract,`work/modules/${id}`));
  let actual;
  try{actual=realpathSync(file);if(!statSync(actual).isFile())throw new Error();}
  catch{fail('MODULE_ARTIFACT_MISSING',`${id}: ${key} ${file}`);}
  const rel=relative(base,actual);
  const extension=key==='schematicPath'?'.kicad_sch':'.kicad_pro';
  if(!/^candidate-[A-Za-z0-9_-]+[/\\][^/\\]+$/.test(rel)||extname(actual)!==extension||isAbsolute(rel)
   ||(candidate&&candidate!==dirname(actual)))fail('MODULE_ARTIFACT_INVALID',`${id}: ${key} must be in the same candidate directory`);
  candidate=dirname(actual);
 }
}

export function assertModuleReports(contract){
 const reports=[];
 for(const mod of contract.plan.modules){
  let report;
  try{report=jsonFile(moduleReportPath(contract,mod.id));}catch{fail('MODULE_REPORT_MISSING',mod.id);}
  if(report.version!==1||report.moduleId!==mod.id||report.status!=='passed')fail('MODULE_CHECK_FAILED',mod.id);
  if(report.inputSha256!==moduleInputs(contract,mod.id).sha256)fail('MODULE_RESULT_STALE',mod.id);
  assertModuleArtifacts(contract,mod.id,report);
  reports.push({moduleId:mod.id,inputSha256:report.inputSha256,durationMs:report.durationMs});
 }
 return reports;
}

/** Local workflow evidence, not a security boundary or proof of electrical correctness. */
export function assertModuleDispatch(contract){
 let state;
 try{state=jsonFile(projectPath(contract,'work/module-dispatch.json'));}
 catch{fail('MODULE_DELEGATION_REQUIRED','call dispatch_kicad_module_tasks to start real module workers before assembly');}
 if(state.version!==1||state.manifestSha256!==contract.manifestSha256||!Array.isArray(state.entries))
  fail('MODULE_DISPATCH_STALE','dispatch state does not match this module plan');
 for(const mod of contract.plan.modules){
  const entry=state.entries.find(e=>e.moduleId===mod.id);
  if(!entry?.agentId||entry.status!=='completed')fail('MODULE_DELEGATION_INCOMPLETE',mod.id);
  if(entry.inputSha256!==moduleInputs(contract,mod.id).sha256)fail('MODULE_DISPATCH_STALE',mod.id);
 }
 return state.entries.map(({moduleId,agentId})=>({moduleId,agentId}));
}

function guardedRegion(region,mod,parts,powerNets){
 const placed=new Set(),references=new Set(Object.values(mod.references));let placing=true;
 const objectUuids=new Set();
 const remember=id=>{objectUuids.add(id);return id;};
 const wiringIssues=[];
 const allowedNets=new Set([...Object.values(mod.nets),...Object.values(mod.ports).map(p=>p.net)]);
 const powerStyles=new Map(),publicPowerLabels=new Set();
 const own=reference=>{if(!references.has(reference))fail('MODULE_REFERENCE_UNDECLARED',`${mod.id}: ${reference}`);};
 const endpoint=point=>{if(object(point))own(point.reference);};
 const label=(name,at,angle,style,isPublic=false)=>{
  if(!allowedNets.has(name)&&!name.startsWith(`${mod.id}__`))fail('MODULE_NET_UNDECLARED',`${mod.id}: ${name}`);
  const power=Object.hasOwn(powerNets,name);
  if(style!==undefined&&(!power||!['symbol','label'].includes(style)))fail('MODULE_POWER_STYLE_INVALID',`${mod.id}: ${name} requires a mapped power net and powerStyle symbol or label`);
  endpoint(at);
  const id=remember(region.label(name,at,angle));
  if(style!==undefined)powerStyles.set(id,style);
  if(power&&isPublic)publicPowerLabels.add(id);
  return id;
 };
 const wire=(method,a,b,route)=>{
  endpoint(a);endpoint(b);
  try{return region[method](a,b,route).map(remember);}
  catch(error){
   if(!/WIRE_ROUTE_INVALID|wire collapses|wire needs nonzero orthogonal/.test(error.message))throw error;
   wiringIssues.push({code:'WIRE_ROUTE_INVALID',moduleId:mod.id,from:a,to:b,route:route??[],message:error.message});
   return []; // Collect independent route defects; assertWiring prevents saving this partial sheet.
  }
 };
 const methods={
  at:at=>region.at(at),
  addSymbol:spec=>{
   if(!placing)fail('MODULE_PLACEMENT_PHASE',mod.id);own(spec.reference);
   const role=Object.keys(mod.references).find(role=>mod.references[role]===spec.reference),part=parts[mod.partRoles[role]];
   if(!part||spec.libId!==part.libId||spec.footprint!==part.footprint||!text(spec.libraryPath)||realpathSync(spec.libraryPath)!==realpathSync(part.libraryPath))
    fail('MODULE_PART_MISMATCH',`${mod.id}: ${spec.reference} must use confirmed parts.${mod.partRoles[role]} symbol and footprint`);
   placed.add(spec.reference);return remember(region.addSymbol(spec));
  },
  pin:(reference,pin)=>{own(reference);return region.pin(reference,pin);},
  wire:(a,b,via)=>wire('wire',a,b,via),
  wireOrthogonal:(a,b,route)=>wire('wireOrthogonal',a,b,route),
  label,
  marker:(kind,at)=>{endpoint(at);return remember(region.marker(kind,at));},
 };
 return {region:Object.freeze(methods),placed,objectUuids,remember,powerStyles,publicPowerLabels,finishPlacement(){placing=false;},assertWiring(){
  if(wiringIssues.length)throw Object.assign(new Error(`WIRE_ROUTE_INVALID: fix all ${wiringIssues.length} invalid routes in ${mod.id}`),
   {code:'WIRE_ROUTE_INVALID',issues:wiringIssues});
 }};
}

async function placeModule(contract,sch,mod,parts,seriesPins){
 const api=await import(pathToFileURL(projectPath(contract,mod.entry)).href);
 if(typeof api.place!=='function')fail('MODULE_EXPORT_INVALID',mod.id);
 const guard=guardedRegion(sch.region(mod.region),mod,parts,contract.plan.power.nets);
 const result=await api.place({region:guard.region,draw:createModuleDrawing(guard.region,parts,mod,seriesPins),parts,references:Object.freeze({...mod.references}),
  allocateReference:role=>{if(!mod.references[role])fail('MODULE_REFERENCE_UNDECLARED',`${mod.id}: use a declared role, not a prefix`);return mod.references[role];},
  nets:Object.freeze({...mod.nets}),bounds:structuredClone(mod.region)});
 guard.finishPlacement();
 for(const reference of Object.values(mod.references))if(!guard.placed.has(reference))fail('MODULE_REFERENCE_MISSING',`${mod.id}: ${reference}`);
 if(!object(result)||!object(result.ports)||typeof result.connect!=='function')fail('MODULE_EXPORT_INVALID',`${mod.id}: return ports and connect()`);
 if(Object.keys(result.ports).sort().join('\0')!==Object.keys(mod.ports).sort().join('\0'))fail('MODULE_PORT_MISMATCH',mod.id);
 for(const [name,expected] of Object.entries(mod.ports)){
  const actual=result.ports[name];
  if(actual?.reference!==expected.reference||actual?.pin!==expected.pin)fail('MODULE_PORT_MISMATCH',`${mod.id}.${name}`);
  sch.pin(actual.reference,actual.pin);
  if(actual.labelAt!==undefined&&(!point(actual.labelAt)||actual.labelAt.some((v,i)=>v<0||v>mod.region.size[i])))
   fail('MODULE_PORT_LAYOUT_INVALID',`${mod.id}.${name}: labelAt must be a local point inside the region`);
  if(actual.angle!==undefined&&![0,90,180,270].includes(actual.angle))fail('MODULE_PORT_LAYOUT_INVALID',`${mod.id}.${name}: invalid angle`);
  if(actual.labelLayout!==undefined&&!['auto','manual'].includes(actual.labelLayout))
   fail('MODULE_PORT_LAYOUT_INVALID',`${mod.id}.${name}: labelLayout must be auto or manual`);
 }
 return {mod,result,guard};
}

/** Two phases in a shared sheet; only this function owns public port labels and cross-module wires. */
export async function buildModules(contract,outputDirectory,{moduleId}={}){
 const selected=moduleId?[moduleById(contract,moduleId)]:contract.plan.modules;
 const powerNets=moduleId?Object.fromEntries(Object.entries(contract.plan.power.nets)
  .filter(([net])=>Object.values(selected[0].nets).includes(net)||Object.values(selected[0].ports).some(p=>p.net===net))):contract.plan.power.nets;
 const sch=new Schematic({projectName:contract.plan.project.name,title:contract.plan.project.title,paper:contract.plan.project.paper,
  templateDir,designPlan:{path:contract.designPlan.path,sha256:contract.designPlan.sha256},requiredPowerSymbols:powerNets});
 const parts=await preflightConfirmedParts(contract);
 const nativePins=new Map();
 const seriesPins=({libraryPath,libId},unit)=>{
  const key=JSON.stringify([libraryPath,libId,unit]);
  if(!nativePins.has(key)){
   const probe=new Schematic({projectName:'series_geometry',title:'Series pin geometry',paper:contract.plan.project.paper,
    templateDir,designPlan:{path:contract.designPlan.path,sha256:contract.designPlan.sha256}});
   probe.addSymbol({libraryPath,libId,reference:'U1',at:[0,0],unit});
   nativePins.set(key,probe.pinCatalog({includeBounds:true})[0].pins);
  }
  return nativePins.get(key);
 };
 const all=[],portLabelIssues=[];
 for(const mod of selected)all.push(await placeModule(contract,sch,mod,parts,seriesPins));
 for(const {mod,result,guard} of all){
  await result.connect();
  guard.assertWiring();
 }
 for(const {mod,result,guard} of all){
  const linked=new Set(contract.plan.links.flatMap(link=>[link.from,link.to]).filter(end=>end.module===mod.id).map(end=>end.port));
  const layout=planModulePortLabels(mod,result.ports,sch.layoutObjects(),powerNets,linked);
  portLabelIssues.push(...layout.issues);
  for(const [name,port] of Object.entries(mod.ports)){
   const presentation=result.ports[name],pin=sch.pin(port.reference,port.pin);
   const automatic=layout.automatic.get(name);
   const at=automatic?.at??(presentation.labelAt?presentation.labelAt.map((v,i)=>v+mod.region.origin[i]):pin);
   if(at.some((v,i)=>Math.abs(v-pin[i])>1e-7)){
    const bend=[at[0],pin[1]];
    const route=[pin,bend,at].filter((p,i,a)=>i===0||p.some((v,j)=>Math.abs(v-a[i-1][j])>1e-7));
    sch.wire(route[0],route.at(-1),route.slice(1,-1)).forEach(guard.remember);
   }
   guard.region.label(port.net,at.map((v,i)=>v-mod.region.origin[i]),automatic?.angle??presentation.angle??0,presentation.powerStyle,true);
  }
 }
 if(!moduleId)for(const link of contract.plan.links){
  const port=end=>moduleById(contract,end.module).ports[end.port];
  const a=port(link.from),b=port(link.to);
  const start=sch.pin(a.reference,a.pin),end=sch.pin(b.reference,b.pin);
  const via=Number.isFinite(link.laneX)?[[link.laneX,start[1]],[link.laneX,end[1]]]:link.via;
  // A horizontal route needs no repeated bend when both real pins share one Y coordinate.
  const route=[start,...via,end].filter((p,i,all)=>i===0||p[0]!==all[i-1][0]||p[1]!==all[i-1][1]);
  sch.wire(route[0],route.at(-1),route.slice(1,-1));
 }
 const ownerByReference=new Map(all.flatMap(({mod,guard})=>Object.values(mod.references).map(reference=>[reference,guard])));
 for(const {reference,uuid} of sch.ensureNoConnectMarkers(selected.flatMap(mod=>mod.expectedNoConnects??[])))
  ownerByReference.get(reference)?.remember(uuid);
 const powerNames=Object.keys(powerNets),keepAsLocalLabels=new Set();
 const powerSpec=powerNames.length?{libraryPath:libraryPath(contract),nets:powerNets,keepAsLocalLabels}:undefined;
 const styles=all.flatMap(({guard})=>[...guard.powerStyles]);
 const prefer=['symbol','label'].flatMap(style=>styles.filter(([,value])=>value===style).map(([id])=>id));
 const publicDefaults=all.flatMap(({guard})=>[...guard.publicPowerLabels].filter(id=>!guard.powerStyles.has(id)));
 const removedPowerAnnotations=powerSpec?sch.deduplicatePowerLabels(powerNames,all.map(({guard})=>guard.objectUuids),[...new Set([...prefer,...publicDefaults])]):[];
 for(const uuid of removedPowerAnnotations)for(const {guard} of all)guard.objectUuids.delete(uuid);
 if(powerSpec){
  const labels=sch.powerLabelCatalog(powerNames);
  for(const {guard} of all)for(const net of powerNames){
   const group=labels.filter(l=>l.net===net&&guard.objectUuids.has(l.uuid));
   const explicit=group.some(l=>guard.powerStyles.get(l.uuid)==='symbol');
   const automatic=group.filter(l=>!guard.powerStyles.has(l.uuid));
   const main=explicit?undefined:automatic.find(l=>guard.publicPowerLabels.has(l.uuid))??automatic[0];
   for(const label of group)if(label!==main&&guard.powerStyles.get(label.uuid)!=='symbol')keepAsLocalLabels.add(label.uuid);
  }
 }
 // Plan power symbols in the reserved space. The final frame follows the actual replacement geometry.
 const powerPlan=powerSpec&&sch.planPowerPlacements(powerSpec);
 for(const {mod,guard} of all)if(mod.region.autoFit!==false)sch.fitRegionFrame(mod.region.name,guard.objectUuids);
 let powerSymbols=[];
 if(powerSpec&&powerPlan){
  powerSymbols=sch.replacePowerLabels({...powerSpec,placements:powerPlan.placements});
 }
 let pagePacking;
 if(!moduleId){
  pagePacking=contract.plan.project.compactLayout===false?{status:'unchanged',reason:'disabled'}:
   contract.plan.links.length?{status:'unchanged',reason:'explicit_cross_module_wires'}:
    sch.compactModuleRegions(all.map(({mod,guard})=>({name:mod.region.name,objectUuids:guard.objectUuids})));
  if(pagePacking.status==='packed'){
   const shifts=new Map(all.flatMap(({mod,guard})=>[...guard.objectUuids].map(id=>[id,pagePacking.shifts[mod.region.name]])));
   powerSymbols=powerSymbols.map(symbol=>({...symbol,at:symbol.at.map((v,i)=>Number((v+shifts.get(symbol.uuid)[i]).toFixed(6)))}));
  }
 }
 const saved=sch.save(outputDirectory);
 const readability=moduleId?undefined:await describeSchematicReadability(contract,saved);
 return {...saved,...(moduleId?{portLabelIssues}:{}),...(readability?{readability}:{}),...(pagePacking?{pagePacking}:{}),powerSymbols,modules:selected.map((mod,index)=>({id:mod.id,
  frame:saved.frames[index],
  ports:Object.fromEntries(Object.entries(mod.ports).map(([name,port])=>[name,{...port,at:sch.pin(port.reference,port.pin)}]))}))};
}

export async function assembleDesign(manifestPath,outputDirectory){
 const contract=await loadModulePlan(manifestPath);
 const checks=assertModuleReports(contract);
 if(process.env.DSH_SCHEMATIC_MODULE_MODE==='delegated')assertModuleDispatch(contract);
 const result=await buildModules(contract,outputDirectory);
 // Detect changes during the build, not just old results on entry.
 const latest=await loadModulePlan(manifestPath);
 if(latest.manifestSha256!==contract.manifestSha256)fail('MODULE_RESULT_STALE','manifest changed during assembly');
 assertModuleReports(latest);
 return {...result,moduleChecks:checks};
}
