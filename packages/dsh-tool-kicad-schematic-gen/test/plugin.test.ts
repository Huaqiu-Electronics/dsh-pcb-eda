import assert from 'node:assert/strict'
import {test} from 'node:test'
import {apply,inject,name,resolveConfig} from '../src/index.ts'

function harness(host?:object){
  const tools=new Map<string,any>();const cleanups:Array<()=>void>=[];let provider:any
  const ctx={effect:(fn:()=>any)=>{const result=fn();if(typeof result==='function')cleanups.push(result);return result},
    tools:{register:(tool:any)=>{assert.ok(!tools.has(tool.name),'duplicate tool');tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
    skills:{registerProvider:(fn:()=>any)=>{provider=fn();return()=>{provider=undefined}}},
    get:()=>host,
  }
  apply(ctx as never)
  return{tools,getProvider:()=>provider,dispose:()=>cleanups.reverse().forEach(fn=>fn())}
}

test('schematic plugin owns fourteen tools while component search is a separate plugin',async()=>{
  const h=harness()
  assert.equal(name,'@local/dsh-tool-kicad-schematic-gen')
  assert.deepEqual(inject,['tools','fs','sandboxPolicy','skills','webServer'])
  assert.equal(h.tools.size,14)
  assert.ok(h.tools.has('analyze_kicad_module'))
  assert.ok(!h.tools.has('search_kicad_parts'));assert.ok(!h.tools.has('get_kicad_supply_chain'))
  assert.ok(!h.tools.has('search_hqsch_parts'))
  assert.ok(h.tools.has('import_kicad_symbol'));assert.ok(h.tools.has('download_eda_module_schematic'))
  assert.ok(h.tools.has('edit_kicad_flat_schematic'))
  assert.equal((await h.getProvider().list())[0].name,'kicad-schematic-design')
  h.dispose();assert.equal(h.tools.size,0);assert.equal(h.getProvider(),undefined)
})
test('unavailable HQ Edge fails only module download, not plugin registration',async()=>{
  const h=harness()
  await assert.rejects(h.tools.get('download_eda_module_schematic').execute({moduleId:'1'},{signal:new AbortController().signal}),/Open KiCad with HQ Edge/)
  assert.equal(h.tools.size,14);h.dispose()
})
test('partial configuration preserves unrelated limits and bundled template paths',()=>{
  const config=resolveConfig({components:{maxModelBytes:2000000},modules:{search:{maxResults:5}}})
  assert.equal(config.components.maxModelBytes,2000000);assert.equal(config.components.requestTimeoutMs,15000)
  assert.equal(config.modules.search.maxResults,5);assert.equal(config.modules.download.maxZipBytes,20000000)
  assert.ok(config.schematic.flatTemplateDir.includes('dsh-tool-kicad-schematic-gen'))
})
