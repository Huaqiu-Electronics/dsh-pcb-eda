/**
 * Product state handle: a spec (init + complete write set) plus a per-scope
 * instance factory, following DSH's declared-store contract.
 *
 * DSH pins one handle to one slot scope ("one handle, one scope"): the
 * navigation and settings seats are `root`, the right-panel viewer seat is
 * `session`. That is why `apply()` creates two handles — `root` state for the
 * product chrome, `session` state for one viewer — instead of sharing one.
 * Handles are created inside `apply()`, never at module scope, so a plugin
 * reload cannot resurrect an old snapshot.
 */
import type {
  HardwareActions, HardwareDestination, HardwareState, DiscoveryInfo, InstallationsInfo,
  ViewerNavigationParams,
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

/** A selected project resets artifact selections to its own defaults. */
function adoptProject(draft: Mutable<HardwareState>, project: DiscoveryInfo['selected']): void {
  draft.projectPath = project?.path
  const schematic = project?.sheetPath ?? project?.schematic?.path ?? project?.rootSheet?.path
  if (schematic === undefined) delete draft.schematicPath
  else draft.schematicPath = schematic
  if (schematic === undefined) delete draft.sheetPath
  else draft.sheetPath = schematic
  const board = project?.defaultBoard ?? project?.boards?.[0]?.path
  if (board === undefined) delete draft.pcbPath
  else draft.pcbPath = board
  draft.bomPath = project?.bom?.path
}

const mutators = {
  setActive(draft: Mutable<HardwareState>, destination: HardwareDestination): void {
    draft.activeDestination = destination
    draft.revision += 1
  },
  setWorkspaceRoot(draft: Mutable<HardwareState>, root: string): void {
    draft.workspaceRoot = root
  },
  setDiscovery(draft: Mutable<HardwareState>, discovery: DiscoveryInfo, preserveSelection?: boolean): void {
    // A different workspace invalidates every artifact path held from the old
    // one: the host authorizes against the session's workspace, so keeping a
    // selection across that move turns the next read into "artifact is outside
    // the authorized workspace". The session's workspace moving is also
    // user-triggered, so it takes the same reset path as a new project.
    const moved = discovery.cwd !== undefined
      && draft.workspaceRoot !== undefined
      && discovery.cwd !== draft.workspaceRoot
    draft.discovery = discovery
    draft.workspaceRoot = discovery.cwd ?? draft.workspaceRoot
    // A viewer refresh must not clobber the artifact a navigation just selected:
    // it only learns which project the workspace resolves to.
    if (preserveSelection === true && !moved) {
      if (discovery.selected !== undefined) draft.projectPath = discovery.selected.path
    } else {
      adoptProject(draft, discovery.selected)
    }
    draft.revision += 1
  },
  selectProject(draft: Mutable<HardwareState>, path: string): void {
    const project = draft.discovery?.projects?.find(candidate => candidate.path === path)
    adoptProject(draft, project)
    draft.revision += 1
  },
  selectArtifact(draft: Mutable<HardwareState>, path: string, kind: 'schematic' | 'pcb'): void {
    if (kind === 'schematic') {
      draft.schematicPath = path
      draft.sheetPath = path
    } else {
      draft.pcbPath = path
    }
    draft.revision += 1
  },
  applyNavigation(draft: Mutable<HardwareState>, params: ViewerNavigationParams): void {
    draft.activeDestination = params.destination
    if (params.projectPath !== undefined) draft.projectPath = params.projectPath
    if (params.path !== undefined) {
      if (params.destination === 'schematic' || params.destination === 'bom') {
        draft.schematicPath = params.path
        draft.sheetPath = params.path
      } else if (params.destination === 'pcb' || params.destination === '3d' || params.destination === 'order') {
        draft.pcbPath = params.path
      }
    }
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
          setDiscovery: (discovery, preserveSelection) => commit(draft => mutators.setDiscovery(draft, discovery, preserveSelection)),
          selectProject: path => commit(draft => mutators.selectProject(draft, path)),
          selectArtifact: (path, kind) => commit(draft => mutators.selectArtifact(draft, path, kind)),
          applyNavigation: params => commit(draft => mutators.applyNavigation(draft, params)),
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
