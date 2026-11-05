/** CLI task preparation; the DSH dispatcher uses the same prompt factory. */
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {loadModulePlan,projectPath} from '../assets/module-runtime.mjs';
import {prepareModuleTasks} from '../assets/module-tasks.mjs';
const [manifest]=process.argv.slice(2);
if(!manifest)throw new Error('Usage: node module-tasks.mjs <module-plan.json>');
const contract=await loadModulePlan(resolve(manifest)),result=await prepareModuleTasks(contract);
for(const task of result.tasks){
 for(const file of task.files){
  mkdirSync(dirname(file.path),{recursive:true});
  if(existsSync(file.path)){
   if(!file.preserveExisting&&readFileSync(file.path,'utf8')!==file.content)throw new Error('MODULE_TASK_DOCUMENT_CONFLICT: '+file.path);
  }else writeFileSync(file.path,file.content,{encoding:'utf8',flag:'wx'});
 }
 mkdirSync(dirname(task.documentPath),{recursive:true});
 if(existsSync(task.documentPath)){
  if(readFileSync(task.documentPath,'utf8')!==task.document)throw new Error('MODULE_TASK_DOCUMENT_CONFLICT: '+task.documentPath);
 }else writeFileSync(task.documentPath,task.document,{encoding:'utf8',flag:'wx'});
}
const summary={...result,tasks:result.tasks.map(({document,files,...task})=>task)};
const out=projectPath(contract,'work/module-tasks.json');mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify(summary,null,2)+'\n','utf8');
console.log(JSON.stringify({...summary,tasksPath:out}));
