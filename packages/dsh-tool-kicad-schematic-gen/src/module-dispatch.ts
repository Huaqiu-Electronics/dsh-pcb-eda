/** Start module workers through the visible DSH delegation tools and their policy pipeline. */
import type {Context} from '@deepseek-ai/cordis'
import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import {randomUUID} from 'node:crypto'
import {dirname,join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {skillResourcePaths} from './skills.ts'
import {readWorkspaceDesignPlan} from './schematic/tools.ts'
import {createModuleReviewTool} from './module-review.ts'

interface Entry {
 moduleId:string;label:string;agentId?:string;status:'starting'|'running'|'completed'|'stale'|'failed'|'unknown'
 startedAt:string;contractSha256?:string;inputSha256?:string;taskDocumentPath?:string;taskDocumentSha256?:string;retryReason?:string;error?:string
 layoutReview?:{status:'pending';textIssueCount:number|null;unresolvedFieldCount:number|null;outsideCount:number|null;approximateOverlapCount:number|null;repairRequired:boolean}
}
interface DispatchState {version:1;manifestSha256:string;parentId:string;entries:Entry[]}
const record=(v:unknown):Record<string,any>=>{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('MODULE_DISPATCH_INVALID: expected an object')
 return v as Record<string,any>
}
const active=(e:Entry)=>['starting','running','unknown'].includes(e.status)

export function createModuleDispatchTool(ctx:Context):ToolDefinition {
 // Exclusive per project even if two calls originate in different scoped agents.
 const locks=new Set<string>()
 return {
  name:'dispatch_kicad_schematic_modules',
  description:'Start each schematic module once with an independent-context child. Each unstarted module requires reuse selection evidence (reuse/adapt/new with actual search outcomes) in the manifest; MODULE_REUSE_REQUIRED blocks missing records. Search failures must be recorded as unavailable, never no_match. Before starting, screen fixed pin geometry against frame content space; impossible frames block, spaceWarnings are advisory crowding/unknown-size estimates and never auto-resize. Refresh after runtime completion and launch only unstarted modules. The parent batches minor value, label and local layout fixes, then rechecks affected modules. No automatic child redispatch for stale/failed reports. Explicit retry is reserved for circuit redesign, major layout rework or an interrupted delivery, with retryReason and concrete feedback. Never publishes.',
  parameters:{type:'object',additionalProperties:false,properties:{
   manifestPath:{type:'string',description:'module-plan.json inside the current session workspace.'},
   action:{type:'string',enum:['dispatch','status','retry'],description:'dispatch starts only unstarted modules; status refreshes. Parent handles minor repairs. retry requires moduleId, feedback and retryReason.'},
   moduleId:{type:'string'},feedback:{type:'string'},
   retryReason:{type:'string',enum:['circuit_redesign','major_layout','interrupted'],description:'Required only for explicit child retry. Do not use retry for values, labels, description clipping or small local moves; the parent fixes and rechecks those.'},
   subagentTool:{type:'string',description:'Independent-context DSH delegation tool name; default subagent. Do not select subagent_fork.'},
  },required:['manifestPath']},
  output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  async execute(input,exec){
   const args=record(input),agent=exec.agent,cwd=agent?.session.header.cwd
   if(!agent||!cwd)throw new Error('MODULE_DISPATCH_REQUIRES_AGENT: a parent session workspace is required')
   if(typeof args.manifestPath!=='string')throw new Error('MODULE_DISPATCH_INVALID: manifestPath required')
   const action=args.action??'dispatch'
   if(!['dispatch','status','retry'].includes(action))throw new Error('MODULE_DISPATCH_INVALID: action')
   if(action==='retry'&&(typeof args.moduleId!=='string'||typeof args.feedback!=='string'||!args.feedback.trim()
    ||!['circuit_redesign','major_layout','interrupted'].includes(args.retryReason)))
    throw new Error('MODULE_RETRY_INVALID: parent fixes minor issues; child retry requires moduleId, feedback and retryReason (circuit_redesign, major_layout or interrupted)')
   const root=await ctx.fs.resolve(cwd,{signal:exec.signal})
   const target=await ctx.fs.resolve(args.manifestPath,{cwd,signal:exec.signal})
   if(!ctx.fs.contains(root,target)||(await ctx.fs.stat(target,exec.signal))?.type!=='file')throw new Error('MODULE_PATH_INVALID: manifest must be inside the workspace')
   const lock=target.displayPath.toLowerCase()
   if(locks.has(lock))throw new Error('MODULE_DISPATCH_BUSY: another dispatch is updating this project')
   locks.add(lock)
   try{
    const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await ctx.fs.readBytes(target,exec.signal,1024*1024)))
    const brief=record(raw.designPlan)
    await readWorkspaceDesignPlan(ctx.fs,cwd,{...brief,path:joinRelative(dirname(target.displayPath),brief.path)},exec.signal)
    const paths=skillResourcePaths()
    const runtime=await import(pathToFileURL(paths.moduleRuntimePath).href)
    const prompts=await import(pathToFileURL(join(paths.assetsDir,'module-tasks.mjs')).href)
    const contract=await runtime.loadModulePlan(target.displayPath)
    // Validate shared inputs before publishing any child, so workers don't all rediscover the same errors.
    if(action!=='status')await runtime.preflightConfirmedParts(contract,{requireValues:true,checkSpace:true})
    const feedback=action==='retry'&&typeof args.moduleId==='string'&&typeof args.feedback==='string'?{[args.moduleId]:args.feedback}:{}
    const tasks=(await prompts.prepareModuleTasks(contract,{feedback})).tasks as Array<{id:string;cwd:string;description:string;prompt:string;dependsOn:string[];documentPath:string;documentSha256:string;document:string;files:Array<{path:string;content:string;preserveExisting:boolean}>}>
    if(!ctx.tools.get('list_agents',agent))throw new Error('MODULE_SUBAGENT_UNAVAILABLE: enable DSH child discovery to track workers safely')
    if(action==='dispatch'){
     const name=args.subagentTool??'subagent',tool=typeof name==='string'?ctx.tools.get(name,agent):undefined
     if(!tool||/fork/i.test(name)||!/own context|independent.context|独立上下文/i.test(tool.description))
      throw new Error('MODULE_SUBAGENT_UNAVAILABLE: enable an independent-context DSH subagent tool')
    }
    if(action==='retry'&&!ctx.tools.get('send_message',agent))throw new Error('MODULE_SUBAGENT_UNAVAILABLE: child continuation is not enabled')
    const stateTarget=await ctx.fs.resolve(runtime.projectPath(contract,'work/module-dispatch.json'),{signal:exec.signal})
    const policy=ctx.sandboxPolicy.resolve({session:agent.session})
    let state:DispatchState={version:1,manifestSha256:contract.manifestSha256,parentId:agent.id,entries:[]}
    if(await ctx.fs.stat(stateTarget,exec.signal)){
     state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await ctx.fs.readBytes(stateTarget,exec.signal,1024*1024)))
     if(state.version!==1||!Array.isArray(state.entries))throw new Error('MODULE_DISPATCH_STATE_INVALID: inspect saved state; do not overwrite it')
     if(state.parentId!==agent.id)throw new Error('MODULE_DISPATCH_PARENT_CHANGED: use the owning parent chat to continue its workers')
    }
    const save=()=>ctx.fs.writeText(stateTarget,JSON.stringify(state,null,2)+'\n',undefined,exec.signal,policy)
    // A local plan edit must not cancel unrelated workers or erase accepted results.
    const contracts=new Map<string,string>(tasks.map(task=>[task.id,runtime.moduleContractSha256(contract,task.id)]))
    const nested=async(name:string,arguments_:unknown)=>{
     if(!ctx.tools.get(name,agent))throw new Error(`MODULE_SUBAGENT_UNAVAILABLE: ${name} is not visible to this agent`)
     const result=await ctx.tools.execute({callId:`${exec.callId}:module:${randomUUID()}` as typeof exec.callId,
      rootCallId:exec.rootCallId,parent:exec.token,name,arguments:arguments_,agent,signal:exec.signal})
     for(const context of result.additionalContexts??[])exec.deferContext(context)
     if(result.isError)throw new Error(`MODULE_SUBAGENT_CALL_FAILED: ${name}: ${result.error.message}`)
     return result.value
    }
    if(state.entries.length){
     const listed=await nested('list_agents',{scope:'children'})
     if(!Array.isArray(listed))throw new Error('MODULE_AGENT_LIST_UNSUPPORTED: expected DSH direct-child list')
     for(const entry of state.entries){
      const row=listed.find(v=>v&&typeof v==='object'&&!Array.isArray(v)
       &&((entry.agentId&&v.id===entry.agentId)||(!entry.agentId&&v.label===entry.label))) as Record<string,any>|undefined
      if(!row||row.kind!=='child'){entry.status='unknown';continue}
      entry.agentId=row.id
      if(row.status==='running'){entry.status='running';continue}
      if(row.status!=='inactive'){entry.status='unknown';continue}
      try{
       const report=runtime.jsonFile(runtime.moduleReportPath(contract,entry.moduleId))
       if(report.version!==1||report.status!=='passed'||report.moduleId!==entry.moduleId||!Number.isFinite(Date.parse(report.checkedAt))
        ||Date.parse(report.checkedAt)<Date.parse(entry.startedAt))
        throw new Error('module report is missing, failed or stale')
       runtime.assertModuleArtifacts(contract,entry.moduleId,report)
       if(report.inputSha256!==runtime.moduleInputs(contract,entry.moduleId).sha256){entry.status='stale';entry.error='Module inputs changed; recheck the existing implementation';continue}
       entry.status='completed';entry.inputSha256=report.inputSha256;delete entry.error
       entry.layoutReview={status:'pending',textIssueCount:report.layout?.readability?.issues?.length??null,
        unresolvedFieldCount:report.result?.fieldLayout?.unresolved?.length??null,outsideCount:report.layout?.outside?.length??null,
        approximateOverlapCount:report.layout?.overlaps?.length??null,
        repairRequired:!!(report.layout?.readability?.issues?.length||report.result?.fieldLayout?.unresolved?.length||report.layout?.outside?.length)}
      }catch(error){entry.status='failed';entry.error=error instanceof Error?error.message:String(error)}
     }
    }
    const changedLive=state.entries.filter(entry=>active(entry)&&(!contracts.has(entry.moduleId)
     ||(entry.contractSha256?entry.contractSha256!==contracts.get(entry.moduleId):state.manifestSha256!==contract.manifestSha256)))
    if(changedLive.length)throw new Error(`MODULE_PLAN_CHANGED_ACTIVE: stop or finish affected workers: ${changedLive.map(e=>e.moduleId).join(', ')}`)
    state={...state,manifestSha256:contract.manifestSha256,entries:state.entries.filter(e=>contracts.has(e.moduleId))}
    // Require selection evidence only for new workers; status/repair of prior dispatches stays usable.
    if(action==='dispatch')runtime.preflightModuleReuse(contract,{moduleIds:tasks.filter(task=>!state.entries.some(e=>e.moduleId===task.id)).map(task=>task.id)})
    // Commit state/permission before a delegation can publish an independently running child.
    await save()
    const started:string[]=[]
    const launch=async(task:typeof tasks[number],resume?:Entry)=>{
     for(const file of task.files){
      const target=await ctx.fs.resolve(file.path,{signal:exec.signal})
      if(!ctx.fs.contains(root,target))throw new Error('MODULE_PATH_INVALID: task input escaped workspace')
      const existing=await ctx.fs.stat(target,exec.signal)
      if(existing){
       if(!file.preserveExisting&&new TextDecoder('utf-8',{fatal:true}).decode(await ctx.fs.readBytes(target,exec.signal,1024*1024))!==file.content)
        throw new Error('MODULE_TASK_DOCUMENT_CONFLICT: '+file.path)
      }else await ctx.fs.writeText(target,file.content,{kind:'createIfAbsent'},exec.signal,policy)
     }
     // Publish the exact instructions before a worker can start reading them, through normal FS policy.
     const documentTarget=await ctx.fs.resolve(task.documentPath,{signal:exec.signal})
     if(!ctx.fs.contains(root,documentTarget))throw new Error('MODULE_PATH_INVALID: task document escaped workspace')
     if(await ctx.fs.stat(documentTarget,exec.signal)){
      const existing=new TextDecoder('utf-8',{fatal:true}).decode(await ctx.fs.readBytes(documentTarget,exec.signal,1024*1024))
      if(existing!==task.document)throw new Error('MODULE_TASK_DOCUMENT_CONFLICT: generated task document was edited')
     }else await ctx.fs.writeText(documentTarget,task.document,{kind:'createIfAbsent'},exec.signal,policy)
     const entry:Entry={moduleId:task.id,label:resume?.label??`schematic ${task.id} ${randomUUID()}`,status:'starting',startedAt:new Date().toISOString(),contractSha256:contracts.get(task.id),
      taskDocumentPath:task.documentPath,taskDocumentSha256:task.documentSha256,
      ...(resume?{retryReason:args.retryReason}:{}),
      ...(resume?.agentId?{agentId:resume.agentId}:{})}
     state.entries=state.entries.filter(e=>e.moduleId!==task.id);state.entries.push(entry);await save()
     try{
      if(resume){await nested('send_message',{agent_id:resume.agentId,message:task.prompt})}
      else{
       const name=args.subagentTool??'subagent'
       if(typeof name!=='string'||/fork/i.test(name))throw new Error('MODULE_SUBAGENT_UNAVAILABLE: select an independent-context tool')
       const tool=ctx.tools.get(name,agent)
       if(!tool||!/own context|independent.context|独立上下文/i.test(tool.description))throw new Error('MODULE_SUBAGENT_UNAVAILABLE: independent-context delegation tool required')
       const receipt=record(await nested(name,{cwd:task.cwd,description:entry.label,prompt:task.prompt}))
       if(typeof receipt.subagentId!=='string'||!receipt.subagentId)throw new Error('MODULE_SUBAGENT_RECEIPT_INVALID: no child ID; reconcile native child catalog before retrying')
       entry.agentId=receipt.subagentId
      }
      entry.status='running';started.push(task.id)
     }catch(error){entry.status='unknown';entry.error=error instanceof Error?error.message:String(error)}
     await save()
    }
    let slots=contract.plan.maxParallel-state.entries.filter(active).length
    if(action==='retry'){
     const old=state.entries.find(e=>e.moduleId===args.moduleId),task=tasks.find(t=>t.id===args.moduleId)
     if(!old?.agentId||!task||active(old)||slots<1)throw new Error('MODULE_RETRY_BLOCKED: worker must be known, inactive, and have an available slot')
     await launch(task,old)
    }else if(action==='dispatch'){
     for(const task of tasks){
      if(slots<1)break
      const old=state.entries.find(e=>e.moduleId===task.id)
      if(old||!task.dependsOn.every(id=>state.entries.some(e=>e.moduleId===id&&e.status==='completed')))continue
      await launch(task);slots--
     }
    }
    return {statePath:stateTarget.displayPath,manifestSha256:state.manifestSha256,maxParallel:contract.plan.maxParallel,started,
     spaceWarnings:contract.spaceAssessment?.filter((s:{status:string})=>s.status!=='clear')??[],
     modules:state.entries,pending:tasks.filter(t=>!state.entries.some(e=>e.moduleId===t.id)).map(t=>t.id),
     parentRepair:state.entries.filter(e=>['stale','failed'].includes(e.status)||e.status==='completed'&&e.layoutReview?.repairRequired).map(e=>e.moduleId),
     parentLayoutReview:state.entries.filter(e=>e.status==='completed').map(e=>({moduleId:e.moduleId,...e.layoutReview})),
     deliveryReadiness:'not_certified',
     readyForAssembly:tasks.every(t=>state.entries.some(e=>e.moduleId===t.id&&e.status==='completed')),
     nextAction:'readyForAssembly permits candidate construction, never certifies delivery. parentRepair includes stale/failed modules and readability locations requiring parent attention. Inspect parentLayoutReview in current images, batch confirmed value/text/layout defects after native child inactivity, then recheck changed modules; explain conservative false positives instead of ignoring every warning. Fix unreadable text before publishing. Do not automatically redispatch; explicit child retry needs a major redesign/interruption reason. Reconcile unknown workers first.'}
   }catch(error){
    if(error instanceof Error&&Array.isArray((error as Error&{issues?:unknown[]}).issues))return {
     status:'blocked',stage:'configuration',code:(error as Error&{code?:string}).code??'MODULE_PLAN_PREFLIGHT_FAILED',
     issues:(error as Error&{issues:unknown[]}).issues,message:error.message,
     nextAction:'Fix all listed shared configuration issues together and rerun preflight/dispatch. No new module workers were started by this call; do not patch the complete schematic script.',
    }
    throw error
   }finally{locks.delete(lock)}
  },
 }
}

function joinRelative(directory:string,path:unknown):string{
 if(typeof path!=='string')throw new Error('DESIGN_PLAN_REQUIRED: saved plan path required')
 // resolve preserves absolute drive/UNC paths and is checked against the workspace by the caller.
 return resolve(directory,path)
}

export function registerModuleDispatch(ctx:Context,kicadCliPath?:string):void{
 ctx.effect(()=>ctx.tools.register(createModuleDispatchTool(ctx)))
 ctx.effect(()=>ctx.tools.register(createModuleReviewTool(ctx,kicadCliPath)))
}
