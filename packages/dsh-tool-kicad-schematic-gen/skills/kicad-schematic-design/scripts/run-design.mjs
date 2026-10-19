/** Run a project script without shell quoting, redirection encodings or output truncation. */
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [script,output,report,...extra]=process.argv.slice(2);
if(!script||!output||!report)throw new Error('Usage: node run-design.mjs <design.mjs> <candidate-directory> <report.json> [script arguments]');
const plugin=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const started=performance.now();
const result=spawnSync(process.execPath,[resolve(script),resolve(output),...extra],{
 encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024,
 env:{...process.env,DSH_SCHEMATIC_PLUGIN_DIR:process.env.DSH_SCHEMATIC_PLUGIN_DIR||plugin},
});
const reportPath=resolve(report);mkdirSync(dirname(reportPath),{recursive:true});
const durationMs=Math.round(performance.now()-started);
let summary=null;
try{const data=JSON.parse(result.stdout);summary={schematicPath:data.schematicPath??null,projectPath:data.projectPath??null,frames:Array.isArray(data.frames)?data.frames.length:null,layoutWarnings:Array.isArray(data.layoutWarnings)?data.layoutWarnings.length:null,powerSymbols:data.powerSymbols??null}}catch{}
writeFileSync(reportPath,JSON.stringify({exitCode:result.status,durationMs,signal:result.signal,error:result.error?.message??null,summary,stdout:result.stdout??'',stderr:result.stderr??''},null,2)+'\n','utf8');
console.log(JSON.stringify({exitCode:result.status,durationMs,reportPath,summary,error:result.error?.message??null,stderrTail:(result.stderr??'').slice(-3000)}));
process.exitCode=result.status??1;
