/** Validate the parent's compact selection record, not the truth of remote search results. */
import {statSync,realpathSync} from 'node:fs';
import {relative,isAbsolute} from 'node:path';
const text=v=>typeof v==='string'&&v.trim().length>0;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const tools=new Set(['eda_module_precise_search','eda_module_rag_search','eda_module_category_search']);

export function inspectModuleReuse(contract,resolvePath,{moduleIds=contract.plan.modules.map(m=>m.id)}={}){
 const selected=new Set(moduleIds),issues=[];
 for(const mod of contract.plan.modules){
  if(!selected.has(mod.id))continue;
  const r=mod.reuse,add=message=>issues.push({code:'MODULE_REUSE_REQUIRED',moduleId:mod.id,message});
  if(!object(r)||!['reuse','adapt','new'].includes(r.decision)||!text(r.reason)){
   add('Record reuse.decision (reuse/adapt/new), reason and actual search evidence before dispatch.');continue;
  }
  if(!Array.isArray(r.searches)||!r.searches.length){add('reuse.searches must record at least one actual relevant module search.');continue;}
  let valid=true;
  for(const s of r.searches){
   if(!object(s)||!tools.has(s.tool)||!text(s.query)||!['found','no_match','unavailable'].includes(s.outcome)
    ||(s.outcome==='unavailable'&&!text(s.detail))){
    add('Each search needs tool, query and outcome (found/no_match/unavailable); unavailable also needs the actual error in detail.');valid=false;
   }
  }
  if(r.decision==='new'){
   if(r.source!==undefined)add('A new circuit must not declare a selected reuse source.');
   continue;
  }
  if(valid&&!r.searches.some(s=>s.outcome==='found'))add('reuse/adapt requires a found candidate; unavailable is not no_match.');
  if(!object(r.source)||!text(r.source.moduleId)||!text(r.source.path)){
   add('reuse/adapt requires source.moduleId and the downloaded source.path.');continue;
  }
  try{
   const path=resolvePath(contract,r.source.path);
   if(!r.source.path.replaceAll('\\','/').startsWith('sources/')||!r.source.path.endsWith('.kicad_sch')||!statSync(path).isFile())throw new Error('source must be an existing schematic under sources/');
   const within=relative(realpathSync(resolvePath(contract,'sources')),realpathSync(path));
   if(within==='..'||within.startsWith('../')||within.startsWith('..\\')||isAbsolute(within))throw new Error('source resolves outside sources/');
   if(!contract.plan.resources.some(p=>resolvePath(contract,p)===path))throw new Error('declare selected source in resources to bind its content hash');
  }catch(error){add(`Invalid reuse source: ${error.message}`);}
 }
 return issues;
}
