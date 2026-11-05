/** Build one isolated module. Reports structural facts; never claims electrical or visual approval. */
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadModulePlan,moduleById,moduleReportPath,projectPath,preflightModule,moduleInputs,buildModules} from '../assets/module-runtime.mjs';
import {checkModuleConnections} from '../assets/module-netlist.mjs';
import {describeModuleLayout} from '../assets/module-layout.mjs';
import {writeReport} from '../assets/reporting.mjs';
import {moduleFeedback} from '../assets/module-feedback.mjs';

const [manifest,id,candidate,...rawOptions]=process.argv.slice(2),started=performance.now();
const compact=rawOptions.includes('--compact'),options=rawOptions.filter(value=>value!=='--compact');
if(!manifest||!id||!candidate)throw new Error('Usage: node check-module.mjs <module-plan.json> <module-id> <unique-project-relative-candidate-directory>');
let reportPath,report={version:1,moduleId:id,status:'failed'};
try{
 if(options.length&&(options.length!==2||options[0]!=='--kicad-cli'||!options[1]))throw new Error('MODULE_CHECK_OPTIONS_INVALID: expected --kicad-cli <executable>');
 const contract=await loadModulePlan(resolve(manifest));
 const mod=moduleById(contract,id);
 reportPath=moduleReportPath(contract,id);
 // Each worker owns only its work subtree, even if a mistaken command names another module.
 if(!new RegExp(`^work/modules/${id}/candidate-[A-Za-z0-9_-]+$`).test(candidate.replaceAll('\\','/')))throw new Error('MODULE_OUTPUT_INVALID: use work/modules/<id>/candidate-<unique-run-id>');
 const output=projectPath(contract,candidate);
 if(existsSync(output))throw new Error('MODULE_OUTPUT_EXISTS: use a fresh candidate directory');
 const inputs=preflightModule(contract,id);
 const preflightMs=Math.round(performance.now()-started),buildStarted=performance.now();
 const result=await buildModules(contract,output,{moduleId:id});
 const buildMs=Math.round(performance.now()-buildStarted);
 const layout=await describeModuleLayout(contract,mod,result);
 report={...report,result,layout};
 const connectionStarted=performance.now();
 const connectivity=await checkModuleConnections(contract,mod,result,output,options[1]);
 const connectivityMs=Math.round(performance.now()-connectionStarted);
 report={...report,result,connectivity,timings:{preflightMs,buildMs,connectivityMs}};
 if(connectivity.status==='failed')throw Object.assign(new Error('MODULE_CONNECTION_MISSING: fix listed wiring/name defects; do not rewire an already connected net merely to change its name'),{code:'MODULE_CONNECTION_MISSING',issues:connectivity.issues});
 const current=await loadModulePlan(resolve(manifest));
 if(moduleInputs(current,id).sha256!==inputs.sha256)
  throw new Error('MODULE_RESULT_STALE: inputs changed during module checking');
 report={...report,status:'passed',connectivity,inputSha256:inputs.sha256,inputs:inputs.files,result,timings:{preflightMs,buildMs,connectivityMs},
  reviewStatus:'pending',nextAction:'Read this candidate preview and review module connections against the saved plan. Structural pass does not prove electrical correctness. Return concrete defects or the reviewed result to the parent; only the parent publishes.'};
}catch(error){report.error=error.message;report.code=error.code||error.message.split(':')[0];report.issues=error.issues||[];process.exitCode=1;}
report.durationMs=Math.round(performance.now()-started);
report.checkedAt=new Date().toISOString();
if(reportPath)report=writeReport(reportPath,report);
console.log(JSON.stringify(compact?moduleFeedback(report,reportPath):{...report,reportPath}));
