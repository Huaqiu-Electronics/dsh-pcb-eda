/** Keep a latest report and an immutable record of each attempt in the same workspace. */
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {dirname,basename,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export function writeReport(path,value){
 const reportPath=resolve(path),historyDir=join(dirname(reportPath),'report-history');
 mkdirSync(historyDir,{recursive:true});
 const unique=()=>join(historyDir,`${basename(reportPath,'.json')}-${Date.now()}-${randomUUID()}.json`);
 if(existsSync(reportPath)){
  const old=readFileSync(reportPath);
  let archived=false;
  try{const parsed=JSON.parse(old.toString('utf8'));archived=typeof parsed.historyPath==='string'&&existsSync(parsed.historyPath)&&old.equals(readFileSync(parsed.historyPath));}catch{}
  if(!archived)writeFileSync(unique(),old,{flag:'wx'});
 }
 const historyPath=unique(),report={...value,reportPath,historyPath};
 const text=JSON.stringify(report,null,2)+'\n';
 writeFileSync(historyPath,text,{encoding:'utf8',flag:'wx'});
 writeFileSync(reportPath,text,'utf8');
 return report;
}

export function buildFailure(preflight,stderr){
 if(preflight.status==='failed')return {code:preflight.code,stage:preflight.stage,issues:preflight.issues??[]};
 let code=/\b(?:Error|SyntaxError):\s*([A-Z][A-Z0-9_]+):/.exec(stderr)?.[1];
 if(!code)code=/duplicate instance:/.test(stderr)?'MODULE_REFERENCE_CONFLICT'
  :/non-orthogonal wire|wire needs nonzero orthogonal|wire collapses on the 50 mil/.test(stderr)?'WIRE_ROUTE_INVALID'
  :/region .+ overlaps/.test(stderr)?'MODULE_LAYOUT_OVERLAP':'SCRIPT_EXECUTION_FAILED';
 const stage=code.startsWith('MODULE_DELEGATION')?'route':code.includes('LAYOUT')||code==='POWER_PLACEMENT_UNAVAILABLE'?'layout'
  :code==='ENOENT'?'parts':code==='WIRE_ROUTE_INVALID'?'wiring':'build';
 return {code,stage,issues:[]};
}

export function recovery(failure){
 const {code}=failure;
 if(code.startsWith('MODULE_DELEGATION')||code==='MODULE_DISPATCH_STALE')return 'Stop patching or rebuilding the full schematic script. Create/read module-plan.json, call dispatch_kicad_module_tasks (it includes preflight), wait for actual workers, then assemble with --modules. The route stays bound to this design even after merging frames or renaming scripts. A real delegation limitation or focused existing-design edit needs an explicit --sequential-reason; do not invent a reason to bypass the route.';
 if(code==='MODULE_PLAN_PREFLIGHT_FAILED'||code.startsWith('MODULE_LAYOUT')||code==='MODULE_RESOURCE_MISSING'||code==='MODULE_PART_LIBRARY_INVALID')return 'Read every preflight issue and fix the shared layout/library/port configuration together before dispatching or rebuilding. Do not fix only the first item and restart the full design.';
 if(code==='ENOENT')return 'Check all confirmed library paths together. Use project-relative paths in parts.json or exact import results; do not guess C:/D: drives or search the host. Run module preflight before rebuilding.';
 if(code==='MODULE_REFERENCE_CONFLICT')return 'Fix the shared role-to-reference table and all affected module uses together; do not renumber only the last failing instance in the full script.';
 if(code==='WIRE_ROUTE_INVALID')return 'Fix all reported route issues together. Resolve real pins inside connect(), use draw.offset/draw.stub for attached leads and labels, and explicit axis or lanes for wires. Moving a component must not leave old coordinate literals behind; do not retry zero-length or diagonal segments unchanged.';
 if(code==='POWER_PLACEMENT_UNAVAILABLE')return 'Fix all listed blocked power placements in one module/layout edit. Reserve space for the symbol, value and title clearance; move the source label/stub or enlarge its frame, preserving the required power nets. Recheck only the affected module; do not remove required symbols or retry unchanged.';
 return null;
}
