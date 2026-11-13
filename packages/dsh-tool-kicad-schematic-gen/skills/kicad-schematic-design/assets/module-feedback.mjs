/** Bounded model feedback; full diagnostics and history remain in workspace reports. */
export function moduleFeedback(report,reportPath,{includeIssues=true}={}){
 const issues=report.connectivity?.issues??report.issues??[];
 const counts={};for(const issue of issues)counts[issue.code]=(counts[issue.code]??0)+1;
 const value={
  version:report.version,moduleId:report.moduleId,status:report.status,reportPath,historyPath:report.historyPath,
  checkedAt:report.checkedAt,inputSha256:report.inputSha256,durationMs:report.durationMs,timings:report.timings,
  ...(report.error?{error:includeIssues?report.error:String(report.error).slice(0,600),code:report.code}:{}),
  ...(report.result?{result:{schematicPath:report.result.schematicPath,projectPath:report.result.projectPath}}:{}),
  connectivity:{status:report.connectivity?.status??'not_run',checkedPins:report.connectivity?.checkedPins??null,
   issueCount:issues.length,counts,...(includeIssues?{issues:issues.slice(0,8),omittedIssues:Math.max(0,issues.length-8)}:{}),
   warnings:(report.connectivity?.warnings??[]).slice(0,4).map(w=>includeIssues?w:typeof w==='string'?w.slice(0,300):{code:w.code,net:w.net})},
  reviewStatus:'pending',
  layout:{status:report.layout?.status??'not_run',frame:report.layout?.frame,outsideCount:report.layout?.outside?.length??null,overlapCount:report.layout?.overlaps?.length??null,
   readability:report.layout?.readability?{status:report.layout.readability.status,checkedTexts:report.layout.readability.checkedTexts,
    issueCount:report.layout.readability.issues.length,...(includeIssues?{issues:report.layout.readability.issues.slice(0,6)}:{})}:{status:'not_run'},
   ...(includeIssues?{issues:(report.layout?.reviewIssues??[]).slice(0,6),regions:(report.layout?.regions??[]).slice(0,3)}:{}),
   fieldLayout:report.result?.fieldLayout?{scope:'default_fields_only',movedCount:report.result.fieldLayout.movedCount,unresolvedCount:report.result.fieldLayout.unresolved?.length??0,
    ...(includeIssues?{unresolved:report.result.fieldLayout.unresolved?.slice(0,6)}:{})}:undefined,limitations:'Approximate geometry; read actual images. Unlisted diagnostics remain in reportPath.'},
  nextAction:report.nextAction,
 };
 // DSH requires lossless JSON, including when a build fails before result/timings are populated.
 return JSON.parse(JSON.stringify(value));
}
