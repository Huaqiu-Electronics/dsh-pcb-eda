/** Electrical schematic coordinates use KiCad's 50 mil connection grid. */
export const SCHEMATIC_GRID_MM=1.27
export function snapGrid(n:number):number {
 if(!Number.isFinite(n))throw new Error('GRID_COORDINATE_INVALID: expected finite millimetres')
 return Number((Math.round(n/SCHEMATIC_GRID_MM)*SCHEMATIC_GRID_MM).toFixed(6))
}
export function gridPoint(p:readonly number[]):[number,number] {
 if(p.length!==2)throw new Error('grid point requires two coordinates')
 return [snapGrid(p[0]!),snapGrid(p[1]!)]
}
export function onGrid(n:number):boolean{return Number.isFinite(n)&&Math.abs(n-snapGrid(n))<1e-6}
