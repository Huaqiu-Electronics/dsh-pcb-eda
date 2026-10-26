/** Verified active-low reset/enable with pullup, shunt button and shunt capacitor. */
import { vertical, wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, activeLowRcConfirmed }) {
  if (activeLowRcConfirmed !== true) {
    throw new Error('Verify active-low reset, allowed RC and pushbutton-to-ground topology first');
  }
  const r = vertical(region, parts.resistor, refs.resistor, point([x + 12.7, y + 10.16]), 'top', 'bottom');
  const b = vertical(region, parts.button, refs.button, point([r.bottom[0], r.bottom[1] + 15.24]), 'top', 'bottom');
  const c = vertical(region, parts.capacitor, refs.capacitor, point([r.bottom[0] + 20.32, r.bottom[1] + 15.24]), 'top', 'bottom');
  const node = [r.bottom[0], r.bottom[1] + 5.08];
  const supply = [r.top[0], r.top[1] - 5.08], groundY = Math.max(b.bottom[1], c.bottom[1]) + 5.08;
  if (Math.min(b.top[1], c.top[1]) <= node[1]) throw new Error('Increase reset branch spacing for this symbol');
  return {
    reservedBounds: { origin: [x, y], size: [66.04, 63.5] },
    ports: { signal: { reference: refs.resistor, pin: parts.resistor.pins.bottom } },
    connect() {
      wire(region, supply, r.top); wire(region, r.bottom, node); wire(region, node, b.top);
      const branch = [c.top[0], node[1]], signal = [c.top[0] + 15.24, node[1]];
      wire(region, node, branch); wire(region, branch, c.top); wire(region, branch, signal);
      region.marker('junction', node); region.marker('junction', branch);
      region.label(nets.supply, supply); region.label(nets.signal, signal);
      for (const p of [b.bottom, c.bottom]) {
        wire(region, p, [p[0], groundY]); region.label(nets.ground, [p[0], groundY]);
      }
    },
  };
}
