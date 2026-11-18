/** Browser-only tool card, loaded by the existing Harness module loader. */
import type * as ReactTypes from 'react'
import {overviewForTurn,NO_OVERVIEW,type OverviewTurn,type OverviewChat} from './turn-overview.ts'
import {placementHost,placeOverview,type PlacementHost} from './place.ts'
import {registerSchematicGenSourceWhenReady} from './schematic-ref.ts'
import {mountSchematicGenSidebarEntry} from './sidebar-entry.ts'
import {insertSchematicChip,currentSessionId,resolveSessionScope,type ChipInserterDeps,type ConversationLike,type SessionsLike} from './composer-chip.ts'
import {importingHost,openInKiCad,readProjectsDirectory,changeProjectsDirectory,type ImportHost,type ProjectsDirectory} from './open-in-eda.ts'

interface ClientContext {
 get?:(name:string)=>unknown
 slots:{inject:(name:string,fn:()=>unknown)=>unknown;register:(spec:{name:string;key?:string;id?:string;order?:number},component:unknown)=>unknown}
 effect?:(fn:()=>unknown)=>unknown
}
const loader=(window as unknown as {__ModuleLoader__:{load:(options:unknown)=>void}}).__ModuleLoader__
loader.load({id:'@huaqiu/dsh-tool-kicad-schematic-gen',factory:(require:(name:string)=>typeof ReactTypes)=>{
 const React=require('react'),{createElement:h,useState,useEffect}=React
 // One service, two capabilities: placement (editor-side) and the hq-edge API
 // bridge (project import + settings). Both read it lazily.
 type HqEdgeHost=PlacementHost&ImportHost
 let getHost:(()=>HqEdgeHost|undefined)|undefined
 function Card(props:{turn?:OverviewTurn;sessionId?:string;useChat?:<T>(select:(snapshot:OverviewChat)=>T)=>T}){
  // The hook belongs to this slot's session binding. Read synchronously so history replay,
  // session switches and completion cannot race a separate watcher/effect cache.
  const chat=props.useChat?.(snapshot=>snapshot)
  const state=chat?overviewForTurn(props.turn,chat):NO_OVERVIEW,result=state.result
  const [page,setPage]=useState(0),[zoom,setZoom]=useState(1),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  // Where the NEXT project lands. Read once per mount from HQ Edge (the owner
  // of that setting) so the user can see and change it before opening.
  const [directory,setDirectory]=useState<ProjectsDirectory|undefined>(undefined)
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState('')
  useEffect(()=>{const bridge=importingHost(getHost);if(!bridge)return;let live=true
   readProjectsDirectory(bridge).then(d=>{if(live)setDirectory(d)}).catch(()=>{/* optional: the action still works */})
   return()=>{live=false}},[])
  useEffect(()=>{setPage(0);setZoom(1);setMessage('')},[result?.downloadUrl])
  if(state.kind==='review'||state.kind==='running'||(state.kind==='error'&&!state.formal))return null
  if(state.kind!=='delivery'||!result)return h('div',{role:'alert',style:{padding:12}},state.message)
  const current=result.pages[page]??result.pages[0]!
  const host=placementHost(getHost),bridge=importingHost(getHost)
  async function place(){
   const currentHost=placementHost(getHost);if(!currentHost||!result||busy)return
   setBusy(true);setMessage('')
   try{await placeOverview(currentHost,result.downloadUrl);setMessage('已发送到 KiCad，请在原理图编辑器中完成放置。')}
   catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  // Open the delivered project in KiCad: HQ Edge extracts the same immutable
  // snapshot the card shows, moves it into the projects directory and asks the
  // EDA to open it. `props.sessionId` is the conversation that generated the
  // design — HQ Edge forks it into the new project's workspace, so the AI panel
  // there continues this conversation instead of starting blank.
  async function openInEda(){
   const bridge=importingHost(getHost);if(!bridge||!result||busy)return
   setBusy(true);setMessage('正在打开到 KiCad…')
   try{
    const opened=await openInKiCad(bridge,{downloadUrl:result.downloadUrl,projectName:result.title,sessionId:props.sessionId})
    setMessage(`已在 KiCad 中打开：${opened.projectDir}${opened.sessionForked?'（已接续生成该设计的对话）':''}`)
    if(opened.projectsDir)setDirectory(d=>d===undefined?d:{...d,directory:opened.projectsDir!,isDefault:opened.projectsDir===d.defaultDirectory})
   }catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  async function saveDirectory(directory:string|null){
   const bridge=importingHost(getHost);if(!bridge||busy)return
   setBusy(true);setMessage('')
   try{const next=await changeProjectsDirectory(bridge,directory);setDirectory(next);setEditing(false);setMessage(`新的工程将保存到：${next.directory}`)}
   catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  async function download(){
   if(!result)return
   setBusy(true);setMessage('')
   try{
    const response=await fetch(result.downloadUrl)
    if(!response.ok)throw new Error('下载快照不可用，请从本地正式工程获取文件。')
    const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a')
    a.href=url;a.download=result.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
   }catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  const buttonStyle={padding:'6px 12px',border:'1px solid #aaa',borderRadius:6,background:'transparent',color:'inherit',cursor:'pointer'}
  return h('section',{className:'dsh-local-overview','data-overview-session':props.sessionId,'data-overview-project':result.projectKey,'data-overview-created':result.createdAt,'aria-label':'原理图概览',style:{border:'1px solid #aaa',borderRadius:10,padding:16,margin:'8px 0',color:'inherit'}},
   h('div',{style:{display:'flex',justifyContent:'space-between',gap:12}},h('strong',null,'原理图概览'),h('span',null,result.status==='ok'?'● 已生成':'预览部分完成')),
   h('div',{style:{margin:'10px 0',fontSize:13}},`${result.title} · ${result.pages.length} 页预览 · ${(result.size/1024).toFixed(1)} KB`),
   h('div',{style:{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:8}},
    result.pages.length>1?h('select',{'aria-label':'原理图页面',value:page,onChange:(event:ReactTypes.ChangeEvent<HTMLSelectElement>)=>{setPage(Number(event.target.value));setZoom(1);setMessage('')}},result.pages.map((p,i)=>h('option',{key:p.imageUrl,value:i},p.name))):null,
    h('button',{type:'button',style:buttonStyle,onClick:()=>setZoom(z=>Math.max(1,z-.5)),disabled:zoom===1,'aria-label':'缩小'},'−'),
    h('button',{type:'button',style:buttonStyle,onClick:()=>setZoom(z=>Math.min(4,z+.5)),disabled:zoom===4,'aria-label':'放大'},'+'),
    h('button',{type:'button',style:buttonStyle,onClick:()=>setZoom(1)},'适合窗口')),
   h('div',{style:{overflow:'auto',maxHeight:540,background:'#fff',borderRadius:6}},h('img',{key:current.imageUrl,src:current.imageUrl,alt:`${result.title} — ${current.name}`,onError:()=>setMessage('预览图片不可用，请检查本地正式预览。'),style:{display:'block',width:`${zoom*100}%`,maxWidth:'none',height:zoom===1?480:'auto',objectFit:'contain'}})),
   h('div',{style:{marginTop:12,display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}},
    h('button',{type:'button',style:buttonStyle,onClick:download,disabled:busy},'下载工程 ZIP'),
    // Opening the design needs HQ Edge (it owns the project directory and the
    // EDA hand-off); placement needs an editor that accepts schematic content.
    bridge?h('button',{type:'button',style:buttonStyle,onClick:openInEda,disabled:busy},busy?'处理中…':'打开到 KiCad'):null,
    host?h('button',{type:'button',style:buttonStyle,onClick:place,disabled:busy},busy?'处理中…':'放置到编辑器'):null,
    h('span',{style:{fontSize:12}},`${result.fileCount} 个工程和库文件`)),
   result.status!=='ok'?h('p',null,'存在未渲染页面或预览警告，请结合工具结果检查。'):null,
   // The projects directory is HQ Edge's setting, not this card's: it is shown
   // and changed here because this is where the user decides to open a project.
   directory?h('div',{style:{marginTop:10,fontSize:12,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}},
    editing?h('input',{type:'text',value:draft,placeholder:directory.defaultDirectory,'aria-label':'工程保存目录',onChange:(event:ReactTypes.ChangeEvent<HTMLInputElement>)=>setDraft(event.target.value),style:{flex:'1 1 260px',padding:'5px 8px',border:'1px solid #aaa',borderRadius:6,background:'transparent',color:'inherit'}})
     :h('span',null,`工程保存目录：${directory.directory}${directory.isDefault?'（默认）':''}`),
    editing?h('button',{type:'button',style:buttonStyle,onClick:()=>void saveDirectory(draft.trim()===''?null:draft.trim()),disabled:busy},'保存')
     :h('button',{type:'button',style:buttonStyle,onClick:()=>{setDraft(directory.isDefault?'':directory.directory);setEditing(true);setMessage('')},disabled:busy},'更改'),
    editing?h('button',{type:'button',style:buttonStyle,onClick:()=>void saveDirectory(null),disabled:busy||directory.isDefault},'恢复默认'):null,
    editing?h('button',{type:'button',style:buttonStyle,onClick:()=>{setEditing(false);setMessage('')},disabled:busy},'取消'):null
   ):null,
   message?h('p',{role:'alert'},message):null)
 }
 return {inject:['slots','inputTriggers'],apply:(ctx:ClientContext)=>{
  getHost=()=>ctx.get?.('hqEdge') as HqEdgeHost|undefined
  // Trace the two things that decide whether the plugin is visible at all:
  // the trigger registry (the `@` menu) and the mounted sidebar row. When the
  // node half fails to import, DSH never loads this file — so silence here
  // means "the entry did not activate", not "the row failed to mount".
  // `inputTriggers` is declared in `inject`, so cordis parks this plugin until
  // the provider exists; `registerSchematicGenSourceWhenReady` still polls, so
  // a provider that arrives later than that promise still gets our source —
  // an unregistered source makes every send fail with
  // `slash: no serializer for reference source "schematic-gen"`.
  const source=registerSchematicGenSourceWhenReady(()=>ctx.get?.('inputTriggers'))
  try{console.debug('[schematic-gen:client] apply',{inputTriggers:source.registered(),
    slots:typeof ctx.slots?.inject==='function'})}catch{}
  // The sidebar toolbutton. Clicking it inserts the chip; it never opens a
  // workspace. Both services are read lazily — they may materialize after this
  // plugin, and a missing one must not take the client half down.
  const chipDeps:ChipInserterDeps={
   getConversation:()=>ctx.get?.('conversation') as ConversationLike|undefined,
   getSessions:()=>ctx.get?.('sessions') as SessionsLike|undefined,
  }
  const stopEntry=mountSchematicGenSidebarEntry({onToggle:()=>{
   // Never insert a chip DSH cannot submit: the controller routes every chip to
   // its owner's codec, so a source that never registered blocks the whole send
   // instead of degrading. While the trigger pipeline is still warming up, say
   // so and leave the draft clean.
   if(!source.registered()){
    try{console.debug('[schematic-gen:chip] click',{ok:false,reason:'source-unregistered'})}catch{}
    notifyComposer(ctx,'source-unregistered')
    return
   }
   const result=insertSchematicChip(chipDeps)
   // The one line that answers "I clicked and nothing happened": every failure
   // path in the inserter is traced, so the browser console names the reason.
   try{console.debug('[schematic-gen:chip] click',result)}catch{}
   // 'already-present' is the idempotent case, not a failure: a second click on
   // a draft that already carries the chip is a no-op.
   if(result.ok||result.reason==='already-present')return
   notifyComposer(ctx,result.reason)
  },position:'after'})
  try{console.debug('[schematic-gen:client] sidebar row',{rows:document.querySelectorAll('[data-hqcg-schematic-entry]').length})}catch{}
  const dispose=ctx.slots.inject('conversation.chat.turnTail',()=>ctx.slots.register({name:'conversation.chat.turnTail',id:'huaqiu-schematic-overview',order:100},Card))
  ctx.effect?.(()=>()=>{source.dispose();stopEntry();if(typeof dispose==='function')dispose()})
 }}
 /** Surface why a chip insertion did not happen, through the composer's own notice channel. Best-effort by design. */
 function notifyComposer(context:ClientContext,reason:string){
  try{
   const sessions=context.get?.('sessions') as SessionsLike|undefined
   const conversation=context.get?.('conversation') as ConversationLike|undefined
  if(sessions===undefined||conversation?.input===undefined)return
  const sessionId=currentSessionId(sessions)
  if(!sessionId)return
  // Same guard-safe order as the inserter: `binding(id).ctx`, never `scope(id)`
  // (the dynamic facade throws on a Context-returning service call).
  const actx=resolveSessionScope(sessions,sessionId)
  if(actx===undefined||actx===null)return
   const input=conversation.input.for(actx) as {notify?:(level:'info'|'error',text:string)=>void}|undefined
   input?.notify?.('info',noticeFor(reason))
  }catch{/* notice delivery is strictly optional */}
 }
/** Human-readable notice text for one insertion failure reason. */
function noticeFor(reason:string):string{
 switch(reason){
  case 'no-session':return 'Open a conversation first, then click Schematic Gen again.'
  case 'busy':return 'The composer is busy — try again once the current message settles.'
  case 'conflict':return 'The composer changed while inserting — click Schematic Gen again.'
  // The trigger pipeline has not registered our source yet. Inserting anyway
  // would produce a chip DSH refuses to submit, so the click is declined.
  case 'source-unregistered':return 'Schematic Gen is still starting up — click again in a moment.'
  default:return 'Schematic Gen is unavailable in this session.'
 }
}
}})
