/** USB 2.0 UFP/sink receptacle only; no PD or source/DRP behavior. */
import { vertical, wire, point } from './geometry.mjs';
export function place({ region, at: [x, y], parts, references: refs, nets, ufpSinkConfirmed, shieldToGroundConfirmed }) {
  if (ufpSinkConfirmed !== true || shieldToGroundConfirmed !== true) throw new Error('Confirm UFP/sink and explicit shield grounding policy');
  const { pins, ...symbol } = parts.connector;
  region.addSymbol({ ...symbol, reference: refs.connector, at: [x + 25.4, y + 30.48],
    referenceAt: [x + 25.4, y], valueAt: [x + 25.4, y + 3.81] });
  const pin = n => point(region.pin(refs.connector, n));
  const rd = parts.rd.map((part, i) => vertical(region, part, refs.rd[i], [x + 76.2 + i * 25.4, y + 35.56], 'top', 'bottom'));
  const ports = { vbus: { reference: refs.connector, pin: pins.vbus[0] },
    dp: { reference: refs.connector, pin: pins.dp[0] }, dm: { reference: refs.connector, pin: pins.dm[0] } };
  return {
    reservedBounds: { origin: [x, y], size: [124.46, 71.12] }, ports,
    connect() {
      for (const [physical, net] of [[pins.vbus[0], nets.vbus], [pins.cc1, nets.cc1], [pins.cc2, nets.cc2]]) {
        const p = pin(physical), end = [p[0] + 7.62, p[1]];
        wire(region, p, end); region.label(net, end);
      }
      for (const [pair, net] of [[pins.dm, nets.dm], [pins.dp, nets.dp]]) {
        const a = pin(pair[0]), b = pin(pair[1]), end = [a[0] + 5.08, a[1]];
        wire(region, a, end); wire(region, b, [end[0], b[1]]); wire(region, end, [end[0], b[1]]);
        region.label(net, end);
      }
      rd.forEach((r, i) => {
        const top = [r.top[0], r.top[1] - 5.08], bottom = [r.bottom[0], r.bottom[1] + 5.08];
        wire(region, top, r.top); region.label(i === 0 ? nets.cc1 : nets.cc2, top);
        wire(region, r.bottom, bottom); region.label(nets.ground, bottom);
      });
      const ground = pin(pins.ground[0]), shield = pin(pins.shield), groundY = ground[1] + 5.08;
      wire(region, ground, [ground[0], groundY]); wire(region, shield, [shield[0], groundY]);
      wire(region, [shield[0], groundY], [ground[0], groundY]); region.label(nets.ground, [ground[0], groundY]);
      for (const unused of pins.unused) region.marker('no_connect', pin(unused));
    },
  };
}
