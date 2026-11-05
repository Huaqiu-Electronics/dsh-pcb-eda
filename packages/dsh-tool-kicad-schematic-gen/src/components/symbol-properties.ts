/** Fill missing symbol properties from exact-part product detail, without changing geometry. */
import type { Part } from '@huaqiu/part-search'
import {parse, children, value, quote, applyEdits, type TextEdit, type Form} from '../schematic/sexpr.ts'

/** Preserve explicit values and geometry, filling missing/blank fields only. */
function propertyEdits(text:string, target:Form, fields:Map<string,{name:string;value:string}>):TextEdit[] {
  const byName=new Map(children(target,'property').map(p=>[value(p).toLowerCase(),p]))
  const edits:TextEdit[]=[], additions:string[]=[]
  for(const {name,value:content} of fields.values()){
    const existing=byName.get(name.toLowerCase())
    if(existing){
      const old=value(existing,2)
      if(old.trim() && old.trim()!=='~')continue
      const original=text.slice(existing.start,existing.end)
      const updated=original.replace(/^(\(\s*property\s+(?:"(?:\\.|[^"\\])*"|[^\s()]+)\s+)(?:"(?:\\.|[^"\\])*"|[^\s()]+)/u,
        (_match,prefix:string)=>prefix+quote(content))
      edits.push({start:existing.start,end:existing.end,text:updated})
    }else{
      const at=children(target,'at')[0]
      const position=at?`${value(at,1)} ${value(at,2)}`:'0 0'
      additions.push(`(property ${quote(name)} ${quote(content)} (at ${position} 0) (effects (font (size 1.27 1.27)) (hide yes)))`)
    }
  }
  if(additions.length)edits.push({start:target.end-1,end:target.end-1,text:'\n'+additions.join('\n')+'\n'})
  return edits
}

function checkMpn(target:Form, mpn:string){
  const existing=children(target,'property').find(p=>value(p).toLowerCase()==='mpn')
  const old=existing?value(existing,2).trim():''
  if(old && old!=='~' && old!==mpn)throw new Error(`MPN_CONFLICT: ${old} does not match ${mpn}`)
}

/** Set the verified local footprint, even when an upstream library supplies a different default. */
export function assignSymbolFootprint(text:string,footprintId:string):string {
  if(!/^[^:\r\n]+:[^:\r\n]+$/u.test(footprintId))throw new Error('Invalid footprint ID')
  const symbols=children(parse(text),'symbol')
  if(symbols.length!==1)throw new Error('Expected exactly one library symbol')
  const symbol=symbols[0]!,properties=children(symbol,'property').filter(p=>value(p)==='Footprint')
  if(properties.length>1)throw new Error('Duplicate symbol Footprint properties')
  const existing=properties[0]
  if(!existing)return applyEdits(text,propertyEdits(text,symbol,new Map([['footprint',{name:'Footprint',value:footprintId}]])))
  const original=text.slice(existing.start,existing.end)
  const updated=original.replace(/^(\(\s*property\s+"Footprint"\s+)(?:"(?:\\.|[^"\\])*"|[^\s()]+)/u,(_m,prefix:string)=>prefix+quote(footprintId))
  return applyEdits(text,[{start:existing.start,end:existing.end,text:updated}])
}

export function mergeSymbolProperties(text:string, part:Part):string {
  const root=parse(text), symbol=children(root,'symbol')[0]
  if(!symbol || children(root,'symbol').length!==1)throw new Error('Expected exactly one library symbol')
  checkMpn(symbol,part.mpn)
  const fields=new Map<string,{name:string;value:string}>()
  const add=(name:string, content:string|undefined)=>{
    if(!content?.trim())return
    const key=name.toLowerCase()
    if(!fields.has(key))fields.set(key,{name,value:content.trim()})
  }
  add('MPN',part.mpn)
  add('Manufacturer',part.manufacturer.name)
  add('huaqiu_pn',part.huaqiuPn)
  add('Description',part.description)
  add('Datasheet',part.documents.find(d=>/^datasheet$/i.test(d.type))?.url)
  add('lifecycle',part.lifecycle)
  // Attributes must never replace KiCad's built-ins or exact identity fields.
  const reserved=new Set(['reference','value','footprint','datasheet','description','mpn','manufacturer','huaqiu_pn'])
  for(const attribute of part.attributes){
    const name=(attribute.shortName || attribute.name).trim(), content=attribute.value.trim()
    const key=name.toLowerCase()
    if(!name || !content || reserved.has(key) || key.startsWith('ki_'))continue
    const previous=fields.get(key)
    if(previous){
      if(!previous.value.split('; ').includes(content))previous.value+=`; ${content}`
    }else add(name,content)
  }
  // Prefer the technical package attribute over a coarser summary package label.
  add('package',part.package)
  return applyEdits(text,propertyEdits(text,symbol,fields))
}

/** Sync library metadata into embedded definitions and exact physical instances. */
export function syncSchematicProperties(text:string, updates:Array<{libId:string;libraryText:string;references:string[]}>):string {
  const root=parse(text)
  if(root.head!=='kicad_sch')throw new Error('Expected a KiCad schematic')
  const cache=children(root,'lib_symbols')[0], edits:TextEdit[]=[], selected=new Set<string>(), libraries=new Set<string>()
  for(const update of updates){
    if(libraries.has(update.libId))throw new Error(`Repeated libId: ${update.libId}`)
    libraries.add(update.libId)
    const library=children(parse(update.libraryText),'symbol')
    if(library.length!==1 || !update.libId.endsWith(':'+value(library[0]!)))throw new Error(`Library symbol does not match ${update.libId}`)
    const fields=new Map<string,{name:string;value:string}>()
    for(const p of children(library[0]!,'property')){
      const name=value(p), content=value(p,2), key=name.toLowerCase()
      if(!['reference','value','footprint'].includes(key) && !key.startsWith('ki_') && content.trim() && content!=='~')fields.set(key,{name,value:content})
    }
    const mpn=fields.get('mpn')?.value
    if(!mpn)throw new Error(`Missing MPN in ${update.libId}`)
    const embedded=cache?children(cache,'symbol').find(s=>value(s)===update.libId):undefined
    if(!embedded)throw new Error(`Missing embedded symbol ${update.libId}`)
    checkMpn(embedded,mpn)
    edits.push(...propertyEdits(text,embedded,fields))
    for(const ref of update.references){
      if(selected.has(ref))throw new Error(`Repeated reference: ${ref}`)
      selected.add(ref)
      const instances=children(root,'symbol').filter(s=>children(s,'property').some(p=>value(p)==='Reference'&&value(p,2)===ref))
      if(!instances.length)throw new Error(`Reference not found: ${ref}`)
      for(const instance of instances){
        const id=children(instance,'lib_id')[0]
        if(!id || value(id)!==update.libId)throw new Error(`Reference ${ref} does not use ${update.libId}`)
        checkMpn(instance,mpn)
        edits.push(...propertyEdits(text,instance,fields))
      }
    }
  }
  return applyEdits(text,edits)
}
