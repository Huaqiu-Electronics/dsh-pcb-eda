/** Required, version-bound design document input for schematic generation. */
import {createHash} from 'node:crypto'
import {readFileSync,statSync,realpathSync} from 'node:fs'

export interface DesignPlanReference {path:string;sha256:string}
export interface DesignPlan extends DesignPlanReference {text:string}
export const DESIGN_PLAN_MAX_BYTES=1024*1024

export function designPlanReference(input:unknown):DesignPlanReference {
 const plan=input as Partial<DesignPlanReference>|undefined
 if(!plan||typeof plan.path!=='string'||!plan.path.trim()||typeof plan.sha256!=='string'||!/^[a-f0-9]{64}$/.test(plan.sha256))
  throw new Error('DESIGN_PLAN_REQUIRED: save the hardware design document, read it with run-design.mjs --read-plan <path>, then supply designPlan:{path,sha256}. Do not generate first and write the document afterwards.')
 return {path:plan.path,sha256:plan.sha256}
}

/** Structural check only; the model must still review engineering completeness. */
export function inspectDesignPlan(path:string,text:string):DesignPlan {
 if(Buffer.byteLength(text,'utf8')>DESIGN_PLAN_MAX_BYTES||text.trim().length<200||!/^#\s+\S/m.test(text)||!/^##\s+\S/m.test(text))
  throw new Error('DESIGN_PLAN_INCOMPLETE: provide a saved Markdown hardware plan with a title, substantive sections, and at least 200 characters. Review requirements, parts, circuits, connections and budgets before generation.')
 return {path,sha256:createHash('sha256').update(text).digest('hex'),text}
}

export function matchDesignPlan(reference:DesignPlanReference,text:string):DesignPlan {
 const plan=inspectDesignPlan(reference.path,text)
 if(plan.sha256!==reference.sha256)throw new Error('DESIGN_PLAN_CHANGED: the document changed after it was read. Read the latest document and update the design script/connection plan before rebuilding with its new sha256.')
 return plan
}

export function readDesignPlan(path:string):DesignPlan {
 try {
  const canonical=realpathSync(path),info=statSync(canonical)
  if(!info.isFile()||info.size>DESIGN_PLAN_MAX_BYTES)throw new Error('expected a document file no larger than 1 MiB')
  return inspectDesignPlan(canonical,new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(canonical)))
 }catch(error){throw new Error(`DESIGN_PLAN_UNAVAILABLE: ${path}: ${error instanceof Error?error.message:String(error)}`,{cause:error})}
}

export function loadDesignPlan(input?:DesignPlanReference):DesignPlan {
 const reference=designPlanReference(input??{path:process.env.DSH_DESIGN_BRIEF_PATH,sha256:process.env.DSH_DESIGN_BRIEF_SHA256})
 const plan=readDesignPlan(reference.path)
 return matchDesignPlan({...reference,path:plan.path},plan.text)
}
