/** MCU with directly wired reset/boot and selectable internal RC or passive crystal with explicit supply, reset, boot and debug roles. */
import { vertical, wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, internalRcConfirmed, externalCrystalConfirmed, bootLowConfirmed }) {
  const external = externalCrystalConfirmed === true;
  if (bootLowConfirmed !== true || (external ? internalRcConfirmed === true : internalRcConfirmed !== true)) {
    throw new Error('Confirm exactly one clock mode and low boot strap for the exact MCU');
  }
  if (external && (!parts.mcu.pins.oscillator || !parts.crystal || parts.loadCapacitors?.length !== 2)) {
    throw new Error('Provide verified oscillator roles, passive crystal and two load capacitors');
  }
  if (external && (!nets.oscillatorInput || !nets.oscillatorOutput || nets.oscillatorInput === nets.oscillatorOutput)) {
    throw new Error('Provide distinct oscillator input and output net names');
  }
  const { pins, ...symbol } = parts.mcu;
  region.addSymbol({ ...symbol, reference: refs.mcu, at: [x + 63.5, y + 50.8],
    referenceAt: [x + 63.5, y + 5.08], valueAt: [x + 63.5, y + 8.89] });
  const pin = n => point(region.pin(refs.mcu, n));
  const caps = parts.decoupling.map((part, i) => vertical(region, part, refs.decoupling[i], [x + 88.9 + i * 20.32, y + 27.94], 'top', 'bottom'));
  const resetR = vertical(region, parts.resetResistor, refs.resetResistor, [x + 12.7, y + 22.86], 'top', 'bottom');
  const resetC = vertical(region, parts.resetCapacitor, refs.resetCapacitor, [x + 12.7, y + 45.72], 'top', 'bottom');
  const { pins: bootPins, ...bootSymbol } = parts.bootResistor;
  region.addSymbol({ ...bootSymbol, reference: refs.bootResistor, at: [x + 27.94, y + 53.34],
    referenceAt: [x + 34.29, y + 51.54], valueAt: [x + 34.29, y + 55.14] });
  const bootR = { top: point(region.pin(refs.bootResistor, bootPins.top)), bottom: point(region.pin(refs.bootResistor, bootPins.bottom)) };
  let oscillator;
  if (external) {
    const { pins: crystalPins, ...crystalSymbol } = parts.crystal;
    region.addSymbol({ ...crystalSymbol, reference: refs.crystal, at: [x + 22.86, y + 78.74],
      referenceAt: [x + 22.86, y + 71.12], valueAt: [x + 22.86, y + 74.93] });
    const left = point(region.pin(refs.crystal, crystalPins.left)), right = point(region.pin(refs.crystal, crystalPins.right));
    if (left[0] >= right[0] || left[1] !== right[1]) throw new Error('Orient crystal terminals horizontally');
    const nodes = [[x + 15.24, left[1]], [x + 30.48, right[1]]];
    const load = parts.loadCapacitors.map((part, i) => vertical(region, part, refs.loadCapacitors[i],
      [nodes[i][0], y + 87.63], 'top', 'bottom'));
    oscillator = { left, right, nodes, load };
  }
  return {
    reservedBounds: { origin: [x, y], size: [121.92, external ? 106.68 : 86.36] },
    ports: Object.fromEntries(Object.entries(pins.signals).map(([role, physical]) => [role, { reference: refs.mcu, pin: physical }])),
    connect() {
      const supplyPins = pins.supply.map(pin), railY = Math.min(...supplyPins.map(p => p[1])) - 7.62;
      for (const p of supplyPins) wire(region, p, [p[0], railY]);
      wire(region, [supplyPins[0][0], railY], [caps.at(-1).top[0], railY]); region.label(nets.supply, [supplyPins[0][0], railY]);
      region.marker('junction', [supplyPins[1][0], railY]);
      for (const physical of pins.ground) { const p = pin(physical), end = [p[0], p[1] + 5.08]; wire(region, p, end); region.label(nets.ground, end); }
      for (const c of caps) {
        const top = [c.top[0], railY], bottom = [c.bottom[0], c.bottom[1] + 5.08];
        wire(region, top, c.top); region.marker('junction', top); wire(region, c.bottom, bottom); region.label(nets.ground, bottom);
      }
      for (const [role, physical] of Object.entries(pins.signals)) {
        if (role === 'reset' || role === 'boot') continue;
        const p = pin(physical), end = [p[0] + (role === 'reset' || role === 'boot' ? -12.7 : 5.08), p[1]];
        wire(region, p, end); region.label(nets[role], end);
      }
      const resetPin = pin(pins.signals.reset), bootPin = pin(pins.signals.boot);
      const resetNode = [resetR.bottom[0], resetPin[1]], resetSupply = [resetR.top[0], resetR.top[1] - 5.08];
      if (resetR.bottom[1] >= resetPin[1] || resetC.top[1] <= resetPin[1] || bootR.top[1] <= bootPin[1]) {
        throw new Error('Keep reset pullup above NRST and reset capacitor/boot pulldown below their nodes');
      }
      wire(region, resetSupply, resetR.top); region.label(nets.supply, resetSupply);
      wire(region, resetR.bottom, resetNode);
      wire(region, [resetC.top[0], resetPin[1]], resetPin); region.marker('junction', resetNode);
      wire(region, [resetC.top[0], resetPin[1]], resetC.top);
      // Label a connected wire away from the MCU pin number.
      region.label(nets.reset, [resetNode[0] + 5.08, resetPin[1]]);
      const resetGround = [resetC.bottom[0], resetC.bottom[1] + 5.08];
      wire(region, resetC.bottom, resetGround); region.label(nets.ground, resetGround);
      const bootNode = [bootR.top[0], bootPin[1]], bootGround = [bootR.bottom[0], bootR.bottom[1] + 5.08];
      wire(region, bootPin, bootNode); wire(region, bootNode, bootR.top);
      region.label(nets.boot, bootNode); wire(region, bootR.bottom, bootGround); region.label(nets.ground, bootGround);
      if (oscillator) {
        const input = pin(pins.oscillator.input), output = pin(pins.oscillator.output);
        const { left, right, nodes, load } = oscillator;
        for (const [p, net] of [[input, nets.oscillatorInput], [output, nets.oscillatorOutput]]) {
          const end = [p[0] - 3.81, p[1]];
          wire(region, p, end); region.label(net, end, 180);
        }
        const clockNets = [nets.oscillatorInput, nets.oscillatorOutput];
        for (const [i, terminal] of [left, right].entries()) {
          wire(region, terminal, nodes[i]); wire(region, nodes[i], load[i].top); region.marker('junction', nodes[i]);
          const end = [nodes[i][0] + (i === 0 ? -3.81 : 3.81), nodes[i][1]];
          wire(region, nodes[i], end); region.label(clockNets[i], end, i === 0 ? 180 : 0);
          const ground = [load[i].bottom[0], load[i].bottom[1] + 3.81];
          wire(region, load[i].bottom, ground); region.label(nets.ground, ground);
        }
      }
      for (const physical of pins.unused) region.marker('no_connect', pin(physical));
    },
  };
}
