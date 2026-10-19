import assert from 'node:assert/strict'
import {test} from 'node:test'
import {apply,Config,name} from '../src/components/index.ts'
test('component tools expose canonical part-search identities and optional import directories',()=>{
 const tools:any[]=[]
 const ctx={effect:(fn:()=>unknown)=>fn(),tools:{register:(tool:unknown)=>{tools.push(tool);return()=>{}}}}
 apply(ctx as never,Config({
  requestTimeoutMs:15000,maxModelBytes:1000000,
  structuredApiBaseUrl:'https://task.eda.cn/prod-api/outside/datasheet/v1/components/',
  datasheetRequestTimeoutMs:30000,maxPdfBytes:12000000,maxPdfPages:12,
  maxTextChars:12000,maxImages:5,allowedPdfHosts:['file.elecfans.com','file1.elecfans.com'],
 }))
 assert.equal(name,'@local/dsh-tool-kicad-library')
 assert.deepEqual(tools.map(t=>t.name),['get_kicad_component_models','import_kicad_symbol','get_kicad_datasheet','import_kicad_component','localize_kicad_module_footprints'])
 assert.ok(tools.every(t=>!t.description.includes('search_kicad_components')))
 for (const tool of tools.filter(t=>t.name!=='localize_kicad_module_footprints')) {
  const importing=tool.name.startsWith('import_')
  assert.deepEqual(Object.keys(tool.parameters.properties),importing
   ? ['manufacturer_id','mpn','projectDir'] : ['manufacturer_id','mpn'],tool.name)
  assert.deepEqual(tool.parameters.required,['manufacturer_id','mpn'],tool.name)
  assert.equal(tool.parameters.additionalProperties,false,tool.name)
  assert.equal(tool.parameters.anyOf,undefined,tool.name)
 }
})
