/**
 * Hardware Engineering UI components. All state reaches them through the
 * standard slot props (`useStore`, `actions`) and one injected hook bundle;
 * nothing here imports Node APIs or reaches into another plugin's singleton.
 */
import {
  createElement, useEffect, useMemo, useState, useSyncExternalStore,
  type ChangeEvent, type CSSProperties, type ReactNode,
} from 'react'
import {
  applicationFor, DESTINATIONS, DESTINATION_LABELS,
  type HardwareActions, type HardwareArtifactInfo, type HardwareDestination,
  type HardwareInjected, type HardwareInstallationConfig, type HardwareState,
} from './model.js'
import { HardwarePreview } from './preview.js'

type UseStore = <S>(selector: (state: HardwareState) => S) => S

interface SlotProps {
  readonly useStore: UseStore
  readonly actions: HardwareActions
  readonly hooks: HardwareInjected
  readonly t?: (key: string) => string
}

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }
const NAV: CSSProperties = { ...ROW, minWidth: 0, fontSize: 12 }
const TAB: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.3))',
  borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
  padding: '3px 8px', cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap',
}
const ACTIVE: CSSProperties = {
  ...TAB, color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-brand-primary, currentColor)',
  background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, currentColor) 10%, transparent)',
}
const PATH: CSSProperties = {
  minWidth: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-tertiary)', fontSize: 11,
}
const ROOT: CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0,
  boxSizing: 'border-box', padding: 12, gap: 10,
  color: 'var(--dsw-alias-label-primary)', overflow: 'auto',
}
const HEADER: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const TITLE: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 }
const BUTTON: CSSProperties = {
  ...TAB, padding: '5px 10px', color: 'var(--dsw-alias-label-primary)',
}
const FIELD: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }
const INPUT: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.3))',
  background: 'transparent', color: 'inherit', font: 'inherit',
}
const MUTED: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0 }
const SELECT: CSSProperties = { ...INPUT, cursor: 'pointer' }

function option(value: string, label: string, selected: boolean): ReactNode {
  return createElement('option', { key: value, value, selected }, label)
}

function artworkOptions(artifacts: readonly HardwareArtifactInfo[] | undefined, kind: string): ReactNode[] {
  return (artifacts ?? []).filter(artifact => artifact.kind === kind)
    .map(artifact => option(artifact.path, artifact.title || artifact.path, false))
}

/** Five persistent destinations in the conversation header's leading seat. */
export function EngineeringNav({
  useStore, actions, hooks, useSessions,
}: SlotProps & {
  useSessions?: (selector: (state: {
    readonly ids: readonly string[]
    readonly byId: Readonly<Record<string, { readonly cwd?: string }>>
  }) => string | undefined) => string | undefined
}): ReactNode {
  const active = useStore(state => state.activeDestination)
  const projectPath = useStore(state => state.projectPath)
  const cwd = useSessions?.(state => {
    const id = state.ids[0]
    return id === undefined ? undefined : state.byId[id]?.cwd
  })
  useEffect(() => { void hooks.refreshDiscovery(cwd) }, [cwd, hooks])
  return createElement(
    'div',
    { style: NAV, 'data-hardware-nav': true },
    ...DESTINATIONS.map(destination => createElement(
      'button',
      {
        key: destination, type: 'button',
        style: destination === active ? ACTIVE : TAB,
        'aria-pressed': destination === active,
        'data-destination': destination,
        onClick: () => {
          actions.setActive(destination)
          hooks.openDestination(destination)
        },
      },
      DESTINATION_LABELS[destination],
    )),
    ...(projectPath === undefined ? [] : [createElement('span', { key: 'path', style: PATH, title: projectPath }, projectPath)]),
  )
}

/** The artifact a destination previews, with its canonical identity. */
export function selectedArtifact(state: HardwareState, destination: HardwareDestination): HardwareArtifactInfo | undefined {
  const project = state.discovery?.selected
  const schematic: HardwareArtifactInfo | undefined = state.schematicPath === undefined
    ? project?.schematic
    : { id: `schematic:${state.schematicPath}`, kind: 'schematic', path: state.schematicPath, title: state.schematicPath.split(/[\\/]/u).pop() ?? state.schematicPath }
  const board: HardwareArtifactInfo | undefined = state.pcbPath === undefined
    ? project?.boards?.find(candidate => candidate.path === project?.defaultBoard) ?? project?.boards?.[0]
    : { id: `pcb:${state.pcbPath}`, kind: 'pcb', path: state.pcbPath, title: state.pcbPath.split(/[\\/]/u).pop() ?? state.pcbPath }
  if (destination === 'schematic' || destination === 'bom') return schematic
  if (destination === 'pcb' || destination === '3d') return board
  return board
}

function missingReason(state: HardwareState, destination: HardwareDestination): string | undefined {
  const discovery = state.discovery
  if (discovery === undefined) return undefined
  if (discovery.issue?.code === 'selection-required' && discovery.projects !== undefined && discovery.projects.length > 1) {
    return `${discovery.projects.length} projects found; choose one explicitly.`
  }
  if (discovery.selected === undefined) return 'No hardware project selected. Open or select a hardware project.'
  if (destination === 'schematic' || destination === 'bom') {
    if (discovery.selected.schematic === undefined) return 'This project has no discoverable root schematic.'
  }
  if (destination === 'pcb' || destination === '3d') {
    if ((discovery.selected.boards?.length ?? 0) === 0) return 'This project has no discoverable .kicad_pcb board.'
  }
  if (destination === 'order') {
    if ((discovery.selected.boards?.length ?? 0) === 0) return 'Select a board before quoting or ordering fabrication.'
  }
  return undefined
}

/** Right-panel body: one destination at a time, with explicit selectors. */
export function HardwareViewerBody({
  useStore, actions, hooks, tab,
}: SlotProps & {
  tab?: {
    readonly navigation?: {
      readonly params?: Readonly<Record<string, unknown>>
      readonly revision?: number
    }
  }
}): ReactNode {
  const active = useStore(state => state.activeDestination)
  const discovery = useStore(state => state.discovery)
  const projectPath = useStore(state => state.projectPath)
  const schematicPath = useStore(state => state.schematicPath)
  const pcbPath = useStore(state => state.pcbPath)
  const notice = useStore(state => state.notice)
  const installations = useStore(state => state.installations)
  const revision = tab?.navigation?.revision ?? 0
  const selectedProject = discovery?.selected

  useEffect(() => { void hooks.fetchInstallations() }, [hooks])

  const artifact = useStore(state => selectedArtifact(state, active))
  const reason = useStore(state => missingReason(state, active))
  const application = applicationFor(active)
  const kicadConfigured = installations?.kicad?.configured ?? false
  const nativeLabel = application === 'kicad' ? 'Open in KiCad' : 'No native action'
  const canOpenNative = application !== undefined && kicadConfigured && artifact !== undefined && active !== 'order'

  const header = createElement(
    'div',
    { style: HEADER },
    createElement('h2', { style: TITLE }, DESTINATION_LABELS[active]),
    ...(application === undefined ? [] : [createElement(
      'button',
      {
        key: 'native', type: 'button', style: BUTTON, disabled: !canOpenNative,
        title: canOpenNative
          ? `${nativeLabel}: ${artifact?.path ?? ''}`
          : kicadConfigured
            ? 'Select an artifact before opening it in KiCad.'
            : 'Configure KiCad in Settings → Hardware Engineering.',
        'data-hardware-native-open': true,
        onClick: () => { void hooks.openNative(application, artifact?.path).catch(error => actions.setNotice(String(error))) },
      },
      nativeLabel,
    )]),
  )

  const selectors: ReactNode[] = []
  if (discovery !== undefined && (discovery.projects?.length ?? 0) > 0) {
    selectors.push(createElement(
      'label',
      { key: 'project', style: FIELD },
      'Project',
      createElement('select', {
        style: SELECT, value: projectPath ?? '',
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          actions.selectProject(event.currentTarget.value)
          void hooks.refreshDiscovery(undefined, event.currentTarget.value)
        },
      },
      option('', 'Select a project…', projectPath === undefined),
      ...(discovery?.projects ?? []).map(project => option(project.path, project.name, project.path === projectPath))),
    ))
  }
  if ((active === 'schematic' || active === 'bom') && selectedProject !== undefined) {
    const candidates: HardwareArtifactInfo[] = [selectedProject.schematic, ...(selectedProject.sheets ?? [])]
      .filter((candidate): candidate is HardwareArtifactInfo => candidate !== undefined)
    selectors.push(createElement(
      'label',
      { key: 'sheet', style: FIELD },
      'Schematic / sheet',
      createElement('select', {
        style: SELECT, value: schematicPath ?? '',
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          actions.selectArtifact(event.currentTarget.value, 'schematic')
          hooks.openDestination(active, event.currentTarget.value)
        },
      },
      option('', 'Select a schematic…', schematicPath === undefined),
      ...candidates.map(candidate => option(candidate.path, candidate.title, false))),
    ))
  }
  if ((active === 'pcb' || active === '3d' || active === 'order') && selectedProject !== undefined) {
    selectors.push(createElement(
      'label',
      { key: 'board', style: FIELD },
      'Board',
      createElement('select', {
        style: SELECT, value: pcbPath ?? '',
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          actions.selectArtifact(event.currentTarget.value, 'pcb')
          hooks.openDestination(active, event.currentTarget.value)
        },
      },
      option('', 'Select a board…', pcbPath === undefined),
      ...artworkOptions(selectedProject.boards, 'pcb')),
    ))
  }

  return createElement(
    'div',
    { style: ROOT, 'data-hardware-destination': active },
    header,
    ...(notice === undefined ? [] : [createElement('p', { key: 'notice', style: MUTED, role: 'status' }, notice)]),
    ...(discovery?.issue === undefined || discovery.issue.code === 'selection-required' && (discovery.projects?.length ?? 0) <= 1
      ? []
      : [createElement('p', { key: 'issue', style: MUTED, role: 'status' }, discovery.issue.message)]),
    createElement('p', { key: 'project-path', style: MUTED },
      projectPath === undefined ? 'No canonical KiCad project selected.' : `Project: ${projectPath}`),
    ...selectors,
    ...(reason === undefined
      ? [createElement(HardwarePreview, {
          key: `preview:${revision}`,
          destination: active,
          artifact,
          projectPath,
          revision: revision,
          notice,
        })]
      : [createElement('p', { key: 'reason', style: MUTED, role: 'status', 'data-hardware-state': 'missing' }, reason)]),
    ...(application === undefined || kicadConfigured ? [] : [createElement('p', {
      key: 'unconfigured', style: MUTED,
    }, 'Configure KiCad in Settings → Hardware Engineering to enable previews and native open.')]),
    ...(artifact === undefined || reason !== undefined ? [] : [createElement('p', {
      key: 'identity', style: MUTED, 'data-hardware-identity': true,
    }, `Selected: ${artifact.path}`)]),
  )
}

/** Settings section for the two CAD installation roots. */
export function HardwareSettingsSection({ hooks }: { readonly hooks: HardwareInjected }): ReactNode {
  const form = hooks.useConfigForm?.()
  const emptySnapshot: { value?: HardwareInstallationConfig } = {}
  const snapshot = useSyncExternalStore<{ value?: HardwareInstallationConfig }>(
    form?.subscribe.bind(form) ?? (() => () => {}),
    form?.getSnapshot.bind(form) ?? (() => emptySnapshot),
    form?.getSnapshot.bind(form) ?? (() => emptySnapshot),
  )
  const value = snapshot.value
  const [kicadRoot, setKicadRoot] = useState(value?.kicadRoot ?? '')
  const [solidcraftRoot, setSolidcraftRoot] = useState(value?.solidcraftRoot ?? '')
  const [message, setMessage] = useState('')
  useEffect(() => {
    setKicadRoot(value?.kicadRoot ?? '')
    setSolidcraftRoot(value?.solidcraftRoot ?? '')
  }, [value?.kicadRoot, value?.solidcraftRoot])

  const save = async (application: 'kicad' | 'solidcraft', root: string): Promise<void> => {
    try {
      await hooks.saveInstallation(application, root)
      await hooks.fetchInstallations()
      setMessage(`${application === 'kicad' ? 'KiCad' : 'SolidCraft'} installation saved and validated.`)
    } catch (error) {
      setMessage(String(error))
    }
  }

  return createElement(
    'div',
    { style: { ...ROOT, height: 'auto' }, 'data-hardware-settings': true },
    createElement('h2', { style: TITLE }, 'Hardware Engineering'),
    createElement('label', { style: FIELD }, 'KiCad installation root or kicad-cli path',
      createElement('input', { style: INPUT, value: kicadRoot, onChange: event => setKicadRoot(event.currentTarget.value) }),
    ),
    createElement('button', { type: 'button', style: BUTTON, onClick: () => { void save('kicad', kicadRoot) } }, 'Validate / Save KiCad'),
    createElement('p', { style: MUTED },
      'Used for PCB GLB export, native artifact opening, and the agent environment context.'),
    createElement('label', { style: FIELD }, 'SolidCraft installation root or executable path',
      createElement('input', { style: INPUT, value: solidcraftRoot, onChange: event => setSolidcraftRoot(event.currentTarget.value) }),
    ),
    createElement('button', { type: 'button', style: BUTTON, onClick: () => { void save('solidcraft', solidcraftRoot) } }, 'Validate / Save SolidCraft'),
    createElement('p', { style: MUTED },
      'SolidCraft is agent environment context only in this POC; it has no native open action.'),
    ...(message === '' ? [] : [createElement('p', { style: MUTED, role: 'status' }, message)]),
  )
}
