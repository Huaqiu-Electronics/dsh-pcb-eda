/** Verified asynchronous boost with internal low-side switch: VIN -> L -> SW -> diode -> VOUT. */
import { vertical, wire, point } from './geometry.mjs';
import { horizontal, divider, connectDivider } from './dcdc-geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, boostTopologyConfirmed, enableToVinConfirmed }) {
  if (boostTopologyConfirmed !== true || enableToVinConfirmed !== true) {
    throw new Error('Verify asynchronous boost, external feedback, and VIN-tied enable for this exact IC');
  }
  const { pins, ...symbol } = parts.controller;
  region.addSymbol({ ...symbol, reference: refs.controller, at: [x + 63.5, y + 40.64],
    referenceAt: [x + 63.5, y + 27.94], valueAt: [x + 63.5, y + 31.75] });
  const pin = role => point(region.pin(refs.controller, pins[role]));
  const vin = pin('vin'), sw = pin('sw'), en = pin('en'), fbPin = pin('fb'), gnd = pin('gnd');
  if (vin[0] >= sw[0] || vin[1] !== sw[1] || en[0] !== vin[0] || en[1] <= vin[1] || fbPin[1] <= sw[1]) {
    throw new Error('Orient VIN/EN left and SW/FB right; adjust geometry without swapping physical roles');
  }
  const railY = sw[1] - 17.78;
  const l = horizontal(region, parts.inductor, refs.inductor, [x + 63.5, railY]);
  const d = horizontal(region, parts.diode, refs.diode, [sw[0] + 25.4, railY]);
  const input = vertical(region, parts.inputCapacitor, refs.inputCapacitor, [vin[0] - 20.32, railY + 12.7], 'top', 'bottom');
  const output = vertical(region, parts.outputCapacitor, refs.outputCapacitor, [d.right[0] + 12.7, railY + 12.7], 'top', 'bottom');
  const fb = divider(region, parts.feedback, refs.feedback, output.top[0] + 20.32, railY);
  const groundY = Math.max(input.bottom[1], output.bottom[1], gnd[1], fb.lower.bottom[1]) + 5.08;
  return {
    reservedBounds: { origin: [x, y], size: [157.48, 86.36] },
    ports: { input: { reference: refs.controller, pin: pins.vin },
      output: { reference: refs.outputCapacitor, pin: parts.outputCapacitor.pins.top } },
    connect() {
      const inputNode = [input.top[0], railY], switchNode = [sw[0] + 7.62, railY];
      wire(region, inputNode, l.left); wire(region, inputNode, input.top); region.label(nets.input, inputNode);
      wire(region, [vin[0], railY], vin); region.marker('junction', [vin[0], railY]);
      wire(region, l.right, d.left); wire(region, sw, [switchNode[0], sw[1]]); wire(region, [switchNode[0], sw[1]], switchNode); region.marker('junction', switchNode);
      wire(region, d.right, [fb.upper.top[0], railY]); wire(region, [output.top[0], railY], output.top); region.marker('junction', [output.top[0], railY]);
      region.label(nets.output, [fb.upper.top[0], railY]);
      const enableElbow = [en[0] - 7.62, en[1]];
      wire(region, en, enableElbow); wire(region, enableElbow, [enableElbow[0], vin[1]]); wire(region, [enableElbow[0], vin[1]], vin);
      connectDivider(region, fb, railY, groundY, nets.feedback);
      const feedbackEnd = [fbPin[0] + 5.08, fbPin[1]];
      wire(region, fbPin, feedbackEnd); region.label(nets.feedback, feedbackEnd);
      wire(region, [input.bottom[0], groundY], [fb.lower.bottom[0], groundY]);
      for (const p of [input.bottom, output.bottom, gnd]) {
        wire(region, p, [p[0], groundY]); region.marker('junction', [p[0], groundY]);
      }
      region.label(nets.ground, [gnd[0], groundY]);
    },
  };
}
