/** Run a project script without shell quoting, redirection encodings or output truncation. */
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeReport,buildFailure,recovery} from '../assets/reporting.mjs';
import {generationRoute,requireModuleRoute} from '../assets/generation-route.mjs';
const plugin=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const {readDesignPlan,loadDesignPlan}=await import(new URL('../../../lib/builder.js',import.meta.url));
if(process.argv[2]==='--read-plan'){
 const plan=readDesignPlan(process.argv[3]);
 console.log(JSON.stringify({designPlan:{path:plan.path,sha256:plan.sha256},generationRoute:generationRoute(plan),content:plan.text,nextAction:'Read this saved plan. For independent functions prepare module-plan.json and dispatch workers before circuit scripts. A recorded delegated route persists across merged frames, new scripts and plan revisions. Pass --plan and --plan-sha256; update and reread changed design decisions.'}));
 process.exit(0);
}
const [script,output,report,...args]=process.argv.slice(2);
const extra=[];let planPath,planHash,modulePlanPath,sequentialReason;
for(let i=0;i<args.length;i++){
 if(args[i]==='--plan')planPath=args[++i];
 else if(args[i]==='--plan-sha256')planHash=args[++i];
 else if(args[i]==='--modules'){
  modulePlanPath=args[++i];if(!modulePlanPath)throw new Error('MODULE_PLAN_REQUIRED: --modules needs a manifest path');
 }
 else if(args[i]==='--sequential-reason'){
  sequentialReason=args[++i];if(!sequentialReason?.trim())throw new Error('SEQUENTIAL_REASON_REQUIRED: give the actual reason for not delegating');
 }
 else extra.push(args[i]);
}
const plan=loadDesignPlan({path:planPath,sha256:planHash});
const designPlan={path:plan.path,sha256:plan.sha256};
if(!script||!output||!report)throw new Error('Usage: node run-design.mjs <design.mjs> <candidate-directory> <report.json> --plan <saved-plan.md> --plan-sha256 <sha256> [--modules <module-plan.json>] [--sequential-reason <actual-reason>] [script arguments]');
const started=performance.now();
const scriptPath=resolve(script);
let scriptSha256=null;
// Validate source without executing it. UTF-8 validity does not prove that text is free of mojibake.
let preflight;
try{
 const route=generationRoute(plan);
 if(route.required&&!modulePlanPath&&!sequentialReason)
  preflight={status:'failed',stage:'route',code:'MODULE_DELEGATION_REQUIRED',file:route.statePath,
   message:'MODULE_DELEGATION_REQUIRED: this design already requires module delegation. Merging frames, renaming the script/report or updating the brief does not change its functional scope. Prepare module-plan.json, dispatch actual workers, then assemble with --modules.'};
 if(!preflight){
 const bytes=readFileSync(scriptPath);
 scriptSha256=createHash('sha256').update(bytes).digest('hex');
 try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 catch{preflight={status:'failed',stage:'encoding',code:'SCRIPT_INVALID_UTF8',file:scriptPath,
  message:'Entry script is not valid UTF-8. Restore the last correct source and use explicit UTF-8 reading AND writing; do not re-encode already corrupted text.'};}
 if(!preflight){
  const checked=spawnSync(process.execPath,['--check',scriptPath],{
   encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024,
  });
  preflight=checked.status===0
   ?{status:'passed',stage:'syntax',file:scriptPath}
   :{status:'failed',stage:'syntax',code:checked.error?'SCRIPT_CHECK_FAILED':'SCRIPT_SYNTAX_ERROR',file:scriptPath,
    message:checked.error?.message||checked.stderr||checked.stdout||'Node syntax check failed.'};
 }
 }
}catch(error){
 preflight={status:'failed',stage:'read',code:error.message.startsWith('MODULE_ROUTE_STATE_INVALID')?'MODULE_ROUTE_STATE_INVALID':'SCRIPT_READ_FAILED',file:scriptPath,message:error.message};
}
preflight.durationMs=Math.round(performance.now()-started);
let moduleChecks,moduleDispatch;
const generationMode={mode:sequentialReason?'sequential':modulePlanPath?'delegated':'default',...(sequentialReason?{reason:sequentialReason}:{})};
if(preflight.status==='passed'&&modulePlanPath){
 try{
  const {loadModulePlan,preflightConfirmedParts,assertModuleReports,assertModuleDispatch}=await import('../assets/module-runtime.mjs');
  const contract=await loadModulePlan(resolve(modulePlanPath));
  if(contract.designPlan.path!==plan.path||contract.designPlan.sha256!==plan.sha256)throw new Error('MODULE_PLAN_MISMATCH: runner and modules must use the same saved plan');
  if(generationRoute(plan).required&&contract.plan.modules.length<2&&!sequentialReason)
   throw new Error('MODULE_DELEGATION_REQUIRED: this recorded multi-function design needs independent module contracts; merging everything into one module does not resolve its route');
  if(contract.plan.modules.length>1)requireModuleRoute(plan,'confirmed module manifest');
  await preflightConfirmedParts(contract);
  moduleChecks=assertModuleReports(contract);
  if(!sequentialReason)moduleDispatch=assertModuleDispatch(contract);
 }catch(error){preflight={status:'failed',stage:'modules',code:error.code||error.message.split(':')[0],issues:error.issues||[],file:resolve(modulePlanPath),message:error.message,durationMs:Math.round(performance.now()-started)};}
}
const result=preflight.status==='failed'
 ?{status:1,stdout:'',stderr:preflight.message,signal:null,error:undefined}
 :spawnSync(process.execPath,[scriptPath,resolve(output),...extra],{
 encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,
 env:{...process.env,DSH_SCHEMATIC_PLUGIN_DIR:process.env.DSH_SCHEMATIC_PLUGIN_DIR||plugin,DSH_DESIGN_BRIEF_PATH:plan.path,DSH_DESIGN_BRIEF_SHA256:plan.sha256,
  ...(modulePlanPath?{DSH_MODULE_PLAN_PATH:resolve(modulePlanPath)}:{DSH_MODULE_PLAN_PATH:''}),DSH_SCHEMATIC_MODULE_MODE:generationMode.mode},
});
const reportPath=resolve(report);
const durationMs=Math.round(performance.now()-started);
const isResult=data=>data&&typeof data==='object'&&!Array.isArray(data)
 &&typeof data.schematicPath==='string'&&data.schematicPath.trim()
 &&typeof data.projectPath==='string'&&data.projectPath.trim();
let summary=null,summaryStatus='unavailable',summaryError=null;
let data;
try{const parsed=JSON.parse(result.stdout??'');if(isResult(parsed))data=parsed;}catch{}
if(data)summaryStatus='ready';
else{
 // Recover one unambiguous result from older JSON-lines scripts without hiding their logs.
 const results=[];
 for(const line of (result.stdout??'').split(/\r?\n/)){
  try{const parsed=JSON.parse(line);if(isResult(parsed))results.push(parsed);}catch{}
 }
 if(results.length===1){data=results[0];summaryStatus='recovered';}
 else summaryError=result.status!==0
  ?'No unambiguous build result; the script failed or was interrupted. Fix stderr/error before changing its output format.'
  :results.length>1?'Multiple build results in stdout; emit exactly one result JSON.'
   :'No build result with schematicPath and projectPath in stdout; emit one result JSON and send logs to stderr.';
}
if(data){
 const final=data.powerLayout;
 const issues=Array.isArray(final?.issues)?final.issues:[];
 summary={schematicPath:data.schematicPath,projectPath:data.projectPath,
  frames:Array.isArray(data.frames)?data.frames.length:null,
  layoutWarnings:Array.isArray(data.layoutWarnings)?data.layoutWarnings.length:null,
  powerSymbols:data.powerSymbols??null,
  fieldLayout:data.fieldLayout?{scope:'default_fields_only',movedCount:data.fieldLayout.movedCount,
   unresolvedCount:data.fieldLayout.unresolved?.length??null,unresolved:data.fieldLayout.unresolved?.slice(0,12)??[]}:null,
  readability:data.readability?{status:data.readability.status,checkedTexts:data.readability.checkedTexts,
   issueCount:data.readability.issues.length,issues:data.readability.issues.slice(0,8),omittedIssues:Math.max(0,data.readability.issues.length-8)}:{status:'not_run'},
  powerLayout:final?.stage==='final'?{stage:'final',checkedCount:final.checkedCount,
   issueCount:issues.length,issues:issues.slice(0,20),omittedIssues:Math.max(0,issues.length-20),
   unmeasuredObjectCount:Array.isArray(final.unmeasuredObjectUuids)?final.unmeasuredObjectUuids.length:null}:null};
}
// Guidance, not a fabricated readiness verdict: only a visual/connection review can close a candidate.
const failure=result.status!==0?buildFailure(preflight,result.stderr||''):null;
if(failure?.code==='MODULE_DELEGATION_REQUIRED')requireModuleRoute(plan,'multiple functional frames observed during build');
const targetedRecovery=failure?recovery(failure):null;
const nextAction=targetedRecovery||(preflight.status==='failed'&&preflight.stage==='modules'
 ? `${preflight.code}: module integration preflight failed; the design script was not executed. Fix the named module or its contract, rerun its checker and review the affected candidate. Do not rebuild unrelated modules unless their inputs or dependencies changed.`
 :preflight.status==='failed'
 ? `${preflight.code}: source preflight failed; the design script was not executed. Fix only the reported source problem before retrying; do not change circuit placement or render previews. Prefer a targeted edit. If another tool modified the file, reread its latest content before editing; restore corrupted text from a known correct version rather than regenerating the whole script. Checks cover only the entry file, not its imported modules or electrical correctness.`
 :result.status===0
 ? 'Build finished; delivery readiness is not verified by this result. Review the current candidate and collect concrete defects before one batch of edits. For a simple design, verify and deliver once connections, 50 mil grid, readability, page fit and project files meet the criteria. Further rebuilds need a specific blocking defect; do not rebuild just for cosmetic preferences or zero layout warnings. Reuse prior review of unchanged regions.'
 : 'Read this report error/stdout/stderr and fix the specific build failure before retrying. This failure is not a cosmetic layout iteration; do not bypass plan, grid or pin checks.');
const outputAdvice=result.status!==0?'':summaryStatus==='recovered'?' Keep one result JSON on stdout; move diagnostics/logs to stderr.':summaryError?` ${summaryError}`:'';
const saved=writeReport(reportPath,{designPlan:{...designPlan,content:plan.text},scriptSha256,preflight,generationMode,moduleChecks,moduleDispatch,failure,exitCode:result.status,durationMs,signal:result.signal,error:result.error?.message??null,summary,summaryStatus,summaryError,nextAction:nextAction+outputAdvice,stdout:result.stdout??'',stderr:result.stderr??''});
console.log(JSON.stringify({designPlan,preflight,generationMode,moduleChecks,moduleDispatch,failure,exitCode:result.status,durationMs,reportPath,historyPath:saved.historyPath,summary,summaryStatus,summaryError,nextAction:nextAction+outputAdvice,error:result.error?.message??null,stderrTail:(result.stderr??'').slice(-3000)}));
process.exitCode=result.status??1;
