/** Fixed-output, explicitly VIN-enabled LDO; verified roles and orientation required. */
import { vertical, wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, enableToVin }) {
  if (enableToVin !== true) throw new Error('This example requires a verified VIN-tied enable design');
  const { pins, ...symbol } = parts.ldo;
  region.addSymbol({ ...symbol, reference: refs.ldo, at: [x + 52, y + 12],
    referenceAt: [x + 52, y + 1], valueAt: [x + 52, y + 4] });
  const pin = role => point(region.pin(refs.ldo, pins[role]));
  const vin = pin('vin'), vout = pin('vout'), en = pin('en'), gnd = pin('gnd');
  if (vin[0] >= x + 52 || vout[0] <= x + 52 || vin[1] !== vout[1] || en[0] !== vin[0] || en[1] <= vin[1]) {
    throw new Error('LDO example requires VIN/EN on left, VOUT on right, aligned VIN/VOUT');
  }
  const input = parts.inputCapacitors, output = parts.outputCapacitors;
  if (input.length !== 2 || output.length !== 2 || refs.inputCapacitors.length !== 2 || refs.outputCapacitors.length !== 2) {
    throw new Error('This compact example requires two confirmed capacitors on each side');
  }
  const caps = [...input, ...output].map((part, i) => vertical(region, part,
    [...refs.inputCapacitors, ...refs.outputCapacitors][i], [x + [10, 30, 76, 96][i], y + 25], 'top', 'bottom'));
  const groundY = y + 41;
  if (caps.some(c => c.top[1] <= vin[1] || c.bottom[1] >= groundY) || gnd[1] >= groundY) {
    throw new Error('Actual symbol extents need a custom, larger LDO layout');
  }
  return {
    reservedBounds: { origin: [x, y], size: [114, 52] },
    ports: { input: { reference: refs.ldo, pin: pins.vin }, output: { reference: refs.ldo, pin: pins.vout } },
    connect() {
      const inputStart = [x + 4, vin[1]], outputEnd = [x + 104, vout[1]], enableNode = [x + 40, vin[1]];
      wire(region, inputStart, vin); wire(region, vout, outputEnd);
      wire(region, enableNode, [enableNode[0], en[1]]); wire(region, [enableNode[0], en[1]], en);
      region.marker('junction', enableNode);
      caps.forEach((c, i) => {
        const rail = [c.top[0], i < 2 ? vin[1] : vout[1]];
        wire(region, rail, c.top); region.marker('junction', rail);
        wire(region, c.bottom, [c.bottom[0], groundY]);
      });
      wire(region, [caps[0].bottom[0], groundY], [caps[3].bottom[0], groundY]);
      wire(region, gnd, [gnd[0], groundY + 5.08]);
      for (const c of caps.slice(1, 3)) region.marker('junction', [c.bottom[0], groundY]);
      region.marker('junction', [gnd[0], groundY]);
      for (const nc of pins.nc ?? []) region.marker('no_connect', point(region.pin(refs.ldo, nc)));
      region.label(nets.input, inputStart); region.label(nets.output, outputEnd);
      region.label(nets.ground, [gnd[0], groundY + 5.08]);
    },
  };
}
