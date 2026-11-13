/** Compare explicit expected pin memberships against a real KiCad XML netlist. */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const decode=s=>s.replace(/&(quot|apos|lt|gt|amp);/g,(_,x)=>({quot:'"',apos:"'",lt:'<',gt:'>',amp:'&'}[x])).replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_,x)=>String.fromCodePoint(x[0].toLowerCase()==='x'?parseInt(x.slice(1),16):Number(x)));
const attrs=s=>Object.fromEntries([...s.matchAll(/([a-z_]+)="([^"]*)"/gi)].map(m=>[m[1],decode(m[2])]));
export function compareConnections(xml,expected){
 if(!/<export[\s>]/.test(xml)||!/<nets[\s>]/.test(xml))throw new Error('MODULE_NETLIST_INVALID: expected KiCad XML export with nets');
 const nets=[...xml.matchAll(/<net\s+([^>]+)>([\s\S]*?)<\/net>/g)].map(m=>({name:attrs(m[1]).name,pins:new Set([...m[2].matchAll(/<node\s+([^>]+)\/?>/g)].map(n=>{const a=attrs(n[1]);return JSON.stringify([a.ref,a.pin]);}))}));
 const issues=[],warnings=[],owners=new Map();
 const key=pin=>JSON.stringify([pin.reference,pin.pin]);
 for(const group of expected)for(const pin of group.pins)for(const net of nets)if(net.pins.has(key(pin))){
  const names=owners.get(net)??new Set();names.add(group.net);owners.set(net,names);
 }
 for(const [net,names] of owners)if(names.size>1)issues.push({code:'MODULE_NET_MERGED',actualNet:net.name,expectedNets:[...names],message:'Pins from distinct declared nets are connected together'});
 for(const group of expected){
  const actual=nets.find(n=>n.name===group.net)||nets.find(n=>n.name===`/${group.net}`);
  if(actual&&group.pins.every(pin=>actual.pins.has(key(pin))))continue;
  const common=nets.filter(n=>group.pins.every(pin=>n.pins.has(key(pin))));
  if(common.length===1){
   const issue={code:'MODULE_NET_NAME_MISMATCH',net:group.net,actualNet:common[0].name,pins:group.pins,...(group.pins.length===1?group.pins[0]:{}),message:'Declared pins share an actual net but the required name differs; verify intended membership before changing its label'};
   // Only an explicitly opted-in internal net may use KiCad's generated name.
   if(group.namePolicy==='connectivity')warnings.push(issue);else issues.push(issue);
   continue;
  }
  for(const pin of group.pins)if(!actual?.pins.has(key(pin))){
   const actualNets=nets.filter(n=>n.pins.has(key(pin))).map(n=>n.name);
   issues.push({code:actualNets.some(name=>expected.some(g=>g.net!==group.net&&(g.net===name||`/${g.net}`===name)))?'MODULE_CONNECTION_WRONG_NET':'MODULE_CONNECTION_MISSING',net:group.net,...pin,actualNets});
  }
 }
 return {status:issues.length?'failed':'passed',checkedPins:expected.reduce((n,g)=>n+g.pins.length,0),issues,warnings,
  limitations:'Checks declared memberships and merging between distinct declared nets; not undeclared shorts, complete connectivity or circuit validity.'};
}
export async function checkModuleConnections(contract,mod,result,output,kicadCliPath){
 const {resolveKiCadPaths,inspectSchematicObjects,inspectNoConnectPins}=await import(pathToFileURL(contract.builderPath));
 const objects=inspectSchematicObjects(readFileSync(result.schematicPath,'utf8'));
 const {targets,issues:ncIssues}=inspectNoConnectPins(objects,mod.expectedNoConnects);
 for(const {reference,pin,marker} of targets)if(!marker)
  ncIssues.push({code:'MODULE_NO_CONNECT_MARKER_MISSING',reference,pin,message:'The pin requires a native KiCad no-connect marker.'});
 if(!mod.expectedConnections){
  if(targets.length||ncIssues.length)return {status:ncIssues.length?'failed':'passed',checkedPins:0,checkedNoConnects:targets.length,issues:ncIssues,warnings:[]};
  return {status:'not_requested',nextAction:'Declare expectedConnections in the shared module plan to check real pin membership before visual review.'};
 }
 const file=join(output,'module-netlist.xml');
 const cli=kicadCliPath||resolveKiCadPaths().kicadCliPath;
 const run=spawnSync(cli,['sch','export','netlist','--format','kicadxml','-o',file,result.schematicPath],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 if(run.status!==0)throw new Error(`MODULE_NETLIST_EXPORT_FAILED: ${run.error?.message||run.stderr||run.stdout}`);
 const checked=compareConnections(readFileSync(file,'utf8'),mod.expectedConnections);
 return {...checked,issues:[...checked.issues,...ncIssues],status:ncIssues.length?'failed':checked.status,
  ...(targets.length?{checkedNoConnects:targets.length}:{}),path:file};
}
