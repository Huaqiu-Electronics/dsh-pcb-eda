/** Run a project script without shell quoting, redirection encodings or output truncation. */
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const plugin=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const {readDesignPlan,loadDesignPlan}=await import(new URL('../../../lib/builder.js',import.meta.url));
if(process.argv[2]==='--read-plan'){
 const plan=readDesignPlan(process.argv[3]);
 console.log(JSON.stringify({designPlan:{path:plan.path,sha256:plan.sha256},content:plan.text,nextAction:'Read this saved plan and implement its requirements, parts, circuits and connection plan. Pass --plan <path> --plan-sha256 <sha256> when building. Update and reread the plan before changing the design.'}));
 process.exit(0);
}
const [script,output,report,...args]=process.argv.slice(2);
const extra=[];let planPath,planHash;
for(let i=0;i<args.length;i++){
 if(args[i]==='--plan')planPath=args[++i];
 else if(args[i]==='--plan-sha256')planHash=args[++i];
 else extra.push(args[i]);
}
const plan=loadDesignPlan({path:planPath,sha256:planHash});
const designPlan={path:plan.path,sha256:plan.sha256};
if(!script||!output||!report)throw new Error('Usage: node run-design.mjs <design.mjs> <candidate-directory> <report.json> --plan <saved-plan.md> --plan-sha256 <sha256> [script arguments]');
const started=performance.now();
const scriptSha256=createHash('sha256').update(readFileSync(resolve(script))).digest('hex');
const result=spawnSync(process.execPath,[resolve(script),resolve(output),...extra],{
 encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,
 env:{...process.env,DSH_SCHEMATIC_PLUGIN_DIR:process.env.DSH_SCHEMATIC_PLUGIN_DIR||plugin,DSH_DESIGN_BRIEF_PATH:plan.path,DSH_DESIGN_BRIEF_SHA256:plan.sha256},
});
const reportPath=resolve(report);mkdirSync(dirname(reportPath),{recursive:true});
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
  powerLayout:final?.stage==='final'?{stage:'final',checkedCount:final.checkedCount,
   issueCount:issues.length,issues:issues.slice(0,20),omittedIssues:Math.max(0,issues.length-20),
   unmeasuredObjectCount:Array.isArray(final.unmeasuredObjectUuids)?final.unmeasuredObjectUuids.length:null}:null};
}
// Guidance, not a fabricated readiness verdict: only a visual/connection review can close a candidate.
const nextAction=result.status===0
 ? 'Build finished; delivery readiness is not verified by this result. Review the current candidate and collect concrete defects before one batch of edits. For a simple design, verify and deliver once connections, 50 mil grid, readability, page fit and project files meet the criteria. Further rebuilds need a specific blocking defect; do not rebuild just for cosmetic preferences or zero layout warnings. Reuse prior review of unchanged regions.'
 : 'Read this report error/stdout/stderr and fix the specific build failure before retrying. This failure is not a cosmetic layout iteration; do not bypass plan, grid or pin checks.';
const outputAdvice=result.status!==0?'':summaryStatus==='recovered'?' Keep one result JSON on stdout; move diagnostics/logs to stderr.':summaryError?` ${summaryError}`:'';
writeFileSync(reportPath,JSON.stringify({designPlan:{...designPlan,content:plan.text},scriptSha256,exitCode:result.status,durationMs,signal:result.signal,error:result.error?.message??null,summary,summaryStatus,summaryError,nextAction:nextAction+outputAdvice,stdout:result.stdout??'',stderr:result.stderr??''},null,2)+'\n','utf8');
console.log(JSON.stringify({designPlan,exitCode:result.status,durationMs,reportPath,summary,summaryStatus,summaryError,nextAction:nextAction+outputAdvice,error:result.error?.message??null,stderrTail:(result.stderr??'').slice(-3000)}));
process.exitCode=result.status??1;
