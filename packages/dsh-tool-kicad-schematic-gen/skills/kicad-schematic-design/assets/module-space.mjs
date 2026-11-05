/** Native-geometry space screening before drawing. Suggested sizes never alter the plan. */
export function assessModuleSpace(mod,catalog,style={},{paper}={}){
 const grid=style.grid??1.27,inset=style.inset??2.54,padding=style.contentPadding??2.54;
 const snap=n=>Number((Math.ceil(n/grid-1e-8)*grid).toFixed(2));
 const [width,height]=mod.region.size,description=String(mod.region.description??'');
 const textHeight=1.27*(style.textHeightFactor??1.5),lineHeight=style.lineHeight??2.54;
 const lineWidth=Math.max(grid,width-2*inset),charWidth=1.27*(style.textWidthFactor??1.25);
 const descriptionLines=description.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((sum,c)=>sum+(c.codePointAt(0)>255?2:1),0)*charWidth/lineWidth)),0);
 const header=(style.titleOffset??3.81)+textHeight/2+padding;
 const footer=(style.descriptionBottom??3.81)+textHeight/2+(descriptionLines-1)*lineHeight+padding;
 const usable=[Math.max(0,width-2*inset),Math.max(0,height-header-footer)];
 const owned=new Set(Object.values(mod.references)),components=catalog.filter(o=>owned.has(o.reference));
 const measured=[],unmeasured=[];
 for(const c of components){
  const b=c.bounds,w=b?.right-b?.left,h=b?.bottom-b?.top;
  if(![w,h].every(n=>Number.isFinite(n)&&n>0)){unmeasured.push(c.reference);continue;}
  measured.push({reference:c.reference,width:w,height:h});
 }
 const gap=7.62; // advisory allowance for fields and local lead channels, not a clearance rule
 const area=measured.reduce((n,c)=>n+(c.width+gap)*(c.height+gap),0),availableArea=usable[0]*usable[1];
 const pressure=availableArea&&measured.length?area/availableArea:null;
 // Only fixed pin geometry can block dispatch. Field anchors/native drawing boxes
 // may be deliberately rearranged, so their conservative size is advisory only.
 const pinSpans=components.flatMap(c=>{
  const pts=(c.pins??[]).map(p=>p.at).filter(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite));
  return pts.length?[{reference:c.reference,width:Math.max(...pts.map(p=>p[0]))-Math.min(...pts.map(p=>p[0])),height:Math.max(...pts.map(p=>p[1]))-Math.min(...pts.map(p=>p[1]))}]:[];
 });
 const oversized=pinSpans.filter(c=>!((c.width<=usable[0]&&c.height<=usable[1])||(c.height<=usable[0]&&c.width<=usable[1])));
 // Native boxes already include pin/field extents. Warn only when the padded estimate
 // exceeds the entire content area; lower thresholds flag almost every valid module.
 const status=usable.some(n=>n<=0)||oversized.length?'insufficient':pressure>=1?'tight':unmeasured.length||!measured.length?'unmeasured':'clear';
 const result={moduleId:mod.id,status,currentSize:[width,height],usableSize:usable.map(n=>Number(n.toFixed(2))),
  componentCount:components.length,unmeasuredCount:unmeasured.length,pressure:pressure===null?null:Number(pressure.toFixed(2)),
  oversizedReferences:[...new Set(oversized.map(c=>c.reference))],
  limitations:'Native bounds with estimated text/channel allowance; not a packing proof, automatic placement or visual approval.'};
 if(status==='tight'||status==='insufficient'){
  const scale=Math.max(1,Math.sqrt(area/Math.max(1,availableArea)/.85));
  result.suggestedSize=[snap(Math.max(width,usable[0]*scale+2*inset,...oversized.map(c=>Math.min(c.width,c.height)+2*inset))),
   snap(Math.max(height,usable[1]*scale+header+footer,...oversized.map(c=>Math.max(c.width,c.height)+header+footer)))];
  const page={A4:[297,210],A3:[420,297],A2:[594,420],A1:[841,594],A0:[1189,841]}[paper];
  if(page&&Array.isArray(mod.region.origin)){
   const max=page.map((n,i)=>Math.floor((n-mod.region.origin[i]-inset)/grid)*grid);
   if(result.suggestedSize[0]>max[0]&&max[0]>=width){
    result.suggestedSize[0]=Number(max[0].toFixed(2));
    result.suggestedSize[1]=snap(Math.max(result.suggestedSize[1],area/(.85*Math.max(1,max[0]-2*inset))+header+footer));
   }
   result.fitsPage=result.suggestedSize.every((n,i)=>n<=max[i]+1e-6);
  }
  result.nextAction='Parent should review frame size, page limits and adjacent frames before drawing. On first space-related build failure request one coordinated resize/re-layout; do not repeatedly nudge individual parts or shrink text.';
 }
 return result;
}
