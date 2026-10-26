/** Verified N-channel low-side driver with an explicitly selected flyback diode. */
import { vertical, wire, point } from './geometry.mjs';
import { horizontal } from './dcdc-geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, inductiveLoadConfirmed }) {
  if (inductiveLoadConfirmed !== true) throw new Error('Confirm low-side N-MOS topology and flyback diode suitability');
  const { pins, ...symbol } = parts.mosfet;
  region.addSymbol({ ...symbol, reference: refs.mosfet, at: [x + 43.18, y + 35.56],
    referenceAt: [x + 54.61, y + 34.29], valueAt: [x + 54.61, y + 38.1] });
  const pin = role => point(region.pin(refs.mosfet, pins[role]));
  const gate = pin('gate'), drain = pin('drain'), source = pin('source');
  if (drain[0] !== source[0] || drain[1] >= source[1] || gate[0] >= source[0]) throw new Error('Orient gate left, drain up, source down');
  const load = parts.load;
  const { pins: loadPins, ...loadSymbol } = load;
  region.addSymbol({ ...loadSymbol, reference: refs.load, at: [drain[0] + 5.08, y + 10.16],
    referenceAt: [drain[0] + 5.08, y], valueAt: [drain[0] + 5.08, y + 3.81] });
  const supply = point(region.pin(refs.load, loadPins.supply));
  const low = point(region.pin(refs.load, loadPins.low));
  if (low[0] !== drain[0] || low[1] >= drain[1]) throw new Error('Orient load return above drain');
  const series = horizontal(region, parts.gateResistor, refs.gateResistor, [x + 17.78, gate[1]]);
  const pull = vertical(region, parts.pulldown, refs.pulldown, [x + 27.94, y + 48.26], 'top', 'bottom');
  const diode = vertical(region, parts.diode, refs.diode, [x + 81.28, y + 20.32], 'cathode', 'anode');
  const groundY = Math.max(source[1], pull.bottom[1]) + 5.08;
  return {
    reservedBounds: { origin: [x, y], size: [106.68, 68.58] },
    ports: { control: { reference: refs.gateResistor, pin: parts.gateResistor.pins.left },
      load: { reference: refs.load, pin: loadPins.low } },
    connect() {
      const input = [series.left[0] - 12.7, gate[1]], node = [pull.top[0], gate[1]];
      wire(region, input, series.left); region.label(nets.control, input);
      wire(region, series.right, gate); wire(region, node, pull.top); region.marker('junction', node);
      wire(region, low, drain); region.label(nets.loadLow, [drain[0] + 7.62, drain[1]]);
      // The supply route goes above the connector to avoid touching its return pin.
      const railY = supply[1] - 5.08;
      wire(region, supply, [supply[0] - 7.62, supply[1]]);
      wire(region, [supply[0] - 7.62, supply[1]], [supply[0] - 7.62, railY]);
      wire(region, [supply[0] - 7.62, railY], [diode.top[0], railY]);
      wire(region, [diode.top[0], railY], diode.top); region.label(nets.supply, [diode.top[0], railY]);
      wire(region, diode.bottom, [diode.bottom[0], drain[1]]);
      wire(region, drain, [diode.bottom[0], drain[1]]); region.marker('junction', drain);
      wire(region, source, [source[0], groundY]); wire(region, pull.bottom, [pull.bottom[0], groundY]);
      wire(region, [pull.bottom[0], groundY], [source[0], groundY]); region.label(nets.ground, [source[0], groundY]);
    },
  };
}
