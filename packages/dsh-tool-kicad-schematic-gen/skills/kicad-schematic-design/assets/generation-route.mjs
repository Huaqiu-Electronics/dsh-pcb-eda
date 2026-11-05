/** Remember an observed multi-module design independently of script/report names or visible frames. */
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const statePath=plan=>join(dirname(plan.path),'.schematic-state',
 `route-${createHash('sha256').update(plan.path).digest('hex').slice(0,24)}.json`);

export function generationRoute(plan){
 const path=statePath(plan);
 if(!existsSync(path))return {required:false,statePath:path};
 let state;
 try{state=JSON.parse(readFileSync(path,'utf8'));}
 catch{throw new Error(`MODULE_ROUTE_STATE_INVALID: inspect ${path}; do not discard the recorded design route`);}
 if(state.version!==1||state.planPath!==plan.path||state.mode!=='delegated')
  throw new Error(`MODULE_ROUTE_STATE_INVALID: ${path} does not match this design`);
 return {required:true,statePath:path,...state};
}

export function requireModuleRoute(plan,reason){
 const previous=generationRoute(plan);
 if(previous.required)return previous;
 const path=statePath(plan),temporary=path+'.'+randomUUID()+'.tmp';
 mkdirSync(dirname(path),{recursive:true});
 const state={version:1,planPath:plan.path,observedPlanSha256:plan.sha256,mode:'delegated',reason,recordedAt:new Date().toISOString()};
 try{writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{encoding:'utf8',flag:'wx'});renameSync(temporary,path);}
 finally{rmSync(temporary,{force:true});}
 return {required:true,statePath:path,...state};
}
