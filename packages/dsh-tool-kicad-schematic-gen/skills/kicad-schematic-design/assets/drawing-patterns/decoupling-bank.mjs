import { vertical, wire } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, pitch = 20.32 }) {
  if (!parts.capacitors.length || parts.capacitors.length !== refs.capacitors.length || pitch < 15.24) {
    throw new Error('Provide matching nonempty capacitor/reference arrays and pitch >= 15.24 mm');
  }
  const caps = parts.capacitors.map((part, i) => vertical(region, part, refs.capacitors[i],
    [x + 8 + i * pitch, y + 16], 'top', 'bottom'));
  const topY = Math.min(...caps.map(c => c.top[1])) - 5.08;
  const bottomY = Math.max(...caps.map(c => c.bottom[1])) + 5.08;
  return {
    reservedBounds: { origin: [x, y], size: [32 + (caps.length - 1) * pitch, 36] },
    ports: { supply: { reference: refs.capacitors[0], pin: parts.capacitors[0].pins.top },
      ground: { reference: refs.capacitors[0], pin: parts.capacitors[0].pins.bottom } },
    connect() {
      caps.forEach((c, i) => {
        const top = [c.top[0], topY], bottom = [c.bottom[0], bottomY];
        wire(region, top, c.top); wire(region, c.bottom, bottom);
        if (i) { wire(region, [caps[i - 1].top[0], topY], top); wire(region, [caps[i - 1].bottom[0], bottomY], bottom); }
        if (i < caps.length - 1) { region.marker('junction', top); region.marker('junction', bottom); }
      });
      region.label(nets.supply, [caps[0].top[0], topY]);
      region.label(nets.ground, [caps[0].bottom[0], bottomY]);
    },
  };
}
