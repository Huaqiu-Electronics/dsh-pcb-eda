/** Place the input resistance; connect only after all modules are placed. */
export function place({ region, parts, allocateReference, nets, bounds }) {
  const reference = allocateReference('R');
  const { pins, ...symbol } = parts.resistor;
  region.addSymbol({ ...symbol, reference, value: '10k', at: [40, 35] });
  return {
    bounds,
    ports: { signal: { reference, pin: pins.bottom } },
    connect() {
      const top = region.pin(reference, pins.top);
      const supply = [top[0], top[1] - 7.62];
      region.wire(top, supply);
      region.label(nets.supply, supply);
    },
  };
}
