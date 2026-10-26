/** Three-role fixed-output LDO; verify physical pin roles and capacitor suitability first. */
import { vertical, wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets }) {
  const { pins, ...symbol } = parts.ldo;
  if (!pins.vin || !pins.vout || !pins.gnd) throw new Error('Provide verified VIN/VOUT/GND roles');
  region.addSymbol({ ...symbol, reference: refs.ldo, at: point([x + 60.96, y + 15.24]),
    referenceAt: point([x + 60.96, y + 2.54]), valueAt: point([x + 60.96, y + 6.35]) });
  const pin = role => point(region.pin(refs.ldo, pins[role]));
  const vin = pin('vin'), vout = pin('vout'), gnd = pin('gnd');
  if (vin[0] >= vout[0] || vin[1] !== vout[1] || gnd[1] <= vin[1]) {
    throw new Error('Orient VIN left, VOUT right at the same height and GND below; never swap physical pins');
  }
  const input = parts.inputCapacitors, output = parts.outputCapacitors;
  if (!input.length || !output.length || input.length !== refs.inputCapacitors.length
    || output.length !== refs.outputCapacitors.length) throw new Error('Provide matching nonempty capacitor arrays');
  const before = input.map((part, i) => vertical(region, part, refs.inputCapacitors[i],
    point([vin[0] - 12.7 - (input.length - 1 - i) * 20.32, vin[1] + 15.24]), 'top', 'bottom'));
  const after = output.map((part, i) => vertical(region, part, refs.outputCapacitors[i],
    point([vout[0] + 12.7 + i * 20.32, vout[1] + 15.24]), 'top', 'bottom'));
  const caps = [...before, ...after];
  const groundY = Math.max(gnd[1], ...caps.map(c => c.bottom[1])) + 7.62;
  const leftX = Math.min(...before.map(c => c.top[0])), rightX = Math.max(...after.map(c => c.top[0]));
  return {
    reservedBounds: { origin: [x, y], size: [139.7, 66.04] },
    ports: { input: { reference: refs.ldo, pin: pins.vin },
      output: { reference: refs.ldo, pin: pins.vout } },
    connect() {
      for (const [group, node] of [[before, vin], [after, vout]]) {
        for (const c of group) {
          const top = [c.top[0], node[1]];
          wire(region, node, top); wire(region, top, c.top); region.marker('junction', top);
        }
      }
      wire(region, [leftX, groundY], [rightX, groundY]);
      for (const c of caps) {
        wire(region, c.bottom, [c.bottom[0], groundY]);
        if (c.bottom[0] !== leftX && c.bottom[0] !== rightX) region.marker('junction', [c.bottom[0], groundY]);
      }
      wire(region, gnd, [gnd[0], groundY]); region.marker('junction', [gnd[0], groundY]);
      wire(region, [gnd[0], groundY], [gnd[0], groundY + 5.08]);
      region.label(nets.ground, [gnd[0], groundY + 5.08]);
      const inputStart = [leftX - 6.35, vin[1]], outputEnd = [rightX + 6.35, vout[1]];
      wire(region, inputStart, [leftX, vin[1]]); wire(region, [rightX, vout[1]], outputEnd);
      region.label(nets.input, inputStart); region.label(nets.output, outputEnd);
      // Additional output TAB terminals are connected only when explicitly declared by the caller.
      for (const tab of pins.outputTabs ?? []) region.label(nets.output, point(region.pin(refs.ldo, tab)));
    },
  };
}
