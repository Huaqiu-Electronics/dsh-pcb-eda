/**
 * `@huaqiu/hardware-engineering` — the Huaqiu Hardware Engineering product bundle.
 *
 * This package is a **bundle**, not a plugin. It is never mounted as a loader
 * row: DSH reads its `dsh.bundle.patch` (`./cordis.patch.yml`), merges that
 * patch into the profile's layer stack, and mounts the eleven plugin rows the
 * patch inserts. The plugin packages themselves are ordinary `dependencies` of
 * this package, which is what makes them resolvable from the installation
 * anchor without a profile-local install.
 *
 * ── Why the manifest below exists ──────────────────────────────────────────
 * A YAML patch is not importable, so nothing can prove it stayed in sync with
 * the package's dependency ledger. {@link HARDWARE_ENGINEERING_PLUGINS} is the
 * machine-readable copy of the same facts; `test/bundle.test.ts` asserts it
 * against both `cordis.patch.yml` and `package.json`, so a row added to one
 * place and forgotten in the other fails the build instead of failing silently
 * at profile boot (where a bad row only produces a stderr skip line).
 *
 * Keep {@link HARDWARE_ENGINEERING_PLUGINS} in the same order as the patch.
 *
 * ── Ownership ──────────────────────────────────────────────────────────────
 * The bundle owns composition and activation order only. Each plugin owns its
 * own tools, services, client half and host capability boundaries; this package
 * must not import them or reach into their internals.
 *
 * @module @huaqiu/hardware-engineering
 */

/** The bundle package name — the identity a profile lists in `dsh.profile.bundles`. */
export const BUNDLE_PACKAGE = '@huaqiu/hardware-engineering'

/** Human-readable bundle id used by diagnostics and the POC report. */
export const BUNDLE_ID = 'huaqiu-hardware-engineering'

/** Which layer of the product a row belongs to. */
export type HardwareEngineeringPluginRole = 'provider' | 'capability' | 'presentation'

/** One loader row the bundle patch inserts. */
export interface HardwareEngineeringPlugin {
  /** Loader entry id — identical to the plugin package's own patch id. */
  readonly id: string
  /** npm package name mounted by the row. */
  readonly name: string
  /** Cordis services the row gates activation on. */
  readonly inject: readonly string[]
  /** Cordis services the row provides to other rows. */
  readonly provides: readonly string[]
  /** Composition layer, for readers and for the report. */
  readonly role: HardwareEngineeringPluginRole
}

/**
 * The plugin set shipped by this bundle, in patch order.
 *
 * Empty `inject` means the row needs no service to activate (a browser-only or
 * route-only plugin whose node half has nothing to wait for).
 */
export const HARDWARE_ENGINEERING_PLUGINS: readonly HardwareEngineeringPlugin[] = Object.freeze([
  // Service providers first: consumers below wait on these two.
  Object.freeze({ id: 'huaqiu-auth', name: '@huaqiu/dsh-auth', inject: ['webServer'], provides: ['huaqiuAuth'], role: 'provider' }),
  Object.freeze({ id: 'huaqiu-artifacts', name: '@huaqiu/dsh-artifacts', inject: ['webServer'], provides: ['huaqiuArtifacts'], role: 'provider' }),
  Object.freeze({ id: 'hardware-artifacts', name: '@huaqiu/hardware-artifacts', inject: ['webServer', 'systemPrompt'], provides: ['hardwareArtifacts'], role: 'provider' }),

  Object.freeze({ id: 'huaqiu-dsh-kicad', name: '@huaqiu/dsh-kicad', inject: ['skills', 'tools'], provides: [], role: 'capability' }),
  Object.freeze({
    id: 'dsh-tool-kicad-schematic-gen',
    name: '@huaqiu/dsh-tool-kicad-schematic-gen',
    inject: ['tools', 'fs', 'sandboxPolicy', 'skills', 'webServer'],
    provides: [],
    role: 'capability',
  }),
  Object.freeze({ id: 'huaqiu-tool-part-search', name: '@huaqiu/dsh-tool-part-search', inject: ['tools'], provides: [], role: 'capability' }),
  Object.freeze({
    id: 'huaqiu-tool-symbol-footprint',
    name: '@huaqiu/dsh-tool-symbol-footprint',
    inject: ['tools', 'huaqiuAuth', 'huaqiuArtifacts', 'webServer'],
    provides: [],
    role: 'capability',
  }),

  // Telemetry: routes + tools only, no service of its own.
  Object.freeze({
    id: 'huaqiu-analytics',
    name: '@huaqiu/dsh-analytics',
    inject: ['webServer', 'tools'],
    provides: [],
    role: 'capability',
  }),

  Object.freeze({ id: 'ui-theme-huaqiu', name: '@huaqiu/dsh-ui-theme-huaqiu', inject: [], provides: [], role: 'presentation' }),
  Object.freeze({ id: 'dsh-huaqiu-about', name: '@huaqiu/dsh-huaqiu-about', inject: [], provides: [], role: 'presentation' }),
  Object.freeze({ id: 'dsh-hardware-ui', name: '@huaqiu/dsh-hardware-ui', inject: [], provides: [], role: 'presentation' }),
]) as readonly HardwareEngineeringPlugin[]

/** Package names the bundle depends on and mounts, in patch order. */
export const HARDWARE_ENGINEERING_PLUGIN_NAMES: readonly string[] = Object.freeze(
  HARDWARE_ENGINEERING_PLUGINS.map((plugin) => plugin.name),
)

/**
 * Every Cordis service name this bundle requires from the host profile.
 *
 * Used by the activation test to distinguish "the bundle is complete" from
 * "the host profile happens to supply everything it needs".
 */
export const HARDWARE_ENGINEERING_REQUIRED_SERVICES: readonly string[] = Object.freeze(
  [...new Set(HARDWARE_ENGINEERING_PLUGINS.flatMap((plugin) => [...plugin.inject]))].sort(),
)

/** Every Cordis service the bundle itself provides (as opposed to consuming). */
export const HARDWARE_ENGINEERING_PROVIDED_SERVICES: readonly string[] = Object.freeze(
  [...new Set(HARDWARE_ENGINEERING_PLUGINS.flatMap((plugin) => [...plugin.provides]))].sort(),
)
