/** Shared drawing geometry only; no switching-converter component selection or calculations. */
import { vertical, wire, point } from './geometry.mjs';
export function horizontal(region, part, reference, at) {
  const { pins, ...symbol } = part;
  region.addSymbol({ ...symbol, reference, at, fieldAngle: [90, 270].includes(symbol.angle) ? 90 : 0,
    referenceAt: [at[0], at[1] - 8.89], valueAt: [at[0], at[1] - 5.08] });
  const left = point(region.pin(reference, pins.left)), right = point(region.pin(reference, pins.right));
  if (left[0] >= right[0] || left[1] !== right[1]) throw new Error(`${reference}: verify horizontal left/right pin roles and orientation`);
  return { left, right };
}
export function divider(region, parts, refs, x, railY) {
  const upper = vertical(region, parts.upper, refs.upper, [x, railY + 12.7], 'top', 'bottom');
  const lower = vertical(region, parts.lower, refs.lower, [x, railY + 30.48], 'top', 'bottom');
  const node = [x, upper.bottom[1] + 3.81];
  if (node[1] >= lower.top[1]) throw new Error('Increase feedback divider spacing');
  return { upper, lower, node };
}
export function connectDivider(region, fb, railY, groundY, net) {
  wire(region, [fb.upper.top[0], railY], fb.upper.top);
  wire(region, fb.upper.bottom, fb.node); wire(region, fb.node, fb.lower.top);
  wire(region, fb.lower.bottom, [fb.lower.bottom[0], groundY]);
  region.label(net, fb.node);
}
