/** Example only: two resistors demonstrate contracts, not a complete product circuit. */
export function place({region,parts,references,nets,bounds}){
 const reference=references.resistor;
 const {pins,...symbol}=parts.resistor;
 region.addSymbol({...symbol,reference,value:'10k',at:[40.64,35.56]});
 return {bounds,ports:{signal:{reference,pin:pins.top}},connect(){
  const bottom=region.pin(reference,pins.bottom),ground=[bottom[0],bottom[1]+7.62];
  region.wire(bottom,ground);region.label(nets.ground,ground);
 }};
}
