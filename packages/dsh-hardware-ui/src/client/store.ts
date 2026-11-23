/**
 * One store handle shared by the navigation, viewer, context action and
 * settings registrations. It follows DSH's declared-store contract: a spec
 * (init + complete write set) plus a per-scope instance factory. The handle is
 * created inside `apply()`, never at module scope, so a plugin reload cannot
 * resurrect an old snapshot.
 */
import type {
  HardwareActions, HardwareDestination, HardwareState, DiscoveryInfo, InstallationsInfo,
} from './model.js'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

type Mutator = (draft: Mutable<HardwareState>, ...params: unknown[]) => void

export interface HardwareStoreInstance {
  readonly actions: HardwareActions
  getSnapshot(): HardwareState
  subscribe(listener: () => void): () => void
  clearPersisted(): void
}

export interface HardwareStoreHandle {
  readonly spec: {
    readonly init: () => HardwareState
    readonly actions: Record<string, Mutator>
  }
  create(scopeKey?: string): HardwareStoreInstance
}

function initial(): HardwareState {
  return { activeDestination: 'schematic', revision: 0 }
}

const mutators = {
  setActive(draft: Mutable<HardwareState>, destination: HardwareDestination): void {
    draft.activeDestination = destination
    draft.revision += 1
  },
  setWorkspaceRoot(draft: Mutable<HardwareState>, root: string): void {
    draft.workspaceRoot = root
  },
  setDiscovery(draft: Mutable<HardwareState>, discovery: DiscoveryInfo): void {
    draft.discovery = discovery
    draft.workspaceRoot = discovery.cwd ?? draft.workspaceRoot
    draft.projectPath = discovery.selected?.path
    const selected = discovery.selected
    draft.schematicPath = selected?.sheetPath ?? selected?.schematic?.path
    draft.pcbPath = selected?.boards?.[0]?.path ?? selected?.pcb3d?.path
    draft.mechanicalPath = selected?.mechanical?.[0]?.path
    draft.revision += 1
  },
  selectArtifact(draft: Mutable<HardwareState>, path: string, kind: 'schematic' | 'pcb' | 'mechanical-3d'): void {
    if (kind === 'schematic') draft.schematicPath = path
    else if (kind === 'pcb') draft.pcbPath = path
    else draft.mechanicalPath = path
    draft.revision += 1
  },
  setInstallations(draft: Mutable<HardwareState>, installations: InstallationsInfo): void {
    draft.installations = installations
    draft.revision += 1
  },
  setNotice(draft: Mutable<HardwareState>, notice?: string): void {
    if (notice === undefined) delete draft.notice
    else draft.notice = notice
  },
  refresh(draft: Mutable<HardwareState>): void {
    draft.revision += 1
  },
}

/** Create the shared handle. Call once inside `apply()`. */
export function createHardwareStore(): HardwareStoreHandle {
  return {
    spec: { init: initial, actions: mutators as unknown as Record<string, Mutator> },
    create(): HardwareStoreInstance {
      let snapshot = initial()
      const listeners = new Set<() => void>()
      const commit = (mutate: (draft: Mutable<HardwareState>) => void): void => {
        const draft: Mutable<HardwareState> = { ...snapshot }
        mutate(draft)
        snapshot = draft
        for (const listener of [...listeners]) listener()
      }
      return {
        actions: {
          setActive: destination => commit(draft => mutators.setActive(draft, destination)),
          setWorkspaceRoot: root => commit(draft => { draft.workspaceRoot = root }),
          setDiscovery: discovery => commit(draft => mutators.setDiscovery(draft, discovery)),
          selectArtifact: (path, kind) => commit(draft => mutators.selectArtifact(draft, path, kind)),
          setInstallations: installations => commit(draft => mutators.setInstallations(draft, installations)),
          setNotice: notice => commit(draft => mutators.setNotice(draft, notice)),
          refresh: () => commit(draft => mutators.refresh(draft)),
        },
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        clearPersisted() {},
      }
    },
  }
}
