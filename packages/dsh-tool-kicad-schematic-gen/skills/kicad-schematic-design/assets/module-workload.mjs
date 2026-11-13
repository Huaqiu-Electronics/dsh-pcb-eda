/** A dispatch planning heuristic, not a duration prediction or automatic circuit split. */
export function assessModuleWorkload(modules){
 const entries=modules.map(mod=>{
  const componentCount=Object.keys(mod.references).length;
  const declaredPinCount=(mod.expectedConnections??[]).reduce((n,group)=>n+group.pins.length,0);
  const netCount=new Set([...Object.values(mod.nets),...(mod.expectedConnections??[]).map(group=>group.net),
   ...Object.values(mod.ports).map(port=>port.net)]).size;
  return {moduleId:mod.id,componentCount,declaredPinCount,netCount,
   score:componentCount+declaredPinCount/4+netCount/2};
 });
 const total=entries.reduce((n,entry)=>n+entry.score,0);
 const warnings=entries.filter(entry=>entry.score>=40&&(entries.length===1||
  entry.score>=1.5*(total-entry.score)/(entries.length-1))).map(entry=>({
  moduleId:entry.moduleId,code:'MODULE_WORKLOAD_CONCENTRATED',
  nextAction:'Split only independently reviewable functional groups with confirmed interfaces and no artificial execution dependency. Keep the module intact when the topology or layout needs joint review.',
 }));
 return {modules:entries,warnings};
}
