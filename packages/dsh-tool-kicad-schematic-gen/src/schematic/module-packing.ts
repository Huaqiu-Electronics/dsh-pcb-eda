import {SCHEMATIC_GRID_MM,snapGrid} from './grid.ts'
import type {FlatPoint} from './flat.ts'
import type {FlatBounds} from './flat-layout.ts'

interface PackingItem {bounds:FlatBounds;reserved:{start:FlatPoint;end:FlatPoint}}

/** Keep the planned column order, compacting the actual occupied envelopes on the connection grid. */
export function packModuleColumns(items:PackingItem[],page:FlatPoint):FlatPoint[]|undefined{
 const grid=SCHEMATIC_GRID_MM,margin=8*grid,gap=6*grid
 const down=(v:number)=>Math.floor(v/grid+1e-7)*grid
 const up=(v:number)=>Math.ceil(v/grid-1e-7)*grid
 const sorted=items.map((item,index)=>({...item,index})).sort((a,b)=>
  a.reserved.start[0]-b.reserved.start[0]||a.reserved.start[1]-b.reserved.start[1])
 const columns:Array<{left:number;right:number;items:typeof sorted}>=[]
 for(const item of sorted){
  const [left]=item.reserved.start,[right]=item.reserved.end
  const column=columns.find(c=>left<c.right-1e-6&&right>c.left+1e-6)
  if(column)column.items.push(item)
  else columns.push({left,right,items:[item]})
 }
 const shifts:FlatPoint[]=[]
 let x=margin
 for(const column of columns){
  let y=margin,width=0
  for(const {bounds,index} of column.items.sort((a,b)=>a.reserved.start[1]-b.reserved.start[1])){
   const left=down(bounds.left),top=down(bounds.top)
   const itemWidth=up(bounds.right)-left,itemHeight=up(bounds.bottom)-top
   if(x+itemWidth>page[0]-margin+1e-6||y+itemHeight>page[1]-margin+1e-6)return undefined
   shifts[index]=[snapGrid(x-left),snapGrid(y-top)]
   y+=itemHeight+gap
   width=Math.max(width,itemWidth)
  }
  x+=width+gap
 }
 return shifts
}
