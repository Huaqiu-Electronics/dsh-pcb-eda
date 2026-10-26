import assert from 'node:assert/strict'
import {test} from 'node:test'
import {overviewForTurn,type OverviewChat,type OverviewTurn} from '../src/client/turn-overview.ts'

const route='/api/v1/kicad-schematic-overview/12345678-1234-1234-1234-123456789abc'
function preview(seq:number,title='final') {
 return {kind:'tool-result',seq,call:{name:'render_kicad_module_preview'},content:[{type:'text',text:JSON.stringify({status:'ok',overview:{title,filename:'design.zip',size:20,fileCount:2,downloadUrl:`${route}/project.zip`,pages:[{name:'root',imageUrl:`${route}/page-0.png`}]}})}]}
}
const completed:OverviewTurn={turn:3,status:'closed',end:{data:{reason:{kind:'completed'}}}}
function chat(turns:Record<number,unknown[]>):OverviewChat {
 const nodes=new Map<string,unknown>(),keys=new Map<number,string[]>()
 for(const [turn,blocks] of Object.entries(turns))keys.set(Number(turn),blocks.map((root,index)=>{
  const key=`${turn}:${index}`;nodes.set(key,{kind:'tool-call',data:{root}});return key
 }))
 return {locations:{getTurn:turn=>keys.get(turn)??[]},nodes:{get:key=>nodes.get(key)}}
}

test('delivery waits for an explicit successful turn end, including history replay',()=>{
 const snapshot=chat({3:[preview(10)]})
 for(const reason of ['aborted','interrupted','error','max-tokens'])assert.equal(overviewForTurn({...completed,end:{data:{reason:{kind:reason}}}},snapshot).kind,'review')
 assert.equal(overviewForTurn({...completed,status:'open',end:undefined},snapshot).kind,'review')
 assert.equal(overviewForTurn({...completed,status:'closed',end:undefined},snapshot).kind,'review')
 assert.equal(overviewForTurn(completed,snapshot).result?.title,'final')
 assert.equal(overviewForTurn(completed,chat({3:[JSON.parse(JSON.stringify(preview(10)))]})).result?.title,'final')
})

test('selection is turn-local and session-local and chooses the last operation by sequence',()=>{
 const snapshot=chat({2:[preview(100,'other turn')],3:[preview(20,'new'),preview(10,'old')]})
 assert.equal(overviewForTurn(completed,snapshot).result?.title,'new')
 assert.equal(overviewForTurn({...completed,turn:2},snapshot).result?.title,'other turn')
 assert.equal(overviewForTurn(completed,chat({3:[]})).kind,'review')
 assert.equal(overviewForTurn(completed,undefined).kind,'review')
})

test('later checks, edits, ordinary previews and failed delivery cannot leave a stale formal card',()=>{
 const edit={kind:'tool-result',seq:21,call:{name:'exec_command'},content:[]}
 const ordinary={...preview(21),content:[{type:'text',text:'{"status":"ok","overview":null}'}]}
 const failed={...preview(21),isError:true}
 for(const later of [edit,ordinary,failed])assert.equal(overviewForTurn(completed,chat({3:[preview(10),later]})).result,undefined)
 assert.equal(overviewForTurn(completed,chat({3:[preview(10),edit,preview(30,'refreshed')]})).result?.title,'refreshed')
})

test('nested tool dispatch uses leaf operations and ignores the wrapper completion sequence',()=>{
 const wrapper={kind:'tool-result',seq:40,call:{name:'functions'},subCalls:[preview(30)]}
 assert.equal(overviewForTurn(completed,chat({3:[wrapper]})).result?.title,'final')
 const malformed={kind:'tool-result',seq:50,call:{name:'render_kicad_module_preview'},content:[]}
 assert.equal(overviewForTurn(completed,chat({3:[wrapper,malformed]})).result,undefined)
})
