/** One model call; native shell and preview still pass through their normal permission pipeline. */
import type {Context} from '@deepseek-ai/cordis'
import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import {createHash,randomUUID} from 'node:crypto'
import {join,dirname,resolve,relative,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import {skillResourcePaths} from './skills.ts'
import {readWorkspaceDesignPlan} from './schematic/tools.ts'
import {getKiCadPaths} from './runtime-paths.ts'
import {reviewSnapshot,changedReviewRegion,summarizeReviewIssues,batchReviewRegions,reviewRegionContainsIssue,type ReviewSnapshot} from './schematic/review-plan.ts'
import type {PreviewRegion} from './schematic/preview-regions.ts'

const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'"
type PreviewImage={name:string;pageName:string;pngPath:string}
type PreviewResult={renderStatus?:string;regionImages?:PreviewImage[];pages?:Array<{pngPath:string}>;manifestPath?:string}
type ReviewResponse={status:string;report:unknown;preview:unknown;handoff:unknown;reviewPlan:{mode:string;reason:string;[key:string]:unknown};nextAction:string}

export function createModuleReviewTool(ctx:Context,kicadCliPath?:string):ToolDefinition{
 const recent=new Map<string,{input:string;files:Array<{path:string;sha256:string}>;response:ReviewResponse}>()
 return {name:'review_kicad_module_candidate',
  description:'Build/check one module; return bounded batch repair feedback, separate connectivity/text/field counts and current images. reviewPlan lists issue counts, omissions and a repair stage; read reportPath for omitted diagnostics before batch repair. Space failures require a parent resize/re-layout decision before retrying. Explicit text positions are checked too; final full-frame visual review remains required. Parent repairs only after native child state is inactive. Never publishes.',
  parameters:{type:'object',additionalProperties:false,properties:{manifestPath:{type:'string'},moduleId:{type:'string'},reviewMode:{type:'string',enum:['auto','full'],description:'auto highlights changed areas. full requests the complete frame and may reuse verified unchanged artifacts. Final visual acceptance requires inspecting the current complete frame.'}},required:['manifestPath','moduleId']},
  output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
  async execute(input,exec){
   const args=input as {manifestPath:string;moduleId:string;reviewMode?:'auto'|'full'},agent=exec.agent,cwd=agent?.session.header.cwd
   if(args.reviewMode!==undefined&&!['auto','full'].includes(args.reviewMode))throw new Error('MODULE_REVIEW_MODE_INVALID')
   if(!agent||!cwd)throw new Error('MODULE_REVIEW_REQUIRES_AGENT')
   const root=await ctx.fs.resolve(cwd,{signal:exec.signal}),target=await ctx.fs.resolve(args.manifestPath,{cwd,signal:exec.signal})
   if(!ctx.fs.contains(root,target))throw new Error('MODULE_PATH_INVALID')
   const paths=skillResourcePaths(),runtime=await import(pathToFileURL(paths.moduleRuntimePath).href)
   const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await ctx.fs.readBytes(target,exec.signal,1024*1024)))
   await readWorkspaceDesignPlan(ctx.fs,cwd,{...raw.designPlan,path:resolve(dirname(target.displayPath),raw.designPlan.path)},exec.signal)
   const contract=await runtime.loadModulePlan(target.displayPath);runtime.moduleById(contract,args.moduleId)
   const statePath=runtime.projectPath(contract,'work/module-dispatch.json')
   const stateTarget=await ctx.fs.resolve(statePath,{signal:exec.signal})
   let owner:{agentId?:string;status:string}|undefined,parentId:string|undefined
   if(await ctx.fs.stat(stateTarget,exec.signal)){
    const state=runtime.jsonFile(statePath)
    owner=state.entries?.find((e:{moduleId:string})=>e.moduleId===args.moduleId);parentId=state.parentId
    if(owner&&agent.id!==parentId&&agent.id!==owner.agentId)throw new Error('MODULE_REVIEW_OWNER_REQUIRED: only the assigned child or its parent may rebuild this module')
    if(owner&&agent.id!==parentId&&['starting','running','unknown'].includes(owner.status)&&owner.agentId!==agent.id)
     throw new Error(`MODULE_WORKER_ACTIVE: stop the owner of ${args.moduleId} before rebuilding its candidate`)
   }
   const nested=async(name:string,arguments_:unknown)=>{
    if(!ctx.tools.get(name,agent))throw new Error(`MODULE_REVIEW_TOOL_UNAVAILABLE: ${name}`)
    const r=await ctx.tools.execute({callId:`${exec.callId}:review:${randomUUID()}` as typeof exec.callId,rootCallId:exec.rootCallId,parent:exec.token,name,arguments:arguments_,agent,signal:exec.signal})
    for(const context of r.additionalContexts??[])exec.deferContext(context)
    if(r.isError)throw new Error(`MODULE_REVIEW_TOOL_FAILED: ${name}: ${r.error.message}`)
    return r.value
   }
   // A cached completed state is insufficient if someone resumed the child outside the dispatcher.
   if(owner&&agent.id===parentId){
    const children=await nested('list_agents',{scope:'children'})
    const worker=Array.isArray(children)?children.find(row=>row&&typeof row==='object'&&!Array.isArray(row)&&row.id===owner!.agentId):undefined
    if(!worker||typeof worker!=='object'||Array.isArray(worker)||worker.kind!=='child'||worker.status!=='inactive')
     throw new Error(`MODULE_WORKER_ACTIVE: confirm ${args.moduleId} child is inactive before parent repair`)
   }
   // Check visibility before starting a build that could otherwise never be previewed.
   for(const name of ['pwsh','render_kicad_module_preview'])if(!ctx.tools.get(name,agent))throw new Error(`MODULE_REVIEW_TOOL_UNAVAILABLE: ${name}`)
   const reportTarget=await ctx.fs.resolve(runtime.moduleReportPath(contract,args.moduleId),{signal:exec.signal})
   const fingerprint=async(path:string)=>{
    const target=await ctx.fs.resolve(path,{signal:exec.signal})
    if(!ctx.fs.contains(root,target))throw new Error('MODULE_REVIEW_ARTIFACT_OUTSIDE_WORKSPACE')
    const bytes=await ctx.fs.readBytes(target,exec.signal,32*1024*1024)
    return {path,sha256:createHash('sha256').update(bytes).digest('hex')}
   }
   const cacheKey=JSON.stringify([agent.id,contract.file,args.moduleId])
   const saved=recent.get(cacheKey)
   if(args.reviewMode==='full'&&saved){
    try{
     if(saved.input===runtime.moduleInputs(contract,args.moduleId).sha256){
      const current=await Promise.all(saved.files.map(file=>fingerprint(file.path)))
      const latest=await runtime.loadModulePlan(contract.file)
      if(current.every((file,i)=>file.sha256===saved.files[i]!.sha256)&&saved.input===runtime.moduleInputs(latest,args.moduleId).sha256)
       return {...saved.response,reusedCandidate:true,reviewPlan:{...saved.response.reviewPlan,mode:'full',reason:'unchanged_verified_candidate'}}
     }
    }catch(error){if(exec.signal.aborted)throw error}
   }
   recent.delete(cacheKey)
   const started=Date.now(),candidate=`work/modules/${args.moduleId}/candidate-${randomUUID()}`
   const cli=getKiCadPaths(kicadCliPath).kicadCliPath
   await nested('pwsh',{command:`& node ${[paths.moduleCheckerPath,contract.file,args.moduleId,candidate,'--kicad-cli',cli,'--compact'].map(quote).join(' ')}`,description:`Check schematic module ${args.moduleId}`})
   const reportBytes=await ctx.fs.readBytes(reportTarget,exec.signal,8*1024*1024)
   const report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reportBytes))
   if(report.moduleId!==args.moduleId||Date.parse(report.checkedAt)<started||!Number.isFinite(Date.parse(report.checkedAt)))throw new Error('MODULE_REVIEW_REPORT_STALE')
   const feedback=await import(pathToFileURL(join(paths.assetsDir,'module-feedback.mjs')).href)
   const summary=feedback.moduleFeedback(report,reportTarget.displayPath,{includeIssues:false})
   const batch=summarizeReviewIssues(report)
   if(report.status!=='passed')return {status:'blocked',report:summary,reviewPlan:{...batch,
    nextStep:report.code==='MODULE_NETLIST_EXPORT_FAILED'||batch.repairPlan.stage==='resize'?'parent_decision':'repair',
    visualAcceptance:'pending',finalFullReviewRequired:true},
    previewStatus:'not_generated',nextAction:'This check produced no preview. '+(report.code==='MODULE_NETLIST_EXPORT_FAILED'
    ?'Report the KiCad executable/export error to the parent. Do not change the circuit or inspect runtime source to repair host configuration.'
    :batch.repairPlan.nextAction)}
   const rel=relative(join(contract.root,candidate),report.result?.schematicPath??'')
   if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('MODULE_REVIEW_REPORT_STALE: result belongs to another candidate')
   const latest=await runtime.loadModulePlan(contract.file)
   if(report.inputSha256!==runtime.moduleInputs(latest,args.moduleId).sha256)throw new Error('MODULE_RESULT_STALE')
   runtime.assertModuleArtifacts(latest,args.moduleId,report)
   const candidateFiles=[report.result.schematicPath,report.result.projectPath,...(report.connectivity?.path?[report.connectivity.path]:[])]
   const verifiedFiles=await Promise.all(candidateFiles.map(fingerprint)).catch(error=>{
    if(exec.signal.aborted)throw error
    return undefined
   })
   const frame=report.result.frames?.[0]
   let snapshot:ReviewSnapshot|undefined,comparison={mode:'full',regions:[] as PreviewRegion[],reason:'version_comparison_unavailable'}
   const comparisonWarnings:string[]=[]
   const snapshotTarget=await ctx.fs.resolve(runtime.projectPath(contract,`work/modules/${args.moduleId}/visual-review.json`),{signal:exec.signal})
   if(frame){
    comparison.regions=[{name:frame.name,pageName:contract.plan.project.name,start:frame.start,end:frame.end}]
    try{
     const schematicTarget=await ctx.fs.resolve(report.result.schematicPath,{signal:exec.signal})
     if(!ctx.fs.contains(root,schematicTarget))throw new Error('Candidate escaped workspace')
     const styleTarget=await ctx.fs.resolve(join(paths.templateDir,'frame-style.json'),{signal:exec.signal})
     const style=JSON.parse(new TextDecoder().decode(await ctx.fs.readBytes(styleTarget,exec.signal,1024*1024)))
     snapshot=reviewSnapshot(new TextDecoder('utf-8',{fatal:true}).decode(await ctx.fs.readBytes(schematicTarget,exec.signal,8*1024*1024)),style,runtime.moduleContractSha256(latest,args.moduleId))
     let previous:ReviewSnapshot|undefined
     if(await ctx.fs.stat(snapshotTarget,exec.signal)){
      try{previous=JSON.parse(new TextDecoder().decode(await ctx.fs.readBytes(snapshotTarget,exec.signal,8*1024*1024)))}
      catch{comparisonWarnings.push('Previous version comparison is unavailable; inspect the full frame.')}
     }
     comparison=changedReviewRegion(previous,snapshot,{name:frame.name,pageName:contract.plan.project.name,start:frame.start,end:frame.end},args.reviewMode==='full')
    }catch{
     snapshot=undefined
     comparisonWarnings.push('Version comparison failed; inspect the full frame.')
    }
   }
   const fullFrame:PreviewRegion|undefined=frame?{name:frame.name,pageName:contract.plan.project.name,start:frame.start,end:frame.end}:undefined
   const focusRegions=batchReviewRegions([...comparison.regions,...(report.layout?.regions??[])].filter(region=>
    !fullFrame||JSON.stringify([region.start,region.end])!==JSON.stringify([fullFrame.start,fullFrame.end])),4)
    .map((region,i)=>({...region,name:`Detail ${i+1}: ${region.name}`}))
   const regions=fullFrame?[fullFrame,...focusRegions]:undefined
   const preview=await nested('render_kicad_module_preview',{schematicPath:report.result.schematicPath,kicadCliPath:cli,projectDir:join(contract.root,'project'),outputDir:join(contract.root,candidate,'previews'),...(regions?{regions}:{})})
   if(snapshot){
    try{await ctx.fs.writeText(snapshotTarget,JSON.stringify(snapshot)+'\n',undefined,exec.signal,ctx.sandboxPolicy.resolve({session:agent.session}))}
    catch{comparisonWarnings.push('Could not save version comparison; next review will use the full frame.')}
   }
   const rendered=preview as PreviewResult|undefined
   const fullFrameImage=rendered?.regionImages?.find(image=>image.name===fullFrame?.name&&image.pageName===fullFrame?.pageName)
   const diagnosticImages=focusRegions.flatMap(region=>{
    const image=rendered?.regionImages?.find(image=>image.name===region.name&&image.pageName===region.pageName)
    return image?[{...region,pngPath:image.pngPath,issues:batch.issues.filter(issue=>reviewRegionContainsIssue(region,issue))}]:[]
   })
   const nextStep=batch.priorityCounts.must_fix?'repair':!fullFrameImage?'handoff_visual_review':
    batch.priorityCounts.visual_check?'confirm_layout':'inspect_frame_and_submit'
   const handoff={moduleId:args.moduleId,schematicPath:report.result.schematicPath,reportPath:reportTarget.displayPath,
    checkedAt:report.checkedAt,inputSha256:report.inputSha256,...(fullFrameImage?{fullFrameImagePath:fullFrameImage.pngPath}:{})}
   const response:ReviewResponse={status:'review_required',report:summary,preview,handoff,reviewPlan:{mode:comparison.mode,reason:comparison.reason,revision:snapshot?.revision,
    ...batch,nextStep,focusRegions,fullFrameImage,diagnosticImages,warnings:comparisonWarnings,
    visualAcceptance:'pending',finalFullReviewRequired:true},
    nextAction:nextStep==='repair'||nextStep==='confirm_layout'
     ?batch.repairPlan.nextAction+' Repair confirmed defects in one batch. Then inspect the final complete frame.'
     :nextStep==='inspect_frame_and_submit'
      ?'Inspect fullFrameImage once and submit this candidate if accepted. Advisory overlaps alone do not require rebuilding.'
      :'Hand off this candidate and the affected locations to the parent with visual review pending if the complete frame is unavailable.'}
   if(rendered?.renderStatus==='ok'&&fullFrameImage&&verifiedFiles){
    try{
     const imagePaths=new Set([...(rendered.pages??[]).map(image=>image.pngPath),...rendered.regionImages!.map(image=>image.pngPath)])
     if(rendered.manifestPath)imagePaths.add(rendered.manifestPath)
     const imageFiles=await Promise.all([...imagePaths].map(fingerprint))
     recent.set(cacheKey,{input:report.inputSha256,response,files:[{path:reportTarget.displayPath,sha256:createHash('sha256').update(reportBytes).digest('hex')},...verifiedFiles,...imageFiles]})
     if(recent.size>32)recent.delete(recent.keys().next().value!)
    }catch(error){if(exec.signal.aborted)throw error}
   }
   return response
  }}
}
