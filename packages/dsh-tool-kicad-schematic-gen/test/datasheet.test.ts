import assert from 'node:assert/strict'
import {test} from 'node:test'
import {getDatasheet, type DatasheetOptions} from '../src/components/datasheet.ts'
import {pdfFixture} from './pdf-fixture.ts'
const options: DatasheetOptions={structuredApiBaseUrl:'https://task.example.test/components/',requestTimeoutMs:1000,maxPdfBytes:100000,maxPdfPages:1,maxTextChars:1000,maxImages:2,allowedPdfHosts:['files.example.test']}
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})

test('returns structured text with no model or PDF fetch',async()=>{
 const urls:string[]=[]
 const fetcher=(async(input:URL|RequestInfo)=>{
  const url=String(input);urls.push(url)
  return url.includes('/count')?json({hasLabelData:true,datasheetUrl:'https://files.example.test/exact.pdf'}):json({records:[{contentType:8,pageNo:1,readingOrder:1,content:'VIN 3.0-5.5 V'}]})
 }) as typeof fetch
 const result=await getDatasheet('42','IC-1',options,new AbortController().signal,fetcher)
 assert.equal(result.source,'structured');assert.equal(result.sections[0]?.text,'VIN 3.0-5.5 V');assert.equal(urls.length,2)
})
test('PDF fallback uses the exact part endpoint rather than first-page keyword search',async()=>{
 const urls:string[]=[]
 const fetcher=(async(input:URL|RequestInfo,init?:RequestInit)=>{
  const url=String(input);urls.push(url)
  if(url.includes('/count'))return json({hasLabelData:false})
  if(url.endsWith('/productDetail')){
   assert.deepEqual(JSON.parse(String(init?.body)),{manufacturer_id:'42',mpn:'IC-1'})
   return json({code:200000,result:{mpn:'IC-1',mfgId:42,mfg:'Demo',fileInfoVOList:[{fileType:'Datasheet',fileUrl:'https://files.example.test/right.pdf'}]}})
  }
  assert.equal(url,'https://files.example.test/right.pdf');return new Response(new Uint8Array(pdfFixture()))
 }) as typeof fetch
 const result=await getDatasheet('42','IC-1',options,new AbortController().signal,fetcher)
 assert.equal(result.source,'pdf');assert.match(result.sections[0]?.text??'',/Selectable PDF text/);assert.equal(result.truncated,true)
 assert.equal(urls.length,3)
})
test('reuses structured lookup PDF URL without querying the part again',async()=>{
 let count=0
 const fetcher=(async(input:URL|RequestInfo)=>{count++;return String(input).includes('/count')?json({hasLabelData:false,datasheetUrl:'https://files.example.test/right.pdf'}):new Response(new Uint8Array(pdfFixture()))}) as typeof fetch
 assert.equal((await getDatasheet('42','IC-1',options,new AbortController().signal,fetcher)).source,'pdf');assert.equal(count,2)
})
test('missing documents stay missing and network errors are not hidden',async()=>{
 const fetcher=(async(input:URL|RequestInfo)=>String(input).includes('/count')?json({hasLabelData:false}):json({code:200000,result:{mpn:'IC-1',mfgId:42,mfg:'Demo'}})) as typeof fetch
 assert.equal((await getDatasheet('42','IC-1',options,new AbortController().signal,fetcher)).status,'missing')
 await assert.rejects(getDatasheet('42','IC-1',options,new AbortController().signal,(async()=>new Response('down',{status:503})) as typeof fetch),/HTTP 503/)
})
test('rejects disallowed PDF hosts and marks truncated structured text',async()=>{
 await assert.rejects(getDatasheet('42','IC-1',options,new AbortController().signal,(async()=>json({hasLabelData:false,datasheetUrl:'https://private.example.test/file.pdf'})) as typeof fetch),/allowedPdfHosts/)
 const fetcher=(async(input:URL|RequestInfo)=>String(input).includes('/count')?json({hasLabelData:true}):json({records:[{contentType:8,content:'x'.repeat(1500)}]})) as typeof fetch
 const result=await getDatasheet('42','IC-1',options,new AbortController().signal,fetcher)
 assert.equal(result.sections[0]?.text.length,1000);assert.equal(result.truncated,true)
})
