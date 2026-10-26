/** Five-pin project-specific SWD header; VTREF is target voltage sense. */
import { wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, pinoutConfirmed }) {
  if (pinoutConfirmed !== true) throw new Error('Confirm physical header pinout and target voltage sense');
  const { pins, ...symbol } = parts.header;
  region.addSymbol({ ...symbol, reference: refs.header, at: [x + 35.56, y + 20.32],
    referenceAt: [x + 35.56, y + 5.08], valueAt: [x + 35.56, y + 8.89] });
  return {
    reservedBounds: { origin: [x, y], size: [60.96, 43.18] },
    ports: Object.fromEntries(Object.entries(pins).map(([role, pin]) => [role, { reference: refs.header, pin }])),
    connect() {
      for (const role of ['vtref', 'swdio', 'ground', 'swclk', 'reset']) {
        const p = point(region.pin(refs.header, pins[role]));
        const end = [p[0] - 10.16, p[1]];
        wire(region, p, end);
        if (role === 'ground') {
          const groundEnd = [end[0] - 7.62, end[1] + 15.24];
          wire(region, end, [groundEnd[0], end[1]]); wire(region, [groundEnd[0], end[1]], groundEnd);
          region.label(nets.ground, groundEnd);
        } else region.label(nets[role], end);
      }
    },
  };
}
