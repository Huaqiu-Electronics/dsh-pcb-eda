/** Two pullups for one verified I2C voltage domain; this is not a level shifter. */
import { vertical, wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets }) {
  if (!nets.sda || !nets.scl || nets.sda === nets.scl) throw new Error('Provide distinct SDA and SCL nets');
  if (parts.resistors.length !== 2 || refs.resistors.length !== 2) throw new Error('Provide two actual pullup resistors');
  const resistors = parts.resistors.map((part, i) => vertical(region, part, refs.resistors[i],
    point([x + 12.7 + i * 25.4, y + 15.24]), 'top', 'bottom'));
  const supplyY = Math.min(...resistors.map(r => r.top[1])) - 7.62;
  return {
    reservedBounds: { origin: [x, y], size: [66.04, 43.18] },
    ports: { sda: { reference: refs.resistors[0], pin: parts.resistors[0].pins.bottom },
      scl: { reference: refs.resistors[1], pin: parts.resistors[1].pins.bottom } },
    connect() {
      const supply = [resistors[0].top[0], supplyY];
      wire(region, supply, [resistors[1].top[0], supplyY]); region.label(nets.supply, supply);
      resistors.forEach((r, i) => {
        const signal = [r.bottom[0], r.bottom[1] + 7.62];
        wire(region, [r.top[0], supplyY], r.top); wire(region, r.bottom, signal);
        region.label(i === 0 ? nets.sda : nets.scl, signal);
      });
    },
  };
}
