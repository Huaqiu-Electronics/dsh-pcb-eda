import {listFlatObjects} from './flat.ts'
import {onGrid} from './grid.ts'
import {children,parse,value,applyEdits} from './sexpr.ts'

/** Never round an existing circuit's wires and library pins independently: that can break nets. */
export function assertSchematicGrid(source:string):void {
 const failures:string[]=[]
 const root=parse(source),sheets=children(root,'sheet')
 const check=(name:string,p:number[])=>{if(!p.every(onGrid)&&failures.length<16)failures.push(`${name} (${p.join(', ')})`)}
 const flat=applyEdits(source,sheets.map(sheet=>({start:sheet.start,end:sheet.end,text:''})))
 for(const object of listFlatObjects(flat)){
  if(object.type==='symbol'){
   if(object.pinError)throw new Error(`GRID_PIN_UNRESOLVED: ${object.reference}: ${object.pinError}`)
   if(object.at)check(object.reference??'symbol',object.at)
   for(const pin of object.pins??[])check(`${object.reference}.${pin.number}`,pin.at)
  }else if(['wire','bus'].includes(object.type)){
   if(object.from)check(`${object.type} start`,object.from)
   if(object.to)check(`${object.type} end`,object.to)
  }else if(['label','global_label','hierarchical_label','junction','no_connect'].includes(object.type)&&object.at)check(object.type,object.at)
 }
 for(const sheet of sheets){
  for(const at of children(sheet,'at'))check('sheet',[Number(value(at,1)),Number(value(at,2))])
  for(const pin of children(sheet,'pin'))for(const at of children(pin,'at'))check(`sheet pin ${value(pin)}`,[Number(value(at,1)),Number(value(at,2))])
 }
 for(const kind of ['wire','bus'])for(const wire of children(root,kind))for(const pts of children(wire,'pts'))for(const xy of children(pts,'xy'))check(kind,[Number(value(xy,1)),Number(value(xy,2))])
 for(const entry of children(root,'bus_entry')){
  const at=children(entry,'at')[0],size=children(entry,'size')[0]
  if(at&&size){const x=Number(value(at,1)),y=Number(value(at,2));check('bus entry',[x,y]);check('bus entry end',[x+Number(value(size,1)),y+Number(value(size,2))])}
 }
 if(failures.length)throw new Error(`SCHEMATIC_OFF_GRID: expected 50 mil (1.27 mm). ${failures.join('; ')}. Fix source placement/routing or select a 50 mil compatible symbol; do not round library pins and connected wires separately.`)
}
