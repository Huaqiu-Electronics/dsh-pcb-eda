/** Add a load using selected component data and actual builder pin coordinates. */
export function place({ region, part, allocateReference, groundNet, placement }) {
  const reference = allocateReference('R');
  region.addSymbol({ libraryPath: part.libraryPath, libId: part.libId, unit: part.unit, footprint: part.footprint,
    reference, value: part.value, at: placement.at, angle: placement.angle ?? part.angle,
    referenceAt: placement.referenceAt, valueAt: placement.valueAt });
  return {
    ports: { signal: { reference, pin: part.pins.signal } },
    connect() {
      const at = region.pin(reference, part.pins.ground);
      const end = [at[0], at[1] + 7.62];
      region.wire(at, end);
      region.label(groundNet, end);
    },
  };
}
