import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {parse,children,value,quote} from '../schematic/sexpr.ts'
import {summarizeFootprint} from './models.ts'
import type {ProjectFileSystem} from './import-symbol.ts'

export function footprintModel(raw:string){
 const form=parse(raw),name=value(form);
 if(!['footprint','module'].includes(form.head)||!name||/[<>:"/\\|?*\x00-\x1f]/u.test(name)||/[. ]$/u.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))throw new Error('Invalid KiCad footprint or unsafe footprint name');
 const summary=summarizeFootprint(raw);
 if(summary.status!=='parsed'||!summary.padCount)throw new Error('Footprint must have parsed pads');
 return {name,summary,text:raw.endsWith('\n')?raw:`${raw}\n`};
}

/** Preflight all destinations before writing; preserve existing tables and legacy layouts. */
export async function prepareProjectFootprint(project:Awaited<ReturnType<ProjectFileSystem['resolve']>>,nickname:string,raw:string,fs:ProjectFileSystem,signal:AbortSignal){
 const model=footprintModel(raw);
 const legacy=await fs.resolve(join(project.displayPath,`${nickname}.pretty`),{signal});
 const legacyExists=await fs.stat(legacy,signal)!==undefined;
 const footprint=await fs.resolve(join(project.displayPath,...(legacyExists?[]:['libraries','footprints']),`${nickname}.pretty`,`${model.name}.kicad_mod`),{signal});
 const table=await fs.resolve(join(project.displayPath,'fp-lib-table'),{signal});
 if(!fs.contains(project,footprint)||!fs.contains(project,table))throw new Error('Footprint targets must stay inside projectDir');
 const info=await fs.stat(footprint,signal),tableInfo=await fs.stat(table,signal);
 if(info&&(info.type!=='file'||await fs.readText(footprint,signal)!==model.text))throw new Error('Footprint already exists with different content');
 if(tableInfo&&tableInfo.type!=='file')throw new Error('fp-lib-table must be a file');
 const uri=`\${KIPRJMOD}/${legacyExists?'':'libraries/footprints/'}${nickname}.pretty`;
 const entry=`  (lib (name ${quote(nickname)})(type "KiCad")(uri ${quote(uri)})(options "")(descr ""))`;
 const old=tableInfo?await fs.readText(table,signal):null;
 let next:string|null=null;
 if(old===null)next=`(fp_lib_table\n  (version 7)\n${entry}\n)\n`;
 else{
  const root=parse(old);if(root.head!=='fp_lib_table')throw new Error('fp-lib-table must be an fp_lib_table');
  const matches=children(root,'lib').filter(lib=>children(lib,'name').some(name=>value(name)===nickname));
  if(matches.length){if(matches.length!==1||value(children(matches[0]!,'uri')[0]!)!==uri||value(children(matches[0]!,'type')[0]!)!=='KiCad')throw new Error('Footprint library table already defines this name with different metadata');}
  else next=old.slice(0,root.end-1)+`\n${entry}\n`+old.slice(root.end-1);
 }
 return {footprintId:`${nickname}:${model.name}`,footprintPath:footprint.displayPath,footprintTablePath:table.displayPath,footprintSha256:createHash('sha256').update(model.text).digest('hex'),footprintLibrary:info?'existing':'created',footprintTable:next===null?'existing':tableInfo?'updated':'created',
  async write(policy:Parameters<ProjectFileSystem['writeText']>[4]){
   signal.throwIfAborted();
   if(!info)await fs.writeText(footprint,model.text,{kind:'createIfAbsent'},signal,policy);
   if(next!==null)await fs.writeText(table,next,tableInfo?{kind:'replaceIfVersion',version:tableInfo.version}:{kind:'createIfAbsent'},signal,policy);
  }};
}
