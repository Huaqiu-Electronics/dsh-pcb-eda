import {getModelUrls} from './service.ts'
import {fetchModelText,type ModelFetchOptions} from './models.ts'
import {footprintModel} from './project-footprint.ts'
import {setTimeout} from 'node:timers/promises'

type Download={raw:string;sourceUrl:string}
// Bounded, short-lived successes only. Failed/cancelled requests are never cached.
const caches=new WeakMap<typeof fetch,Map<string,Download & {expires:number;bytes:number}>>()
export async function downloadFootprint(mfg:string,mpn:string,options:ModelFetchOptions,signal:AbortSignal,fetcher:typeof fetch):Promise<Download>{
 signal.throwIfAborted()
 let cache=caches.get(fetcher);if(!cache){cache=new Map();caches.set(fetcher,cache)}
 const key=JSON.stringify([mfg,mpn,options.maxModelBytes]),now=Date.now()
 for(const [id,item] of cache)if(item.expires<=now)cache.delete(id)
 const known=cache.get(key);if(known)return {raw:known.raw,sourceUrl:known.sourceUrl}
 const retry=async<T>(fn:()=>Promise<T>):Promise<T>=>{
  try{return await fn()}catch(error){
   signal.throwIfAborted()
   // Retry one transient transport/5xx failure here, not a new model round.
   const message=error instanceof Error?error.message:String(error)
   if(!/fetch failed|timed? ?out|timeout|HTTP (?:429|5\d\d)/iu.test(message))throw error
   await setTimeout(200,undefined,{signal});return fn()
  }
 }
 const urls=await retry(()=>getModelUrls(mfg,mpn,options,signal,fetcher))
 if(!urls.footprint)throw new Error(`No footprint model for part:${mfg}:${mpn}`)
 const raw=await retry(()=>fetchModelText(urls.footprint!,'footprint',options,signal,fetcher))
 footprintModel(raw);signal.throwIfAborted()
 const item={raw,sourceUrl:urls.footprint.href,expires:now+15*60*1000,bytes:Buffer.byteLength(raw)}
 if(item.bytes<=16*1024*1024){cache.set(key,item);let bytes=[...cache.values()].reduce((n,x)=>n+x.bytes,0);while(cache.size>128||bytes>16*1024*1024){const id=cache.keys().next().value!;bytes-=cache.get(id)!.bytes;cache.delete(id)}}
 return {raw:item.raw,sourceUrl:item.sourceUrl}
}

/** Settle the entire batch before returning; callers must not write during prepare. */
export async function prepareBatch<T,R>(items:T[],prepare:(item:T)=>Promise<R>):Promise<R[]>{
 const results:R[]=new Array(items.length),failures:{index:number;message:string}[]=[];let cursor=0
 await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
  while(cursor<items.length){const index=cursor++;try{results[index]=await prepare(items[index]!)}catch(error){failures.push({index,message:(error instanceof Error?error.message:String(error)).slice(0,400)})}}
 }))
 if(failures.length)throw new Error(JSON.stringify({code:'FOOTPRINT_BATCH_FAILED',failures:failures.sort((a,b)=>a.index-b.index),written:false,nextAction:'Correct failed assignment indexes. Successful downloads are cached for 15 minutes; retry the batch without clearing project libraries. Format/pin errors need correction, not unchanged retries.'}))
 return results
}

const projectWrites=new Map<string,Promise<void>>()
/** Parallel preparation is safe; project library table updates are serialized. */
export async function writeProject<T>(path:string,signal:AbortSignal,write:()=>Promise<T>):Promise<T>{
 const key=process.platform==='win32'?path.toLowerCase():path,previous=projectWrites.get(key)??Promise.resolve()
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),tail=previous.then(()=>gate)
 projectWrites.set(key,tail)
 try{await previous;signal.throwIfAborted();return await write()}finally{release();if(projectWrites.get(key)===tail)projectWrites.delete(key)}
}
