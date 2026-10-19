import { vertical, wire } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets }) {
  const r = vertical(region, parts.resistor, refs.resistor, [x + 8, y + 12], 'top', 'bottom');
  const d = vertical(region, parts.led, refs.led, [x + 8, y + 30], 'anode', 'cathode');
  const supply = [r.top[0], r.top[1] - 5.08], ground = [d.bottom[0], d.bottom[1] + 5.08];
  return {
    reservedBounds: { origin: [x, y], size: [38, 46] },
    ports: { supply: { reference: refs.resistor, pin: parts.resistor.pins.top },
      ground: { reference: refs.led, pin: parts.led.pins.cathode } },
    connect() {
      wire(region, supply, r.top); wire(region, r.bottom, d.top); wire(region, d.bottom, ground);
      region.label(nets.supply, supply); region.label(nets.ground, ground);
    },
  };
}
