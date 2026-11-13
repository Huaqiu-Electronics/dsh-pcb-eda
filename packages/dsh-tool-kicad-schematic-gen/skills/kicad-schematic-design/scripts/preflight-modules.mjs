/** Check shared layout, paths, references, confirmed symbols and public pins before dispatch. */
import {dirname,resolve,join} from 'node:path';
import {loadModulePlan,preflightConfirmedParts,preflightModuleReuse} from '../assets/module-runtime.mjs';
import {writeReport} from '../assets/reporting.mjs';
const [manifest,output]=process.argv.slice(2),started=performance.now();
if(!manifest)throw new Error('Usage: node preflight-modules.mjs <module-plan.json> [workspace-report.json]');
let report={status:'failed',stage:'configuration'};
try{
 const contract=await loadModulePlan(resolve(manifest));
 await preflightConfirmedParts(contract,{requireValues:true,checkSpace:true});
 preflightModuleReuse(contract);
 report={status:'passed',stage:'configuration',manifestSha256:contract.manifestSha256,moduleCount:contract.plan.modules.length,spaceAssessment:contract.spaceAssessment,
  nextAction:'Configuration passed. Call dispatch_kicad_module_tasks before implementing module circuits. This check does not verify topology, readability or electrical correctness.'};
}catch(error){report={...report,code:error.code||error.message.split(':')[0],message:error.message,issues:error.issues||[],
 nextAction:'Fix every listed configuration issue together, then rerun preflight. No module circuit was executed and no candidate was generated.'};process.exitCode=1;}
console.log(JSON.stringify(writeReport(output||join(dirname(resolve(manifest)),'work/module-preflight.json'),{...report,durationMs:Math.round(performance.now()-started)})));
