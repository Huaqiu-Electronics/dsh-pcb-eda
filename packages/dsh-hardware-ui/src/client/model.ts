/** Product-owned navigation and artifact identity. No shadow project database. */

export type HardwareDestination = 'schematic' | 'pcb' | 'dfm' | 'bom' | '3d' | 'order'
export type NativeApplication = 'kicad' | 'solidcraft'

export const DESTINATIONS: readonly HardwareDestination[] = Object.freeze([
  'schematic', 'pcb', 'dfm', 'bom', '3d', 'order',
])

export const DESTINATION_LABELS: Readonly<Record<HardwareDestination, string>> = Object.freeze({
  schematic: 'Schematic',
  pcb: 'PCB',
  dfm: 'DFM',
  bom: 'BOM',
  '3d': '3D CAD',
  order: 'Order Placing',
})

/** Which native application a destination can open, if any. */
export function applicationFor(destination: HardwareDestination): NativeApplication | undefined {
  if (destination === 'schematic' || destination === 'pcb' || destination === 'dfm' || destination === 'bom') return 'kicad'
  if (destination === '3d') return 'solidcraft'
  return undefined
}

export interface HardwareArtifactInfo {
  readonly id: string
  readonly kind: string
  readonly path: string
  readonly title: string
  readonly sourcePath?: string
}

export interface HardwareProjectInfo {
  readonly path: string
  readonly name: string
  readonly sheetPath?: string
  readonly schematic?: HardwareArtifactInfo
  readonly bom?: HardwareArtifactInfo
  readonly pcb3d?: HardwareArtifactInfo
  readonly sheets?: readonly HardwareArtifactInfo[]
  readonly boards?: readonly HardwareArtifactInfo[]
  readonly mechanical?: readonly HardwareArtifactInfo[]
}

export interface InstallationsInfo {
  readonly kicad?: {
    readonly configured: boolean
    readonly version?: string
    readonly cli?: string
    readonly pcbEditor?: string
    readonly schematicEditor?: string
    readonly error?: string
  }
  readonly solidcraft?: {
    readonly configured: boolean
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
  readonly mechanicalPath?: string
  readonly discovery?: DiscoveryInfo
  readonly installations?: InstallationsInfo
  readonly revision: number
  readonly notice?: string
}

export interface HardwareActions {
  setActive(destination: HardwareDestination): void
  setWorkspaceRoot(root: string): void
  setDiscovery(discovery: DiscoveryInfo): void
  selectArtifact(path: string, kind: 'schematic' | 'pcb' | 'mechanical-3d'): void
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
}

/** Functions the UI receives through the slot `inject` face. */
export interface HardwareInjected {
  refreshDiscovery(cwd?: string, project?: string): Promise<void>
  openDestination(destination: HardwareDestination, path?: string): void
  openNative(application?: NativeApplication, artifactPath?: string): Promise<void>
  saveInstallation(application: NativeApplication, root: string): Promise<void>
  fetchInstallations(): Promise<void>
  useConfigForm?(): ConfigFormLike<HardwareInstallationConfig> | undefined
  useSessions?(selector: (state: {
    readonly ids: readonly string[]
    readonly byId: Readonly<Record<string, { readonly cwd?: string }>>
  }) => string | undefined): string | undefined
}
