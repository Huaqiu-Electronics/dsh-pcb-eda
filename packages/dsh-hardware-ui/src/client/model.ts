/** Product-owned navigation and artifact identity. No shadow project database. */
import { COPY } from './copy.js'

/** The five persistent product destinations. DFM and mechanical are out of scope. */
export type HardwareDestination = 'schematic' | 'pcb' | 'bom' | '3d' | 'order'

/**
 * Native applications a destination can hand off to.
 *
 * `3d` maps to KiCad because its source artifact is the selected `.kicad_pcb`;
 * SolidCraft is agent environment context only in this POC and never receives
 * a native-open action.
 */
export type NativeApplication = 'kicad'

export const DESTINATIONS: readonly HardwareDestination[] = Object.freeze([
  'schematic', 'pcb', 'bom', '3d', 'order',
])

/**
 * Visible destination labels, in `DESTINATIONS` order.
 *
 * Read from the copy module rather than written here: the same strings are
 * rendered from the navigation row and the viewer strip, and the two must never
 * disagree. Getters, not captured values: a DSH language switch must change the
 * navigation labels without a module reload. Keys stay in destination order
 * because the navigation maps over `DESTINATIONS`, not over this object.
 */
export const DESTINATION_LABELS: Readonly<Record<HardwareDestination, string>> = Object.freeze({
  get schematic() { return COPY.destinations.schematic },
  get pcb() { return COPY.destinations.pcb },
  get bom() { return COPY.destinations.bom },
  get '3d'() { return COPY.destinations['3d'] },
  get order() { return COPY.destinations.order },
})

/** Which native application a destination can open, if any. */
export function applicationFor(destination: HardwareDestination): NativeApplication | undefined {
  if (destination === 'schematic' || destination === 'pcb' || destination === 'bom' || destination === '3d') return 'kicad'
  return undefined
}

export interface HardwareArtifactInfo {
  readonly id: string
  readonly kind: string
  readonly path: string
  readonly title: string
  readonly sourcePath?: string
  readonly revision?: string
}

export interface HardwareProjectInfo {
  readonly path: string
  readonly name: string
  readonly sheetPath?: string
  readonly schematic?: HardwareArtifactInfo
  readonly bom?: HardwareArtifactInfo
  readonly pcb3d?: HardwareArtifactInfo
  readonly rootSheet?: HardwareArtifactInfo
  readonly sheets?: readonly HardwareArtifactInfo[]
  readonly boards?: readonly HardwareArtifactInfo[]
  readonly defaultBoard?: string
  readonly selectionRequired?: boolean
  /** Static order readiness the Host derives from the project's own files. */
  readonly order?: {
    readonly pcb: { readonly ready: boolean; readonly reason?: string }
    readonly pcba: { readonly ready: boolean; readonly reason?: string }
  }
}

export interface InstallationsInfo {
  readonly kicad?: {
    readonly configured: boolean
    readonly root?: string
    readonly version?: string
    readonly cli?: string
    readonly pcbEditor?: string
    readonly schematicEditor?: string
    readonly error?: string
  }
  readonly solidcraft?: {
    readonly configured: boolean
    readonly root?: string
    readonly executable?: string
    readonly error?: string
  }
}

export interface DiscoveryInfo {
  readonly cwd?: string
  readonly projects?: readonly HardwareProjectInfo[]
  readonly selected?: HardwareProjectInfo
  readonly issue?: { readonly code: string; readonly message: string }
}

export interface HardwareState {
  readonly activeDestination: HardwareDestination
  readonly workspaceRoot?: string
  readonly projectPath?: string
  readonly schematicPath?: string
  readonly sheetPath?: string
  readonly pcbPath?: string
  readonly bomPath?: string
  readonly discovery?: DiscoveryInfo
  readonly installations?: InstallationsInfo
  readonly revision: number
  readonly notice?: string
}

export interface HardwareActions {
  setActive(destination: HardwareDestination): void
  setWorkspaceRoot(root: string): void
  setDiscovery(discovery: DiscoveryInfo, preserveSelection?: boolean): void
  selectProject(path: string): void
  selectArtifact(path: string, kind: 'schematic' | 'pcb'): void
  /** Adopt one `sidebar.right.openTab` navigation into viewer state. */
  applyNavigation(params: ViewerNavigationParams): void
  setInstallations(installations: InstallationsInfo): void
  setNotice(notice?: string): void
  refresh(): void
}

export interface ConfigFormLike<T> {
  getSnapshot(): { readonly value?: T; readonly status?: string; readonly writable?: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

export interface HardwareInstallationConfig {
  readonly kicadRoot?: string
  readonly solidcraftRoot?: string
  /**
   * What the first-run step was told: `deferred` = skipped but still missing,
   * `complete` = configured (§4.6).
   *
   * This is the single source of truth. The legacy `onboardingComplete` boolean is
   * gone from the client (and from the Host schema) — internal-test builds do not
   * need the compatibility, and two overlapping flags made the state harder to
   * reason about than it was worth.
   */
  readonly toolchainSetup?: 'deferred' | 'complete'
}

/** Parameters carried by one `sidebar.right.openTab` navigation. */
export interface ViewerNavigationParams {
  readonly destination: HardwareDestination
  /** Canonical absolute artifact path for this destination. */
  readonly path?: string
  /** Artifact kind discriminator (`schematic` | `pcb` | `bom` | `pcb-3d`). */
  readonly kind?: string
  /** Source revision of the artifact at navigation time, when known. */
  readonly revision?: string
  readonly projectPath?: string
  /**
   * The manufacturing operation the user picked in the Place Order view.
   *
   * The order destination serves both; this only decides which workflow card's
   * confirmation opens first, so the choice between PCB and PCBA is carried
   * instead of being lost on the way.
   */
  readonly orderKind?: 'pcb' | 'smt'
  /**
   * Root schematic of the project being ordered.
   *
   * Discovery also assigns a unique schematic from the scanned tree, so a tab
   * that already had another project selected would otherwise package the new
   * board's PCBA with the old project's BOM and positions.
   */
  readonly schematicPath?: string
  /** Monotonic navigation counter: increments even when params are unchanged. */
  readonly navigationRevision: number
}

/**
 * The product's business face, delivered verbatim to every registered
 * component.
 *
 * It deliberately has no `hooks` member: DSH rebinds a `hooks` compartment into
 * `use<Name>` selector hooks over observables, so a plain function bundle there
 * would arrive as a broken selector instead of the object the component reads.
 * Each member is an ordinary function; state writes stay in the component's own
 * `actions`, so no shared mutable action capture is needed.
 */
export interface HardwareController {
  /**
   * Host-side artifact discovery for one workspace root.
   *
   * `session` scopes the result: the host remembers discovery per session, so
   * two viewers in different workspaces never overwrite each other's roots.
   */
  discover(cwd?: string, project?: string, session?: string): Promise<DiscoveryInfo>
  /** Host-side installation validation. */
  installations(): Promise<InstallationsInfo>
  saveInstallation(application: 'kicad' | 'solidcraft', root: string): Promise<void>
  /** The host-backed configuration form, when the settings service is mounted. */
  configForm(): ConfigFormLike<HardwareInstallationConfig> | undefined
  /** Open or retarget the product viewer tab. */
  openDestination(destination: HardwareDestination, path?: string): void
  /**
   * Open the plugin-owned Place Order view (project selection) in the panel.
   *
   * Idempotent by design: the view is one tab, so a second click from the
   * desktop menu reveals the tab that is already there instead of opening a
   * second copy. Returns whether a panel was asked to open it.
   */
  placeOrder(): boolean
  /**
   * Send one discovered project to the order destination, carrying the
   * operation the user picked there.
   */
  orderProject(request: {
    readonly projectPath: string
    readonly boardPath: string
    /** The project's root schematic, so PCBA orders this project, not the last one. */
    readonly schematicPath?: string
    readonly kind: 'pcb' | 'smt'
  }): void
  /** Launch the exact artifact in its configured native application. */
  openNative(request: {
    application: NativeApplication
    artifactPath: string
    kind: string
  }): Promise<void>
}
