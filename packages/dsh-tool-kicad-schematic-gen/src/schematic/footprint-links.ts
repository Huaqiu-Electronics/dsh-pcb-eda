import {join} from 'node:path'
import {parse,children,value,applyEdits,quote,type Form} from './sexpr.ts'
import type {ProjectFileSystem} from '../components/import-symbol.ts'
import {alignVendorSymbolIds} from './project.ts'

function property(form:Form,name:string){return children(form,'property').find(p=>value(p)===name)}
function pinNumbers(form:Form):string[]{
 const pins=new Set<string>();
 function walk(node:Form){if(node.head==='pin'){const number=children(node,'number')[0];if(number)pins.add(value(number));}for(const item of node.items)if(typeof item!=='string')walk(item)}
 walk(form);return [...pins].sort();
}
export function footprintRequirements(text:string){
 const root=parse(alignVendorSymbolIds(text));if(root.head!=='kicad_sch')throw new Error('Expected a KiCad schematic');
 const cache=children(root,'lib_symbols')[0],definitions=cache?children(cache,'symbol'):[];
 return children(root,'symbol').flatMap(instance=>{
  const reference=property(instance,'Reference'),libId=value(children(instance,'lib_id')[0]!);
  const ref=reference?value(reference,2):'';
  if(ref.startsWith('#')||libId.startsWith('power:')||children(instance,'on_board').some(p=>value(p)==='no'))return [];
  if(!ref)throw new Error('Physical instance is missing Reference');
  const definition=definitions.find(p=>value(p)===libId);
  if(!definition)throw new Error(`Missing embedded symbol: ${libId}`);
  const fp=property(instance,'Footprint');
  return [{reference:ref,libId,value:property(instance,'Value')?value(property(instance,'Value')!,2):'',footprintId:fp?value(fp,2):'',pinNumbers:pinNumbers(definition),dnp:children(instance,'dnp').some(p=>value(p)==='yes')}];
 });
}

export function assignFootprintText(text:string,mappings:Record<string,string>):string{
 const root=parse(text),edits=[];
 const seen=new Set<string>();
 for(const instance of children(root,'symbol')){
  const p=property(instance,'Reference'),ref=p?value(p,2):'',id=mappings[ref];
  if(id===undefined)continue;
  if(!/^[^:\r\n]+:[^:\r\n]+$/.test(id))throw new Error(`Invalid footprint ID for ${ref}`);
  seen.add(ref);const fp=property(instance,'Footprint');
  if(fp)edits.push({start:fp.start,end:fp.end,text:text.slice(fp.start,fp.end).replace(/^(\(property\s+"Footprint"\s+)"(?:\\.|[^"\\])*"/,(_m,prefix:string)=>prefix+quote(id))});
  else edits.push({start:instance.end-1,end:instance.end-1,text:`\n(property "Footprint" ${quote(id)} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n`});
 }
 for(const ref of Object.keys(mappings))if(!seen.has(ref))throw new Error(`Unknown footprint mapping reference: ${ref}`);
 return applyEdits(text,edits);
}

/** Check the project library table and actual files, not merely nonempty Footprint fields. */
export async function auditFootprints(text:string,projectDir:string,fs:ProjectFileSystem,signal:AbortSignal){
 const project=await fs.resolve(projectDir,{signal}),table=await fs.resolve(join(projectDir,'fp-lib-table'),{signal});
 if(!fs.contains(project,table))throw new Error('Footprint table escapes projectDir');
 const info=await fs.stat(table,signal),libraries=new Map<string,string>();
 if(info){const parsed=parse(await fs.readText(table,signal));if(parsed.head!=='fp_lib_table')throw new Error('Invalid footprint table');for(const lib of children(parsed,'lib'))libraries.set(value(children(lib,'name')[0]!),value(children(lib,'uri')[0]!));}
 const unresolved=[];const requirements=footprintRequirements(text);
 for(const part of requirements){
  const pieces=part.footprintId.split(':'),uri=libraries.get(pieces[0]!);
  if(pieces.length!==2||!uri||!uri.startsWith('${KIPRJMOD}/')||/[\\/]/.test(pieces[1]!)){unresolved.push({...part,reason:'No project-local footprint registration'});continue;}
  const file=await fs.resolve(join(projectDir,uri.slice('${KIPRJMOD}/'.length),`${pieces[1]}.kicad_mod`),{signal});
  if(!fs.contains(project,file)||(await fs.stat(file,signal))?.type!=='file')unresolved.push({...part,reason:'Local footprint file missing or outside project'});
 }
 return {status:unresolved.length?'unresolved':'ready',total:requirements.length,resolved:requirements.length-unresolved.length,unresolved};
}

