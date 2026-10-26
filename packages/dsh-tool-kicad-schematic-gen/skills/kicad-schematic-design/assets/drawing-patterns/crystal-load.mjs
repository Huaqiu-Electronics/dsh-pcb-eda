/** Passive crystal with verified external load capacitors; not an oscillator design rule. */
import { vertical, wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, externalCrystalConfirmed }) {
  if (externalCrystalConfirmed !== true) {
    throw new Error('Verify an external passive crystal is used and requires these load capacitors');
  }
  const { pins, ...symbol } = parts.crystal;
  if (!pins.left || !pins.right || parts.capacitors.length !== 2 || refs.capacitors.length !== 2) {
    throw new Error('Provide two crystal terminal roles and two capacitors');
  }
  region.addSymbol({ ...symbol, reference: refs.crystal, at: point([x + 38.1, y + 15.24]),
    referenceAt: point([x + 38.1, y + 2.54]), valueAt: point([x + 38.1, y + 6.35]) });
  const left = point(region.pin(refs.crystal, pins.left)), right = point(region.pin(refs.crystal, pins.right));
  if (left[0] >= right[0] || left[1] !== right[1]) {
    throw new Error('Orient crystal terminals horizontally without exchanging physical roles');
  }
  const nodes = [[left[0] - 12.7, left[1]], [right[0] + 12.7, right[1]]];
  const caps = parts.capacitors.map((part, i) => vertical(region, part, refs.capacitors[i],
    point([nodes[i][0], left[1] + 15.24]), 'top', 'bottom'));
  if (caps.some(c => c.top[1] <= left[1])) throw new Error('Increase crystal load-capacitor spacing');
  return {
    reservedBounds: { origin: [x, y], size: [81.28, 58.42] },
    ports: { left: { reference: refs.crystal, pin: pins.left },
      right: { reference: refs.crystal, pin: pins.right } },
    connect() {
      [left, right].forEach((p, i) => {
        const node = nodes[i], c = caps[i], ground = [c.bottom[0], c.bottom[1] + 7.62];
        wire(region, p, node); wire(region, node, c.top); region.marker('junction', node);
        region.label(i === 0 ? nets.left : nets.right, node);
        wire(region, c.bottom, ground); region.label(nets.ground, ground);
      });
      for (const pin of pins.caseGround ?? []) region.label(nets.ground, point(region.pin(refs.crystal, pin)));
    },
  };
}
