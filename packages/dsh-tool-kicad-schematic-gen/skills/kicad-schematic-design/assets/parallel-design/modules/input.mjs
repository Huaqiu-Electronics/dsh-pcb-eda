/** Example only: replace this resistor with the module's confirmed circuit. */
export function place({region,parts,references,nets,bounds}){
 const reference=references.resistor;
 const {pins,...symbol}=parts.resistor;
 region.addSymbol({...symbol,reference,value:'10k',at:[40.64,35.56]});
 return {bounds,ports:{signal:{reference,pin:pins.bottom}},connect(){
  const top=region.pin(reference,pins.top),supply=[top[0],top[1]-7.62];
  region.wire(top,supply);region.label(nets.supply,supply);
 }};
}
