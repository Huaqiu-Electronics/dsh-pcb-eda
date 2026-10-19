/** Browser-only tool card, loaded by the existing Harness module loader. */
import type * as ReactTypes from 'react'
import {parseCard} from './overview-result.ts'
import {placementHost,placeOverview,type PlacementHost} from './place.ts'
import {supersededOverviews} from './latest-overview.ts'

interface ClientContext {
 get?:(name:string)=>PlacementHost|undefined
 slots:{inject:(name:string,fn:()=>unknown)=>unknown;register:(spec:{name:string;key:string},component:unknown)=>unknown}
 effect?:(fn:()=>unknown)=>unknown
}
/** Harness compacts finished tool calls; keep only our delivery card visible. */
function keepDeliveryVisible(){
 if(typeof document==='undefined'||typeof MutationObserver==='undefined')return()=>{}
 let frame=0,disposed=false
 const reveal=()=>{frame=0;if(disposed)return;
 const cards=Array.from(document.querySelectorAll<HTMLElement>('.dsh-local-overview'));
 const hidden=supersededOverviews(cards.map(card=>({session:card.dataset.overviewSession??'',project:card.dataset.overviewProject??'',createdAt:Number(card.dataset.overviewCreated??0)})));
 for(const [index,card] of cards.entries()){
  if(card.hidden!==hidden[index])card.hidden=hidden[index]!;
  if(hidden[index])continue;
  let parent=card.parentElement
  while(parent){if(parent.hasAttribute('data-turn-process-hidden'))parent.removeAttribute('hidden');parent=parent.parentElement}
 }}
 const observer=new MutationObserver(()=>{if(!frame)frame=requestAnimationFrame(reveal)})
 observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','data-turn-process-hidden']})
 reveal();return()=>{disposed=true;observer.disconnect();if(frame)cancelAnimationFrame(frame)}
}
const loader=(window as unknown as {__ModuleLoader__:{load:(options:unknown)=>void}}).__ModuleLoader__
loader.load({id:'@local/dsh-tool-kicad-schematic-gen',factory:(require:(name:string)=>typeof ReactTypes)=>{
 const React=require('react'),{createElement:h,useState,useEffect}=React
 let getHost:(()=>PlacementHost|undefined)|undefined
 function Card(props:{block?:unknown;sessionId?:string}){
  const state=parseCard(props.block),result=state.result
  const [page,setPage]=useState(0),[zoom,setZoom]=useState(1),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{setPage(0);setZoom(1);setMessage('')},[result?.downloadUrl])
  if(state.kind==='review'||state.kind==='running'||(state.kind==='error'&&!state.formal))return null
  if(state.kind!=='delivery'||!result)return h('div',{role:'alert',style:{padding:12}},state.message)
  const current=result.pages[page]??result.pages[0]!
  const host=placementHost(getHost)
  async function place(){
   const currentHost=placementHost(getHost);if(!currentHost||!result||busy)return
   setBusy(true);setMessage('')
   try{await placeOverview(currentHost,result.downloadUrl);setMessage('已发送到 KiCad，请在原理图编辑器中完成放置。')}
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
   h('div',{style:{marginTop:12,display:'flex',gap:12,alignItems:'center'}},h('button',{type:'button',style:buttonStyle,onClick:download,disabled:busy},'下载工程 ZIP'),host?h('button',{type:'button',style:buttonStyle,onClick:place,disabled:busy},busy?'处理中…':'放置到编辑器'):null,h('span',{style:{fontSize:12}},`${result.fileCount} 个工程和库文件`)),
   result.status!=='ok'?h('p',null,'存在未渲染页面或预览警告，请结合工具结果检查。'):null,
   message?h('p',{role:'alert'},message):null)
 }
 return {inject:['slots'],apply:(ctx:ClientContext)=>{
  getHost=()=>ctx.get?.('hqEdge')
  const stopVisibility=keepDeliveryVisible()
  const dispose=ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key:'render_kicad_module_preview'},Card))
  ctx.effect?.(()=>()=>{stopVisibility();if(typeof dispose==='function')dispose()})
 }}
}})
