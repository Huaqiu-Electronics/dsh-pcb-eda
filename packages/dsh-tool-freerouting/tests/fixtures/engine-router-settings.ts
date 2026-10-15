/** Real shape of settings exposed after DSN upload by the pinned 2.5 engine. */
export function engineRouterSettings(maxPasses = 100) {
  return {
    autorouter: { algorithm: 'freerouting-router', max_passes: maxPasses },
    optimizer: { enabled: true },
  };
}
