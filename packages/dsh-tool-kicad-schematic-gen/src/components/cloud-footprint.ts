/** Match cloud placement's logical name, while retaining the downloaded model bytes. */
import {join} from 'node:path'
import {parse,children,value,quote} from '../schematic/sexpr.ts'
import type {ProjectFileSystem} from './import-symbol.ts'

export const CLOUD_FOOTPRINT_LIBRARY='kicad_api_lib'

export async function prepareCloudFootprint(project:Awaited<ReturnType<ProjectFileSystem['resolve']>>,mpn:string,text:string,fs:ProjectFileSystem,signal:AbortSignal){
  if(!mpn || /[<>:"/\\|?*\x00-\x1f]/u.test(mpn) || /[. ]$/u.test(mpn)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(mpn))throw new Error('MPN is not a safe cloud footprint filename')
  const table=await fs.resolve(join(project.displayPath,'fp-lib-table'),{signal})
  if(!fs.contains(project,table))throw new Error('Footprint table must stay inside projectDir')
  const tableInfo=await fs.stat(table,signal)
  if(tableInfo && tableInfo.type!=='file')throw new Error('fp-lib-table must be a regular file')
  const old=tableInfo?await fs.readText(table,signal):null
  let uri='${KIPRJMOD}/libraries/footprints/kicad_api_lib.pretty',next:string|null=null
  if(old!==null){
    const root=parse(old)
    if(root.head!=='fp_lib_table')throw new Error('fp-lib-table has no fp_lib_table root')
    const matches=children(root,'lib').filter(lib=>children(lib,'name').some(p=>value(p)===CLOUD_FOOTPRINT_LIBRARY))
    if(matches.length){
      const lib=matches[0]!,uris=children(lib,'uri'),types=children(lib,'type'),options=children(lib,'options')
      if(matches.length!==1||uris.length!==1||types.length!==1||value(types[0]!)!=='KiCad'
        ||options.length>1||(options.length===1&&value(options[0]!)!==''))throw new Error('fp-lib-table has a conflicting registration for kicad_api_lib')
      uri=value(uris[0]!)
      if(!uri.startsWith('${KIPRJMOD}/'))throw new Error('kicad_api_lib must use a project-local registration')
    }else{
      const entry=`(lib (name ${quote(CLOUD_FOOTPRINT_LIBRARY)})(type "KiCad")(uri ${quote(uri)})(options "")(descr ""))`
      next=old.slice(0,root.end-1)+`\n  ${entry}\n`+old.slice(root.end-1)
    }
  }else next=`(fp_lib_table\n  (version 7)\n  (lib (name ${quote(CLOUD_FOOTPRINT_LIBRARY)})(type "KiCad")(uri ${quote(uri)})(options "")(descr ""))\n)\n`
  const directory=await fs.resolve(join(project.displayPath,uri.slice('${KIPRJMOD}/'.length)),{signal})
  const file=await fs.resolve(join(directory.displayPath,`${mpn}.kicad_mod`),{signal})
  if(!fs.contains(project,directory)||!fs.contains(directory,file))throw new Error('Footprint targets must stay inside projectDir')
  const info=await fs.stat(file,signal)
  if(info && (info.type!=='file'||await fs.readText(file,signal)!==text))throw new Error(`FOOTPRINT_NAME_CONFLICT: ${CLOUD_FOOTPRINT_LIBRARY}:${mpn} already exists with different content; refusing to overwrite`)
  return {footprintId:`${CLOUD_FOOTPRINT_LIBRARY}:${mpn}`,file,table,info,tableInfo,next,
    async write(policy:Parameters<ProjectFileSystem['writeText']>[4]){
      signal.throwIfAborted()
      if(!info)await fs.writeText(file,text,{kind:'createIfAbsent'},signal,policy)
      if(next!==null)await fs.writeText(table,next,tableInfo?{kind:'replaceIfVersion',version:tableInfo.version}:{kind:'createIfAbsent'},signal,policy)
    }}
}
