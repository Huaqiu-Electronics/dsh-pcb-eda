import {createHash} from 'node:crypto'
import {join,isAbsolute,relative} from 'node:path'
import {partIdentity} from './identity.ts'
import {footprintRequirements,assignFootprintText,auditFootprints} from '../schematic/footprint-links.ts'
import {type ModelFetchOptions} from './models.ts'
import {downloadFootprint,prepareBatch,writeProject} from './footprint-download.ts'
import {libraryName,type ProjectFileSystem} from './import-symbol.ts'
import {footprintModel,prepareProjectFootprint} from './project-footprint.ts'

export interface FootprintAssignment {references:string[];manufacturer_id?:string;mpn?:string;footprintPath?:string;allowedExtraPads?:string[];extraPadReason?:string}
async function scopedText(path:string,workspace:string,fs:ProjectFileSystem,signal:AbortSignal,max:number){
 const base=await fs.resolve(workspace,{signal}),target=await fs.resolve(path,{cwd:workspace,signal});
 if(!fs.contains(base,target)||(await fs.stat(target,signal))?.type!=='file')throw new Error(`Input must be a file inside workspace: ${path}`);
 const text=await fs.readText(target,signal);if(Buffer.byteLength(text)>max)throw new Error('Input exceeds configured byte limit');
 return {target,text};
}

/** Localize exact selected models while preserving module symbols, pin positions and wires. */
export async function localizeFootprints(input:{schematicPath:string;projectDir:string;assignments:FootprintAssignment[];targetPath?:string},workspace:string,options:ModelFetchOptions,fs:ProjectFileSystem,policy:Parameters<ProjectFileSystem['writeText']>[4],signal:AbortSignal,fetcher:typeof fetch=fetch){
 const source=await scopedText(input.schematicPath,workspace,fs,signal,10000000),base=await fs.resolve(workspace,{signal}),project=await fs.resolve(input.projectDir,{cwd:workspace,signal});
 if(!fs.contains(base,project)||(await fs.stat(project,signal))?.type!=='directory'||!isAbsolute(project.displayPath))throw new Error('projectDir must be an existing workspace directory');
 const parts=footprintRequirements(source.text),refs=new Map(parts.map(p=>[p.reference,p]));
 const sourceHash=createHash('sha256').update(source.text).digest('hex');
 const manifest=await fs.resolve(join(project.displayPath,'libraries','mappings',`${sourceHash.slice(0,24)}.json`),{signal});
 if(!fs.contains(project,manifest))throw new Error('Mapping manifest escapes project');
 let existing:any={version:1,sourceHash,mappings:{},records:[]};
 const manifestInfo=await fs.stat(manifest,signal);
 if(manifestInfo){existing=JSON.parse(await fs.readText(manifest,signal));if(existing.version!==1||existing.sourceHash!==sourceHash||!Array.isArray(existing.records)||!existing.mappings||typeof existing.mappings!=='object'||Array.isArray(existing.mappings))throw new Error('Invalid footprint mapping manifest');}
 const target=input.targetPath?await fs.resolve(input.targetPath,{cwd:workspace,signal}):undefined;
 if(target&&(!fs.contains(base,target)||!target.displayPath.endsWith('.kicad_sch')))throw new Error('targetPath must be a workspace .kicad_sch');
 const targetInfo=target?await fs.stat(target,signal):undefined;
 if(targetInfo&&targetInfo.type!=='file')throw new Error('targetPath must be a file');
 const selected=new Set<string>(),models=new Map<string,Promise<{raw:string;sourceUrl:string}>>();
 // Validate references before concurrent downloads; duplicate selection is a plan error.
 for(const assignment of input.assignments){
  if(!Array.isArray(assignment.references)||!assignment.references.length)throw new Error('Each assignment needs references');
  for(const ref of assignment.references){if(!refs.has(ref)||selected.has(ref))throw new Error(`Unknown or repeated reference: ${ref}`);selected.add(ref);}
 }
 const prepared=await prepareBatch(input.assignments,async assignment=>{
  const local=assignment.footprintPath!==undefined;
  if(local?(!!assignment.manufacturer_id||!!assignment.mpn):(!assignment.manufacturer_id||!assignment.mpn))throw new Error('Choose footprintPath OR exact manufacturer_id and mpn');
  if(!local)partIdentity(assignment as unknown as Record<string,unknown>);
  const identity=local?`file:${assignment.footprintPath}`:`part:${assignment.manufacturer_id}:${assignment.mpn}`;
  const old=existing.records.find((r:any)=>r.identity===identity),cached=models.get(identity);
  let raw:string,sourceUrl:string;
  if(cached){({raw,sourceUrl}=await cached);}
  else if(old){
   const known=await scopedText(old.relativePath?join(project.displayPath,old.relativePath):old.footprintPath,project.displayPath,fs,signal,options.maxModelBytes);
   if(createHash('sha256').update(known.text).digest('hex')!==old.footprintSha256)throw new Error('Previously localized footprint changed; inspect before replacing');
   raw=known.text;sourceUrl=old.sourceUrl;
  }else if(local){raw=(await scopedText(assignment.footprintPath!,workspace,fs,signal,options.maxModelBytes)).text;sourceUrl=assignment.footprintPath!;}
  else{const pending=downloadFootprint(assignment.manufacturer_id!,assignment.mpn!,options,signal,fetcher);models.set(identity,pending);({raw,sourceUrl}=await pending);}
  models.set(identity,Promise.resolve({raw,sourceUrl}));
  const model=footprintModel(raw),pads=[...new Set(model.summary.pads.map(p=>p.number).filter(Boolean))].sort();
  const allowed=assignment.allowedExtraPads??[];
  if(allowed.length&&!assignment.extraPadReason?.trim())throw new Error('Extra pads require an explicit mechanical/thermal pad explanation');
  for(const ref of assignment.references){const pins=refs.get(ref)!.pinNumbers;const missing=pins.filter(p=>!pads.includes(p)),extra=pads.filter(p=>!pins.includes(p)&&!allowed.includes(p));if(!pins.length||pins.includes('')||missing.length||extra.length)throw new Error(`PIN_PAD_MISMATCH ${ref}: missing [${missing}], unexplained extra [${extra}]`);}
  const nickname=local?`Module_${createHash('sha256').update(model.text).digest('hex').slice(0,16)}`:libraryName(assignment.manufacturer_id!,assignment.mpn!);
  return {assignment,identity,raw:model.text,nickname,sourceUrl,pads,footprintId:`${nickname}:${model.name}`};
 });
 const prospective={...existing.mappings};
 for(const item of prepared)for(const ref of item.assignment.references)prospective[ref]=item.footprintId;
 const patched=assignFootprintText(source.text,prospective);
 if(await fs.readText(source.target,signal)!==source.text)throw new Error('Source changed during localization');
 if(targetInfo&&target!.displayPath!==source.target.displayPath&&await fs.readText(target!,signal)!==patched)throw new Error('Target already exists with different content');
 // Model validation for the entire batch precedes writes. Later I/O failure can leave reusable libraries.
 return writeProject(project.displayPath,signal,async()=>{
 if(await fs.readText(source.target,signal)!==source.text)throw new Error('Source changed before localization commit');
 for(const item of prepared){
  const saved=await prepareProjectFootprint(project,item.nickname,item.raw,fs,signal);await saved.write(policy);
  for(const ref of item.assignment.references)existing.mappings[ref]=saved.footprintId;
  existing.records=existing.records.filter((r:any)=>r.identity!==item.identity);
  existing.records.push({identity:item.identity,sourceUrl:item.sourceUrl,footprintPath:saved.footprintPath,relativePath:relative(project.displayPath,saved.footprintPath).replaceAll('\\','/'),footprintId:saved.footprintId,footprintSha256:saved.footprintSha256,padNumbers:item.pads,allowedExtraPads:item.assignment.allowedExtraPads??[],extraPadReason:item.assignment.extraPadReason??null});
 }
 let output:string|null=null;
 if(target){
  if(target.displayPath===source.target.displayPath&&await fs.readText(target,signal)!==source.text)throw new Error('Source changed during localization');
  await fs.writeText(target,patched,targetInfo?{kind:'replaceIfVersion',version:targetInfo.version}:{kind:'createIfAbsent'},signal,policy);output=target.displayPath;
 }
 await fs.writeText(manifest,JSON.stringify(existing,null,2)+'\n',manifestInfo?{kind:'replaceIfVersion',version:manifestInfo.version}:{kind:'createIfAbsent'},signal,policy);
 return {stage:output?'applied':'prepared',sourceUpdated:output===source.target.displayPath,mappingPath:manifest.displayPath,mappings:existing.mappings,schematicPath:output,validationScope:'source_with_mapping_applied',validation:await auditFootprints(patched,project.displayPath,fs,signal),nextAction:'Prepared means mappings and libraries are ready, NOT that the unchanged source was updated. Use check_mapping on this source, persist footprintMappingPath in importModule, then check the generated final schematic. Do not diagnose unchanged-source check=unresolved as download failure. Dimensions and electrical compatibility require separate confirmation.'};
 });
}

export async function inspectModuleFootprints(path:string,project:string|undefined,workspace:string,fs:ProjectFileSystem,signal:AbortSignal,checkMapping=false){
 const source=await scopedText(path,workspace,fs,signal,10000000);
 if(!project)return {schematicPath:source.target.displayPath,parts:footprintRequirements(source.text)};
 const base=await fs.resolve(workspace,{signal}),target=await fs.resolve(project,{cwd:workspace,signal});if(!fs.contains(base,target)||(await fs.stat(target,signal))?.type!=='directory')throw new Error('projectDir must be inside workspace');
 if(!checkMapping)return {...await auditFootprints(source.text,target.displayPath,fs,signal),validationScope:'actual_schematic',nextAction:'This checks actual Footprint fields, not prepared mappings. Use check_mapping for unchanged source modules; check the generated final schematic after importModule applies mappings.'};
 const hash=createHash('sha256').update(source.text).digest('hex');
 const manifest=await fs.resolve(join(target.displayPath,'libraries','mappings',`${hash.slice(0,24)}.json`),{signal});
 if(!fs.contains(target,manifest))throw new Error('Mapping escapes projectDir');
 if(!await fs.stat(manifest,signal))return {stage:'not_prepared',status:'unresolved',validationScope:'source_with_mapping_applied',nextAction:'No mapping exists for this exact source revision. Import explicitly selected footprints first.'};
 const record=JSON.parse(await fs.readText(manifest,signal));
 if(record.version!==1||record.sourceHash!==hash||!record.mappings||typeof record.mappings!=='object'||Array.isArray(record.mappings))throw new Error('Invalid footprint mapping manifest');
 return {...await auditFootprints(assignFootprintText(source.text,record.mappings),target.displayPath,fs,signal),stage:'prepared',mappingPath:manifest.displayPath,validationScope:'source_with_mapping_applied',sourceUpdated:false,nextAction:'Persist footprintMappingPath in importModule; final check must use the generated schematic.'};
}
