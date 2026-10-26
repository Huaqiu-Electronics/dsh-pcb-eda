/** Verified asynchronous adjustable buck: SW -> L -> VOUT; catch diode K=SW, A=GND. */
import { vertical, wire, point } from './geometry.mjs';
import { horizontal, divider, connectDivider } from './dcdc-geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, buckTopologyConfirmed, shutdownToGroundConfirmed }) {
  if (buckTopologyConfirmed !== true || shutdownToGroundConfirmed !== true) {
    throw new Error('Verify asynchronous adjustable buck and active-high shutdown tied to ground for this exact IC');
  }
  const { pins, ...symbol } = parts.controller;
  region.addSymbol({ ...symbol, reference: refs.controller, at: [x + 63.5, y + 25.4],
    referenceAt: [x + 63.5, y + 10.16], valueAt: [x + 63.5, y + 13.97] });
  const pin = role => point(region.pin(refs.controller, pins[role]));
  const vin = pin('vin'), sw = pin('sw'), gnd = pin('gnd'), fbPin = pin('fb'), shutdown = pin('shutdown');
  if (vin[0] >= sw[0] || shutdown[0] !== vin[0] || shutdown[1] <= vin[1] || fbPin[1] >= sw[1]) {
    throw new Error('Orient VIN/shutdown left and FB/SW right; adjust geometry without swapping physical roles');
  }
  const l = horizontal(region, parts.inductor, refs.inductor, [sw[0] + 20.32, sw[1]]);
  const d = vertical(region, parts.diode, refs.diode, [sw[0] + 7.62, sw[1] + 12.7], 'cathode', 'anode');
  const input = vertical(region, parts.inputCapacitor, refs.inputCapacitor, [vin[0] - 20.32, vin[1] + 12.7], 'top', 'bottom');
  const output = vertical(region, parts.outputCapacitor, refs.outputCapacitor, [l.right[0] + 12.7, sw[1] + 12.7], 'top', 'bottom');
  const fb = divider(region, parts.feedback, refs.feedback, output.top[0] + 20.32, sw[1]);
  const groundY = Math.max(input.bottom[1], output.bottom[1], d.bottom[1], gnd[1], fb.lower.bottom[1]) + 5.08;
  return {
    reservedBounds: { origin: [x, y], size: [152.4, 81.28] },
    ports: { input: { reference: refs.controller, pin: pins.vin },
      output: { reference: refs.outputCapacitor, pin: parts.outputCapacitor.pins.top } },
    connect() {
      const inputNode = [input.top[0], vin[1]], switchNode = [d.top[0], sw[1]], outputNode = [output.top[0], sw[1]];
      wire(region, inputNode, vin); wire(region, inputNode, input.top); region.label(nets.input, inputNode);
      wire(region, sw, l.left); wire(region, switchNode, d.top); region.marker('junction', switchNode);
      wire(region, l.right, [fb.upper.top[0], sw[1]]); wire(region, outputNode, output.top); region.marker('junction', outputNode);
      region.label(nets.output, [fb.upper.top[0], sw[1]]);
      connectDivider(region, fb, sw[1], groundY, nets.feedback);
      const feedbackEnd = [fbPin[0] + 5.08, fbPin[1]];
      wire(region, fbPin, feedbackEnd); region.label(nets.feedback, feedbackEnd);
      const shutdownEnd = [shutdown[0] - 7.62, shutdown[1]];
      wire(region, shutdown, shutdownEnd); region.label(nets.ground, shutdownEnd);
      wire(region, [input.bottom[0], groundY], [fb.lower.bottom[0], groundY]);
      for (const p of [input.bottom, output.bottom, d.bottom, gnd]) {
        wire(region, p, [p[0], groundY]); region.marker('junction', [p[0], groundY]);
      }
      region.label(nets.ground, [gnd[0], groundY]);
    },
  };
}
