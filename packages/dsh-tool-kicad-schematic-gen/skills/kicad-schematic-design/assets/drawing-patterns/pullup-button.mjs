import { vertical, wire } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets }) {
  const r = vertical(region, parts.resistor, refs.resistor, [x + 8, y + 12], 'top', 'bottom');
  const b = vertical(region, parts.button, refs.button, [x + 8, y + 32], 'top', 'bottom');
  const node = [r.bottom[0], r.bottom[1] + 5.08];
  const supply = [r.top[0], r.top[1] - 5.08], ground = [b.bottom[0], b.bottom[1] + 5.08];
  return {
    reservedBounds: { origin: [x, y], size: [40, 48] },
    ports: { signal: { reference: refs.button, pin: parts.button.pins.top } },
    connect() {
      wire(region, supply, r.top); wire(region, r.bottom, node); wire(region, node, b.top);
      const signal = [node[0] + 15.24, node[1]];
      wire(region, node, signal); region.marker('junction', node);
      wire(region, b.bottom, ground);
      region.label(nets.supply, supply); region.label(nets.signal, signal); region.label(nets.ground, ground);
    },
  };
}
