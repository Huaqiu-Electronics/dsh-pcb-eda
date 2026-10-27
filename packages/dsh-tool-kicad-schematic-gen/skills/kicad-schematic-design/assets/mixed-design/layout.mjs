/** Layout-only settings; part identities and electrical roles remain in the project config. */
export const loadPlacement = { at: [30.48, 25.4] };

/** Optional caller edits before conversion. Select labels with the current-build catalog.
 * Use plan.placements[uuid] = {at, angle, valueAt}; inspect save().powerLayout afterwards.
 */
export function configurePowerPlacements(sch, plan) {
  // Add only confirmed local overrides here; never copy a UUID from a previous run.
}
