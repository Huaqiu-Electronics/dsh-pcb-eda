/** Approximate layout diagnostics for review, never electrical approval or automatic rejection. */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const intersection=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
const area=b=>(b.right-b.left)*(b.bottom-b.top);
const textSummary=o=>({reference:o.reference??null,field:o.field??o.kind,text:o.text,bounds:o.bounds});

/** Independent text review includes explicit anchors; it does not certify readability or replace actual images. */
export async function describeSchematicReadability(contract,result){
 const {inspectSchematicText}=await import(pathToFileURL(contract.builderPath));
 const style=JSON.parse(readFileSync(new URL('../templates/frame-style.json',import.meta.url),'utf8'));
 const texts=inspectSchematicText(readFileSync(result.schematicPath,'utf8'),style),issues=[];
 for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
  const a=texts[i],b=texts[j],shared=intersection(a.bounds,b.bounds);
  // A tiny conservative edge touch is not a useful defect; substantial text overlap requires image review.
  if(shared<=0.15||shared/Math.min(area(a.bounds),area(b.bounds))<0.12)continue;
  issues.push({code:'TEXT_OVERLAP_REVIEW',objects:[textSummary(a),textSummary(b)],
   bounds:{left:Math.min(a.bounds.left,b.bounds.left),right:Math.max(a.bounds.right,b.bounds.right),top:Math.min(a.bounds.top,b.bounds.top),bottom:Math.max(a.bounds.bottom,b.bounds.bottom)}});
 }
 return {status:issues.length?'review_required':'no_detected_text_overlap',checkedTexts:texts.length,issues,
  limitations:'Estimated visible text bounds, including explicit Reference/Value and labels. Pin-number/body/wire occlusion and full visual quality still need actual image review.'};
}

export async function describeModuleLayout(contract,mod,result){
 const {inspectSchematicObjects}=await import(pathToFileURL(contract.builderPath));
 const style=JSON.parse(readFileSync(new URL('../templates/frame-style.json',import.meta.url),'utf8'));
 const objects=inspectSchematicObjects(readFileSync(result.schematicPath,'utf8'),style);
 const summary=o=>o?{uuid:o.uuid,type:o.type,reference:o.reference,name:o.name,libId:o.libId,at:o.at,bounds:o.bounds}:null;
 const byId=new Map(objects.map(o=>[o.uuid,o]));
 const overlaps=(result.layoutWarnings??[]).map(w=>({...w,object:summary(byId.get(w.uuid)),other:summary(byId.get(w.otherUuid))}));
 const powerWireCrossings=(result.powerLayout?.issues??[]).filter(issue=>issue.code==='POWER_SYMBOL_WIRE_CROSSING');
 const frame=result.frames[0];
 const [x,y]=frame.start,[right,bottom]=frame.end;
 const [width,height]=[right-x,bottom-y];
 const content=objects.filter(o=>['symbol','wire','label','global_label','junction','no_connect'].includes(o.type));
 const outside=content.filter(o=>{const b=o.bounds;return b&&(b.left<x-1e-6||b.right>x+width+1e-6||b.top<y-1e-6||b.bottom>y+height+1e-6);}).map(summary);
 const readability=await describeSchematicReadability(contract,result);
 const reviewIssues=[],crops=[],seen=new Set();
 const add=(code,items,details={})=>{
  const key=code+items.map(o=>o.uuid).sort().join('/');if(seen.has(key))return;seen.add(key);
  const boxes=items.flatMap(o=>o.bounds?[o.bounds]:[]);if(!boxes.length)return;
  const start=[Math.max(x,Math.min(...boxes.map(b=>b.left))-3.81),Math.max(y,Math.min(...boxes.map(b=>b.top))-3.81)];
  const end=[Math.min(x+width,Math.max(...boxes.map(b=>b.right))+3.81),Math.min(y+height,Math.max(...boxes.map(b=>b.bottom))+3.81)];
  const references=[...new Set(items.flatMap(o=>o.reference?[o.reference]:[]))];
  if(end.some((v,i)=>v<=start[i])){
   if(code==='POWER_SYMBOL_WIRE_CROSSING')reviewIssues.push({...details,code,references});
   if(code==='MODULE_LAYOUT_OUTSIDE_FRAME')reviewIssues.push({code,references,message:'Object lies outside the module frame and cannot be shown in a frame crop.'});
   return;
  }
  reviewIssues.push({...details,code,references,start,end});
  // Conservative power bounding boxes stay in the report and full frame.
  if(code==='LAYOUT_OVERLAP_REVIEW')return;
  const priority=code==='POWER_SYMBOL_WIRE_CROSSING'?2:code==='TEXT_OVERLAP_REVIEW'?1:0;
  const candidate={name:`${mod.id} ${references.join('/')||code}`,pageName:contract.plan.project.name,start,end,weight:1,priority};
  const existing=crops.find(r=>intersection({left:r.start[0],top:r.start[1],right:r.end[0],bottom:r.end[1]},
   {left:start[0],top:start[1],right:end[0],bottom:end[1]})>0.35*Math.min((r.end[0]-r.start[0])*(r.end[1]-r.start[1]),(end[0]-start[0])*(end[1]-start[1])));
  if(existing){
   existing.start=start.map((v,i)=>Math.min(v,existing.start[i]));
   existing.end=end.map((v,i)=>Math.max(v,existing.end[i]));
   existing.priority=Math.max(priority,existing.priority);
   existing.weight++;
  }
  else crops.push(candidate);
 };
 for(const issue of readability.issues)add(issue.code,issue.objects.map((o,i)=>({...o,uuid:`${issue.code}-${reviewIssues.length}-${i}`})));
 for(const item of outside)add('MODULE_LAYOUT_OUTSIDE_FRAME',[item]);
 for(const item of overlaps){const a=item.object,b=item.other;if(a&&b)add('LAYOUT_OVERLAP_REVIEW',[a,b]);}
 for(const {code,uuid,otherUuid,reference,net,from,to} of powerWireCrossings){
  const symbol=summary(byId.get(uuid));
  if(symbol)add(code,[{...symbol,uuid:`${uuid}/${otherUuid}`}],{reference,net,from,to,message:'A wire crosses a drawn power-symbol stroke beyond the electrical pin. Change its landing or rotation and keep the same net.'});
 }
 for(const {code,bounds,...details} of result.portLabelIssues??[]){
  const uuid=`${details.reference}/${details.pins.map(p=>p.pin).join('/')}`;
  add(code,[{uuid,reference:details.reference,bounds}],details);
 }
 const regions=crops.sort((a,b)=>b.priority-a.priority||b.weight-a.weight).map(({weight,priority,...r})=>r);
 const fitted=frame.start.some((v,i)=>Math.abs(v-mod.region.origin[i])>1e-6)||
  frame.end.some((v,i)=>Math.abs(v-mod.region.origin[i]-mod.region.size[i])>1e-6);
 return {status:outside.length||powerWireCrossings.length||result.portLabelIssues?.length||readability.issues.length||result.fieldLayout?.unresolved?.length?'review_required':'no_measured_overflow',
  frame:{start:frame.start,end:frame.end,mode:mod.region.autoFit===false?'fixed':fitted?'fitted':'reserved'},
  outside,overlaps,powerWireCrossings,readability,reviewIssues,regions,
  unmeasured:content.filter(o=>!o.bounds).map(o=>o.uuid),
  nextAction:outside.length?'Review the listed objects against the frame. Ask the parent for more space if necessary; do not move unrelated modules.':'Review actual overlap images; approximate bounding-box overlap alone is not a reason to rebuild.',
  limitations:'Approximate drawing bounds; excludes frame text and does not prove clearance, readability or electrical correctness.'};
}
