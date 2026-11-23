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

function artifactOptions(artifacts: readonly HardwareArtifactInfo[] | undefined, kind: string): ReactNode[] {
  return (artifacts ?? []).filter(artifact => artifact.kind === kind || kind === 'any')
    .map(artifact => option(artifact.path, artifact.title || artifact.path, false))
}

/** Six persistent destinations in the conversation header's leading seat. */
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

/** Right-panel body: one artifact at a time, with explicit selectors. */
export function HardwareViewerBody({
  useStore, actions, hooks, tab,
}: SlotProps & {
  tab?: { readonly navigation?: { readonly params?: Readonly<Record<string, unknown>>; readonly revision?: number } }
}): ReactNode {
  const active = useStore(state => state.activeDestination)
  const discovery = useStore(state => state.discovery)
  const projectPath = useStore(state => state.projectPath)
  const schematicPath = useStore(state => state.schematicPath)
  const pcbPath = useStore(state => state.pcbPath)
  const mechanicalPath = useStore(state => state.mechanicalPath)
  const notice = useStore(state => state.notice)
  const revision = tab?.navigation?.revision ?? 0
  const selectedProject = discovery?.selected ?? discovery?.projects?.[0]
  const application = applicationFor(active)
  const installed = useStore(state => state.installations)
  const configured = application === 'kicad'
    ? installed?.kicad?.configured ?? false
    : installed?.solidcraft?.configured ?? false

  useEffect(() => { void hooks.refreshDiscovery() }, [revision, hooks])
  useEffect(() => { void hooks.fetchInstallations() }, [hooks])

  const artifactPath = active === '3d' ? mechanicalPath
    : active === 'bom' ? schematicPath
      : active === 'schematic' || active === 'dfm' ? schematicPath
        : active === 'pcb' ? pcbPath : undefined

  return createElement(
    'div',
    { style: ROOT, 'data-hardware-destination': active },
    createElement(
      'div',
      { style: HEADER },
      createElement('h2', { style: TITLE }, DESTINATION_LABELS[active]),
      createElement(
        'button',
        {
          type: 'button', style: BUTTON, disabled: application === undefined || !configured,
          onClick: () => { void hooks.openNative(application, artifactPath).catch(error => actions.setNotice(String(error))) },
        },
        application === 'kicad' ? 'Open in KiCad'
          : application === 'solidcraft' ? 'Open in SolidCraft' : 'No native action',
      ),
    ),
    ...(notice === undefined ? [] : [createElement('p', { key: 'notice', style: MUTED, role: 'status' }, notice)]),
    ...(discovery?.issue === undefined ? [] : [createElement('p', {
      key: 'issue', style: MUTED, role: 'status',
    }, discovery.issue.message)]),
    createElement('p', { style: MUTED }, projectPath === undefined ? 'No canonical KiCad project selected.' : `Project: ${projectPath}`),
    ...(selectedProject === undefined ? [createElement('div', { key: 'empty' },
      createElement('p', { style: MUTED }, 'Open Project · New Project · Ask AI Hardware Engineer'),
    )] : [
      createElement(
        'label',
        { key: 'project', style: FIELD },
        'Project',
        createElement('select', {
          style: SELECT, value: projectPath ?? '',
          onChange: (event: ChangeEvent<HTMLSelectElement>) => { void hooks.refreshDiscovery(undefined, event.currentTarget.value) },
        },
        option('', 'Select a project…', projectPath === undefined),
        ...(discovery?.projects ?? []).map(project => option(project.path, project.name, project.path === projectPath))),
      ),
      ...(active === 'schematic' || active === 'bom' || active === 'dfm' ? [
        createElement('label', { key: 'sheet', style: FIELD }, 'Schematic / sheet',
          createElement('select', {
            style: SELECT, value: schematicPath ?? '',
            onChange: (event: ChangeEvent<HTMLSelectElement>) => { actions.selectArtifact(event.currentTarget.value, 'schematic'); hooks.openDestination(active, event.currentTarget.value) },
          },
          option('', 'Select a schematic…', schematicPath === undefined),
          ...(selectedProject.schematic === undefined ? [] : [option(selectedProject.schematic.path, selectedProject.schematic.title, false)]),
          ...artifactOptions(selectedProject.sheets, 'schematic'))),
      ] : []),
      ...(active === 'pcb' || active === 'dfm' ? [
        createElement('label', { key: 'board', style: FIELD }, 'Board',
          createElement('select', {
            style: SELECT, value: pcbPath ?? '',
            onChange: (event: ChangeEvent<HTMLSelectElement>) => { actions.selectArtifact(event.currentTarget.value, 'pcb'); hooks.openDestination(active, event.currentTarget.value) },
          },
          option('', 'Select a board…', pcbPath === undefined),
          ...artifactOptions(selectedProject.boards, 'pcb'))),
      ] : []),
      ...(active === '3d' ? [
        createElement('label', { key: 'model', style: FIELD }, 'Mechanical model',
          createElement('select', {
            style: SELECT, value: mechanicalPath ?? '',
            onChange: (event: ChangeEvent<HTMLSelectElement>) => { actions.selectArtifact(event.currentTarget.value, 'mechanical-3d'); hooks.openDestination(active, event.currentTarget.value) },
          },
          option('', 'Select a model…', mechanicalPath === undefined),
          ...artifactOptions(selectedProject.mechanical, 'mechanical-3d'))),
      ] : []),
      ...(active === 'order' ? [
        createElement('p', { key: 'order', style: MUTED },
          'PCB Fabrication and PCBA Assembly use the existing quote/order tools. Quote and order are separate steps.'),
      ] : []),
      createElement('p', { key: 'artifact', style: MUTED },
        artifactPath === undefined ? 'No artifact selected for this destination.' : `Selected: ${artifactPath}`),
    ]),
    ...(configured ? [] : [createElement('p', {
      key: 'unconfigured', style: MUTED,
    }, `Configure ${application === 'solidcraft' ? 'SolidCraft' : 'KiCad'} in Settings → Hardware Engineering to enable the native action.`)]),
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
    createElement('label', { style: FIELD }, 'SolidCraft installation root or executable path',
      createElement('input', { style: INPUT, value: solidcraftRoot, onChange: event => setSolidcraftRoot(event.currentTarget.value) }),
    ),
    createElement('button', { type: 'button', style: BUTTON, onClick: () => { void save('solidcraft', solidcraftRoot) } }, 'Validate / Save SolidCraft'),
    ...(message === '' ? [] : [createElement('p', { style: MUTED, role: 'status' }, message)]),
  )
}

/** Compact contextual action in the conversation header corner. */
export function ContextualOpenAction({ useStore, hooks }: SlotProps): ReactNode {
  const active = useStore(state => state.activeDestination)
  const schematicPath = useStore(state => state.schematicPath)
  const pcbPath = useStore(state => state.pcbPath)
  const mechanicalPath = useStore(state => state.mechanicalPath)
  const application = applicationFor(active)
  const installations = useStore(state => state.installations)
  const configured = application === 'kicad'
    ? installed(installations?.kicad?.configured)
    : installed(installations?.solidcraft?.configured)
  const label = useMemo(() => application === 'kicad' ? 'Open in KiCad'
    : application === 'solidcraft' ? 'Open in SolidCraft' : '', [application])
  if (label === '') return null
  const artifactPath = application === 'solidcraft' ? mechanicalPath
    : active === 'pcb' || active === 'dfm' ? pcbPath : schematicPath
  return createElement(
    'button',
    {
      type: 'button', style: BUTTON, disabled: !configured || artifactPath === undefined,
      title: configured ? label : `${label} is unavailable until its installation is configured`,
      onClick: () => { void hooks.openNative(application, artifactPath) },
    },
    label,
  )
}

function installed(value: boolean | undefined): boolean {
  return value ?? false
}
