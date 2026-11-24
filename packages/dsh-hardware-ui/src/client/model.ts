/** Product-owned navigation and artifact identity. No shadow project database. */

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

export const DESTINATION_LABELS: Readonly<Record<HardwareDestination, string>> = Object.freeze({
  schematic: 'Schematic',
  pcb: 'PCB',
  bom: 'BOM',
  '3d': '3D CAD',
  order: 'Order Placing',
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
  /** Set once the first-run setup wizard has been completed or skipped. */
  readonly onboardingComplete?: boolean
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
  /** Host-side artifact discovery for one workspace root. */
  discover(cwd?: string, project?: string): Promise<DiscoveryInfo>
  /** Host-side installation validation. */
  installations(): Promise<InstallationsInfo>
  saveInstallation(application: 'kicad' | 'solidcraft', root: string): Promise<void>
  /** The host-backed configuration form, when the settings service is mounted. */
  configForm(): ConfigFormLike<HardwareInstallationConfig> | undefined
  /** Open or retarget the product viewer tab. */
  openDestination(destination: HardwareDestination, path?: string): void
  /** Launch the exact artifact in its configured native application. */
  openNative(request: {
    application: NativeApplication
    artifactPath: string
    kind: string
  }): Promise<void>
}
