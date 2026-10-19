/** Pass one verified side at a time; do not include already wired, power or NC pins. */
import { attachPinLabels } from '../runtime.mjs';
export function labelSide(target, reference, direction, pins, alignAt) {
  return attachPinLabels(target, { reference, direction, pins, length: 5.08, alignAt });
}
// Example after placing the actual symbol (pin numbers must match that symbol):
// labelSide(region, 'U1', 'left', [{pin:'1', net:'EN'}, {pin:'2', net:'GPIO0'}]);
// labelSide(region, 'U1', 'down', [{pin:'3', net:'GPIO1'}, {pin:'4', net:'GPIO2'}]);
