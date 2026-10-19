/** Small drawing helpers; coordinates are region-relative millimetres. */
export const point = ([x, y]) => [x, y].map(n => Math.round(n * 1e6) / 1e6);
export function vertical(region, part, reference, at, upper, lower) {
  const { pins, ...symbol } = part;
  region.addSymbol({ ...symbol, reference, at,
    referenceAt: [at[0] + 4, at[1] - 1.8], valueAt: [at[0] + 4, at[1] + 1.8] });
  const top = point(region.pin(reference, pins[upper]));
  const bottom = point(region.pin(reference, pins[lower]));
  if (top[0] !== bottom[0] || top[1] >= bottom[1]) {
    throw new Error(`${reference}: choose a vertical symbol orientation matching ${upper}/${lower}`);
  }
  return { top, bottom };
}
export function wire(region, from, to) {
  const a = point(from), b = point(to);
  if (a[0] !== b[0] || a[1] !== b[1]) region.wire(a, b);
}
