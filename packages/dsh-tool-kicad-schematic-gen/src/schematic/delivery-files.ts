/** Select the actual design graph, never candidate schematics from work directories. */
import {posix} from 'node:path'
import {children,parse,value} from './sexpr.ts'

export function deliveryFiles(files:Record<string,Uint8Array>,root:string):Record<string,Uint8Array>{
 const selected=new Set<string>()
 function visit(name:string){
  name=posix.normalize(name.replaceAll('\\','/'))
  if(name.startsWith('../')||posix.isAbsolute(name)||/^[A-Za-z]:/.test(name))throw new Error('Schematic reference escapes project')
  if(selected.has(name))return
  const bytes=files[name]
  if(!bytes)throw new Error(`Referenced schematic is missing: ${name}`)
  selected.add(name)
  const document=parse(new TextDecoder().decode(bytes))
  if(document.head!=='kicad_sch')throw new Error(`Invalid schematic: ${name}`)
  for(const sheet of children(document,'sheet')){
   const property=children(sheet,'property').find(item=>value(item)==='Sheetfile')
   if(!property)throw new Error(`Sheetfile is missing in ${name}`)
   visit(posix.join(posix.dirname(name),value(property,2).replaceAll('\\','/')))
  }
 }
 visit(root)
 const result:Record<string,Uint8Array>={}
 for(const [name,bytes] of Object.entries(files)){
  if(/\.kicad_sch$/i.test(name)?selected.has(name):!name.split('/').some(part=>['work','previews','scripts','history','node_modules'].includes(part)))result[name]=bytes
 }
 return result
}

/** The host currently flattens sheet paths; never allow it to silently overwrite. */
export function assertPlacementNames(files:Record<string,Uint8Array>){
 const names=new Set<string>()
 for(const name of Object.keys(files).filter(name=>/\.kicad_sch$/i.test(name))){
  const key=posix.basename(name).toLowerCase()
  if(names.has(key))throw new Error(`原理图子页文件名重复，无法安全放置：${name}。请使用不同的子页文件名。`)
  names.add(key)
 }
}
