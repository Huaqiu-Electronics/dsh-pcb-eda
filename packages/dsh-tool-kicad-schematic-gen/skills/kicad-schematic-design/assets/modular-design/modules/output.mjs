/** Place the output resistance in its own region with a shared reference allocator. */
export function place({ region, parts, allocateReference, nets, bounds }) {
  const reference = allocateReference('R');
  const { pins, ...symbol } = parts.resistor;
  region.addSymbol({ ...symbol, reference, value: '10k', at: [40, 35] });
  return {
    bounds,
    ports: { signal: { reference, pin: pins.top } },
    connect() {
      const bottom = region.pin(reference, pins.bottom);
      const ground = [bottom[0], bottom[1] + 7.62];
      region.wire(bottom, ground);
      region.label(nets.ground, ground);
    },
  };
}
