import {parseCard} from './overview-result.ts'

/** Structural subset of Harness's public TurnLocation and ChatSnapshot contracts. */
export interface OverviewTurn {
 turn:number
 status:string
 end?:{data:{reason:{kind:string}}}
}
export interface OverviewChat {
 locations:{getTurn:(turn:number)=>readonly string[]}
 nodes:{get:(key:string)=>unknown}
}
export type OverviewState=ReturnType<typeof parseCard>
export const NO_OVERVIEW:OverviewState={kind:'review'}

/** Read only this completed turn's persisted tool nodes; no global/session cache or DOM timing. */
export function overviewForTurn(turn:OverviewTurn|undefined,chat:OverviewChat|undefined):OverviewState {
 if(turn?.status!=='closed'||turn.end?.data.reason.kind!=='completed'||!chat)return NO_OVERVIEW
 const calls:{seq:number;block:unknown;name?:string}[]=[]
 const visited=new Set<unknown>()
 function walk(value:unknown,depth=0):void {
  if(!value||typeof value!=='object'||visited.has(value)||depth>64)return
  visited.add(value)
  const block=value as {kind?:string;seq?:number;call?:{name?:string};subCalls?:unknown[]}
  // PTC wrappers finish after their children: compare leaf calls, not the wrapper's later result.
  if(block.kind==='tool-result'&&!block.subCalls?.length&&typeof block.seq==='number')calls.push({seq:block.seq,block,name:block.call?.name})
  if(Array.isArray(block.subCalls))for(const child of block.subCalls)walk(child,depth+1)
 }
 for(const key of chat.locations.getTurn(turn.turn)){
  const node=chat.nodes.get(key) as {kind?:string;data?:{root?:unknown}}|undefined
  if(node?.kind==='tool-call')walk(node.data?.root)
 }
 // Formal delivery must be the final tool operation. Any subsequent operation requires
 // a fresh delivery, including edits through generic shell/file tools we cannot inspect.
 const latest=calls.sort((a,b)=>a.seq-b.seq).at(-1)
 return latest?.name==='render_kicad_module_preview'?parseCard(latest.block):NO_OVERVIEW
}
