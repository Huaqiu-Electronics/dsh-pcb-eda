/**
 * Hardware Engineering UI components.
 *
 * Props come from three declared sources and nothing else:
 *   - the slot store seat (`useStore`, `actions`),
 *   - the registrant's inject face (the {@link HardwareController} members,
 *     delivered verbatim — never through a `hooks` compartment),
 *   - the framework standard kit (`sessionId`, `useSessions`, `useTabInfo`).
 *
 * Importing nothing from Node keeps the client bundle loadable by the DSH
 * ModuleLoader; every host read goes through `./transport.ts`.
 */
import {
  createElement, useEffect, useMemo, useState, useSyncExternalStore,
  type ChangeEvent, type CSSProperties, type ReactNode,
} from 'react'
import {
  applicationFor, DESTINATIONS, DESTINATION_LABELS,
  type ConfigFormLike, type HardwareActions, type HardwareArtifactInfo, type HardwareController,
  type HardwareDestination, type HardwareInstallationConfig, type HardwareState,
  type ViewerNavigationParams,
} from './model.js'
import { HardwarePreview } from './preview.js'
import { OnboardingWizard } from './wizard.js'
import {
  buttonStyle, C, cardStyle, disabled, DOT_COLORS, dotStyle, INPUT, MUTED, MONO, MONO_TEXT,
  pillStyle, R, SECTION_TITLE,
} from './theme.js'

type UseStore = <S>(selector: (state: HardwareState) => S) => S

/** Tab information the `sidebar.right.pane.tab` seat supplies as `useTabInfo`. */
export interface TabInfo {
  readonly tab: {
    readonly id: string
    readonly navigation: {
      readonly params?: Readonly<Record<string, unknown>>
      readonly revision?: number
    }
    readonly signal?: AbortSignal
    readonly visible?: boolean
  }
}

export interface SlotProps {
  readonly useStore: UseStore
  readonly actions: HardwareActions
  /** Slot-delivered hook; absent only in non-DSH test harnesses. */
  readonly useTabInfo?: () => TabInfo
  readonly sessionId?: string
  readonly useSessions?: (selector: (state: {
    readonly ids: readonly string[]
    readonly byId: Readonly<Record<string, { readonly cwd?: string }>>
  }) => string | undefined) => string | undefined
  readonly t?: (key: string) => string
}

/** Full component props: slot props plus the controller's verbatim members. */
export type HardwareProps = SlotProps & HardwareController

const EMPTY_TAB: TabInfo = { tab: { id: '', navigation: {} } }
const useEmptyTab = (): TabInfo => EMPTY_TAB

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }

const NAV: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, fontSize: 12,
  position: 'relative', flexWrap: 'nowrap',
}
const NAV_ITEM: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: R.md,
  border: '1px solid transparent', background: 'transparent', color: C.text2,
  cursor: 'pointer', font: 'inherit', fontSize: 11.5, whiteSpace: 'nowrap', flex: '0 0 auto',
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
}
const NAV_ITEM_ACTIVE: CSSProperties = {
  ...NAV_ITEM,
  color: C.text,
  background: C.card,
  border: `1px solid ${C.border}`,
}
const BRAND: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, paddingRight: 8, flex: '0 0 auto',
  borderRight: `1px solid ${C.border}`, marginRight: 3,
}
const BRAND_MARK: CSSProperties = {
  width: 19, height: 19, borderRadius: R.sm, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 9.5, fontWeight: 700, color: '#fff', background: C.accent,
  boxShadow: '0 2px 8px rgba(225,37,27,0.35)',
}
const BRAND_NAME: CSSProperties = { fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap', color: C.text }
const CHIP: CSSProperties = {
  minWidth: 0, maxWidth: 168, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: C.text3, fontSize: 10, fontFamily: MONO, flex: '0 1 auto',
}
const PANEL_ROOT: CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0,
  boxSizing: 'border-box', background: C.base, color: C.text,
}
const STRIP: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
  padding: '5px 8px', background: C.panel, borderBottom: `1px solid ${C.border}`,
  flex: '0 0 auto', minWidth: 0,
}
const STRIP_GROUP: CSSProperties = { ...ROW, gap: 2, flexWrap: 'nowrap', overflowX: 'auto', minWidth: 0 }
const META: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '4px 10px', background: C.base, borderBottom: `1px solid ${C.borderSoft}`,
  flex: '0 0 auto', minWidth: 0, fontSize: 10, color: C.text3,
}
const META_PATH: CSSProperties = {
  ...MONO_TEXT, fontSize: 10, color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  minWidth: 0,
}
const BODY: CSSProperties = { flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', padding: 10, gap: 8 }

function option(value: string, label: string): ReactNode {
  return createElement('option', { key: value, value }, label)
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/u)
  return parts[parts.length - 1] ?? path
}

/** Read the viewer navigation params carried by one `openTab` call. */
export function navigationParams(info: TabInfo | undefined): ViewerNavigationParams | undefined {
  const params = info?.tab.navigation.params
  if (params === undefined || typeof params.destination !== 'string') return undefined
  if (!(DESTINATIONS as readonly string[]).includes(params.destination)) return undefined
  return params as unknown as ViewerNavigationParams
}

/**
 * One product navigation row: brand, the five persistent destinations, and the
 * selected project. The first-run wizard renders from this root-scope seat
 * because it must be able to run before any session exists.
 */
export function EngineeringNav(props: HardwareProps): ReactNode {
  const { useStore, actions, useSessions, discover, openDestination } = props
  const active = useStore(state => state.activeDestination)
  const projectPath = useStore(state => state.projectPath)
  const selected = useStore(state => state.discovery?.selected)
  const cwd = useSessions?.(state => {
    const id = state.ids[0]
    return id === undefined ? undefined : state.byId[id]?.cwd
  })

  useEffect(() => {
    let live = true
    discover(cwd)
      .then((discovery) => { if (live) actions.setDiscovery(discovery) })
      .catch((error: unknown) => { if (live) actions.setNotice(`Artifact discovery failed: ${String(error)}`) })
    return () => { live = false }
  }, [cwd, discover, actions])

  const projectName = selected?.name ?? (projectPath === undefined ? undefined : basename(projectPath))

  return createElement(
    'div',
    { style: NAV, 'data-hardware-nav': true },
    createElement(
      'div',
      { style: BRAND },
      createElement('span', { style: BRAND_MARK }, 'H!'),
      createElement('span', { style: BRAND_NAME }, 'Hardware Engineering'),
    ),
    ...DESTINATIONS.map(destination => createElement(
      'button',
      {
        key: destination, type: 'button',
        style: destination === active ? NAV_ITEM_ACTIVE : NAV_ITEM,
        'aria-pressed': destination === active,
        'data-destination': destination,
        title: DESTINATION_LABELS[destination],
        onClick: () => {
          actions.setActive(destination)
          openDestination(destination)
        },
      },
      createElement('span', { style: dotStyle(DOT_COLORS[destination], 6) }),
      DESTINATION_LABELS[destination],
    )),
    ...(projectName === undefined
      ? []
      : [createElement('span', {
          key: 'project', style: { ...CHIP, paddingLeft: 4 }, title: projectPath ?? projectName,
        }, projectName)]),
    createElement(OnboardingWizard, props),
  )
}

/** The artifact a destination previews, with its canonical identity. */
export function selectedArtifact(state: HardwareState, destination: HardwareDestination): HardwareArtifactInfo | undefined {
  const project = state.discovery?.selected
  const schematic: HardwareArtifactInfo | undefined = state.schematicPath === undefined
    ? project?.schematic
    : { id: `schematic:${state.schematicPath}`, kind: 'schematic', path: state.schematicPath, title: basename(state.schematicPath) }
  const board: HardwareArtifactInfo | undefined = state.pcbPath === undefined
    ? project?.boards?.find(candidate => candidate.path === project?.defaultBoard) ?? project?.boards?.[0]
    : { id: `pcb:${state.pcbPath}`, kind: 'pcb', path: state.pcbPath, title: basename(state.pcbPath) }
  if (destination === 'schematic' || destination === 'bom') return schematic
  return board
}

function missingReason(state: HardwareState, destination: HardwareDestination): string | undefined {
  const discovery = state.discovery
  if (discovery === undefined) return undefined
  if (discovery.issue?.code === 'selection-required' && (discovery.projects?.length ?? 0) > 1) {
    return `${String(discovery.projects?.length)} hardware projects found; choose one explicitly.`
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

/** Native-open affordance for the artifact currently on screen. */
function nativeAction(
  active: HardwareDestination,
  artifact: HardwareArtifactInfo | undefined,
  configured: boolean,
  notice: (message: string) => void,
  openNative: HardwareController['openNative'],
): ReactNode {
  const application = applicationFor(active)
  if (application === undefined) return null
  const canOpen = configured && artifact !== undefined
  return createElement(
    'button',
    {
      type: 'button',
      style: { ...buttonStyle(canOpen ? 'secondary' : 'quiet'), fontSize: 10.5, padding: '2px 7px', ...disabled(!canOpen) },
      disabled: !canOpen,
      'data-hardware-native-open': true,
      title: canOpen
        ? `Open ${artifact.path} in KiCad`
        : configured ? 'Select an artifact first' : 'Configure KiCad in Settings → Hardware Engineering',
      onClick: () => {
        if (artifact === undefined) return
        openNative({
          application,
          artifactPath: artifact.path,
          kind: active === '3d' ? 'pcb-3d' : active === 'bom' ? 'bom' : artifact.kind,
        }).catch((error: unknown) => { notice(String(error)) })
      },
    },
    createElement('span', { style: dotStyle(configured ? C.ok : C.text3, 6) }),
    'Open in KiCad',
  )
}

/** Keyframes the stages reference; rendered once per panel. */
const PANEL_STYLE = `
@keyframes dsh-hw-spin { to { transform: rotate(360deg) } }
`

/**
 * Right-panel body: one destination at a time, driven by the tab's navigation
 * params so a navigation with unchanged params still refreshes (the revision
 * changes), and so the viewer never depends on a remount.
 */
export function HardwareViewerBody(props: HardwareProps): ReactNode {
  const {
    useStore, actions, useTabInfo, sessionId, useSessions, discover, installations,
    openDestination, openNative,
  } = props
  const info = (useTabInfo ?? useEmptyTab)()
  const navigation = info.tab.navigation
  const params = useMemo(() => navigationParams(info), [navigation.params, navigation.revision])
  const navRevision = navigation.revision ?? 0

  const active = useStore(state => state.activeDestination)
  const discovery = useStore(state => state.discovery)
  const projectPath = useStore(state => state.projectPath)
  const schematicPath = useStore(state => state.schematicPath)
  const pcbPath = useStore(state => state.pcbPath)
  const noticeText = useStore(state => state.notice)
  const installed = useStore(state => state.installations)
  const artifact = useStore(state => selectedArtifact(state, active))
  const reason = useStore(state => missingReason(state, active))
  const cwd = useSessions?.(state => {
    if (sessionId === undefined) return undefined
    return state.byId[sessionId]?.cwd
  })

  // Adopt the navigation, then refresh discovery without clobbering it.
  useEffect(() => {
    if (params !== undefined) actions.applyNavigation(params)
  }, [navRevision, params, actions])

  useEffect(() => {
    let live = true
    discover(cwd, params?.projectPath)
      .then((result) => { if (live) actions.setDiscovery(result, params?.path !== undefined) })
      .catch((error: unknown) => { if (live) actions.setNotice(`Artifact discovery failed: ${String(error)}`) })
    return () => { live = false }
  }, [cwd, params?.projectPath, actions, discover])

  useEffect(() => {
    let live = true
    installations()
      .then((result) => { if (live) actions.setInstallations(result) })
      .catch((error: unknown) => { if (live) actions.setNotice(`Installation check failed: ${String(error)}`) })
    return () => { live = false }
  }, [actions, installations])

  const selectedProject = discovery?.selected
  const kicadConfigured = installed?.kicad?.configured ?? false
  const notice = (message: string): void => { actions.setNotice(message) }
  const go = (destination: HardwareDestination): void => {
    actions.setActive(destination)
    openDestination(destination, destination === 'schematic' || destination === 'bom' ? schematicPath : pcbPath)
  }

  const strip = createElement(
    'div',
    { style: STRIP, 'data-hardware-destinations': true },
    createElement(
      'div',
      { style: STRIP_GROUP },
      ...DESTINATIONS.map(destination => createElement(
        'button',
        {
          key: destination, type: 'button',
          style: destination === active ? { ...NAV_ITEM_ACTIVE, fontSize: 11 } : { ...NAV_ITEM, fontSize: 11 },
          'aria-pressed': destination === active,
          onClick: () => { go(destination) },
        },
        createElement('span', { style: dotStyle(DOT_COLORS[destination], 6) }),
        DESTINATION_LABELS[destination],
      )),
    ),
    nativeAction(active, artifact, kicadConfigured, notice, openNative),
  )

  const meta = createElement(
    'div',
    { style: META },
    createElement('span', { style: META_PATH, title: artifact?.path ?? '' },
      artifact === undefined ? 'no artifact selected' : artifact.path),
    createElement(
      'span',
      { style: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
      ...(selectedProject === undefined ? [] : [createElement('span', { key: 'project', style: pillStyle('muted') }, selectedProject.name)]),
      ...(kicadConfigured
        ? [createElement('span', { key: 'kicad', style: pillStyle('ok') }, `KiCad ${installed?.kicad?.version ?? ''}`.trim())]
        : [createElement('span', { key: 'kicad', style: pillStyle('warn'), title: installed?.kicad?.error ?? '' }, 'KiCad missing')]),
    ),
  )

  const selectors: ReactNode[] = []
  const selectStyle: CSSProperties = { ...INPUT, width: 'auto', maxWidth: 220, fontSize: 10.5 }
  if ((discovery?.projects?.length ?? 0) > 1 || discovery?.issue?.code === 'selection-required') {
    selectors.push(createElement(
      'select',
      {
        key: 'project', style: selectStyle, value: projectPath ?? '', 'aria-label': 'Project',
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const path = event.currentTarget.value
          actions.selectProject(path)
          discover(cwd, path)
            .then(result => actions.setDiscovery(result))
            .catch((error: unknown) => actions.setNotice(String(error)))
        },
      },
      option('', 'Select a project…'),
      ...(discovery?.projects ?? []).map(project => option(project.path, project.name)),
    ))
  }
  if ((active === 'schematic' || active === 'bom') && selectedProject !== undefined) {
    const candidates: HardwareArtifactInfo[] = [selectedProject.schematic, ...(selectedProject.sheets ?? [])]
      .filter((candidate): candidate is HardwareArtifactInfo => candidate !== undefined)
    if (candidates.length > 1) {
      selectors.push(createElement(
        'select',
        {
          key: 'sheet', style: selectStyle, value: schematicPath ?? '', 'aria-label': 'Schematic sheet',
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            const path = event.currentTarget.value
            actions.selectArtifact(path, 'schematic')
            openDestination(active, path)
          },
        },
        ...candidates.map(candidate => option(candidate.path, candidate.title)),
      ))
    }
  }
  if ((active === 'pcb' || active === '3d' || active === 'order') && selectedProject !== undefined) {
    if ((selectedProject.boards?.length ?? 0) > 1) {
      selectors.push(createElement(
        'select',
        {
          key: 'board', style: selectStyle, value: pcbPath ?? '', 'aria-label': 'Board',
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            const path = event.currentTarget.value
            actions.selectArtifact(path, 'pcb')
            openDestination(active, path)
          },
        },
        ...(selectedProject.boards ?? []).map(board => option(board.path, board.title || board.path)),
      ))
    }
  }

  const banner = createElement(
    'div',
    { style: { ...ROW, gap: 6, padding: '0 2px', flex: '0 0 auto' } },
    ...selectors,
    ...(noticeText === undefined
      ? []
      : [createElement('span', { key: 'notice', role: 'status', style: { ...MUTED, color: C.warn } }, noticeText)]),
    ...(discovery?.issue === undefined || discovery.issue.code === 'selection-required'
      ? []
      : [createElement('span', { key: 'issue', role: 'status', style: MUTED }, discovery.issue.message)]),
  )

  return createElement(
    'div',
    { style: PANEL_ROOT, 'data-hardware-destination': active },
    createElement('style', null, PANEL_STYLE),
    strip,
    meta,
    selectors.length === 0 && noticeText === undefined && (discovery?.issue === undefined || discovery.issue.code === 'selection-required')
      ? null
      : createElement('div', { style: { padding: '6px 10px 0' } }, banner),
    createElement(
      'div',
      { style: { ...BODY, overflow: active === 'order' || active === 'bom' ? 'auto' : 'hidden' } },
      ...(reason === undefined
        ? [createElement(HardwarePreview, {
            key: `preview:${info.tab.id}:${String(navRevision)}:${active}:${artifact?.path ?? ''}`,
            destination: active,
            artifact,
            schematicPath,
            projectPath,
            revision: navRevision,
            configured: kicadConfigured,
          })]
        : [createElement('div', {
            key: 'reason',
            style: cardStyle({ alignItems: 'center', justifyContent: 'center', flex: '1 1 0', gap: 6 }),
            'data-hardware-state': 'missing',
          },
          createElement('span', { style: pillStyle('warn') }, 'nothing to show'),
          createElement('p', { role: 'status', style: { ...MUTED, textAlign: 'center', maxWidth: 320 } }, reason))]),
    ),
  )
}

/** Settings section: the two CAD installation roots, host-validated. */
export function HardwareSettingsSection(props: HardwareProps): ReactNode {
  const { useStore, actions, configForm, saveInstallation, installations } = props
  const installed = useStore(state => state.installations)
  const form = configForm()
  const empty = useMemo<{ value?: HardwareInstallationConfig }>(() => ({}), [])
  const snapshot = useSyncExternalStore<{ value?: HardwareInstallationConfig }>(
    form === undefined ? () => () => {} : listener => form.subscribe(listener),
    form === undefined ? () => empty : () => form.getSnapshot(),
    form === undefined ? () => empty : () => form.getSnapshot(),
  )
  const [kicadRoot, setKicadRoot] = useState(snapshot.value?.kicadRoot ?? '')
  const [solidcraftRoot, setSolidcraftRoot] = useState(snapshot.value?.solidcraftRoot ?? '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'kicad' | 'solidcraft' | undefined>()

  useEffect(() => { setKicadRoot(snapshot.value?.kicadRoot ?? '') }, [snapshot.value?.kicadRoot])
  useEffect(() => { setSolidcraftRoot(snapshot.value?.solidcraftRoot ?? '') }, [snapshot.value?.solidcraftRoot])

  useEffect(() => {
    let live = true
    installations()
      .then((result) => { if (live) actions.setInstallations(result) })
      .catch(() => { /* the wizard and viewer surface the same failure */ })
    return () => { live = false }
  }, [actions, installations])

  const save = async (application: 'kicad' | 'solidcraft', root: string): Promise<void> => {
    setBusy(application)
    try {
      await saveInstallation(application, root)
      const refreshed = await installations()
      actions.setInstallations(refreshed)
      const state = application === 'kicad' ? refreshed.kicad : refreshed.solidcraft
      setMessage(state?.configured === true
        ? `${application === 'kicad' ? 'KiCad' : 'SolidCraft'} validated and saved.`
        : `${application === 'kicad' ? 'KiCad' : 'SolidCraft'} saved, but validation failed: ${state?.error ?? 'not detected'}`)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(undefined)
    }
  }

  const kicad = installed?.kicad
  const solidcraft = installed?.solidcraft

  const installationCard = (input: {
    key: 'kicad' | 'solidcraft'
    letter: string
    color: string
    title: string
    blurb: string
    value: string
    placeholder: string
    ok: boolean
    status: string
    detail?: string
    onChange: (value: string) => void
  }): ReactNode => createElement(
    'div',
    { key: input.key, style: cardStyle() },
    createElement(
      'div',
      { style: { ...ROW, justifyContent: 'space-between', gap: 8 } },
      createElement(
        'div',
        { style: { ...ROW, gap: 7 } },
        createElement('span', {
          style: {
            width: 22, height: 22, borderRadius: R.sm, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 10, fontWeight: 700, fontFamily: MONO,
            color: input.color, background: `color-mix(in srgb, ${input.color} 18%, transparent)`,
            border: `1px solid color-mix(in srgb, ${input.color} 40%, transparent)`,
          },
        }, input.letter),
        createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, input.title),
      ),
      createElement('span', { style: pillStyle(input.ok ? 'ok' : 'warn') }, input.status),
    ),
    createElement('p', { style: MUTED }, input.blurb),
    createElement('input', {
      style: INPUT, value: input.value, placeholder: input.placeholder, spellCheck: false,
      'aria-label': `${input.title} path`,
      onChange: (event: ChangeEvent<HTMLInputElement>) => input.onChange(event.currentTarget.value),
    }),
    createElement(
      'div',
      { style: { ...ROW, justifyContent: 'space-between' } },
      createElement('button', {
        type: 'button', style: { ...buttonStyle('secondary'), ...disabled(busy !== undefined) },
        disabled: busy !== undefined,
        onClick: () => { void save(input.key, input.value) },
      }, busy === input.key ? 'Validating…' : 'Validate / save'),
      input.detail === undefined
        ? null
        : createElement('span', { style: { ...MUTED, ...MONO_TEXT, fontSize: 10, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, input.detail),
    ),
  )

  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 10 }, 'data-hardware-settings': true },
    createElement('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, 'Hardware Engineering'),
    createElement('p', { style: MUTED },
      'Local EDA and MCAD executables used for previews, fabrication packaging, one-click native open, and the agent environment context.'),
    installationCard({
      key: 'kicad',
      letter: 'Ki',
      color: C.info,
      title: 'KiCad EDA suite',
      blurb: 'Accepts a KiCad installation root or a kicad-cli path. Drives .kicad_sch / .kicad_pcb preview, GLB export, BOM, gerber packaging and native open.',
      value: kicadRoot,
      placeholder: 'C:\\Program Files\\KiCad\\8.0\\  or  /usr/bin/kicad-cli',
      ok: kicad?.configured === true,
      status: kicad?.configured ? `v${kicad.version ?? '?'}` : 'not configured',
      ...(kicad?.cli === undefined ? {} : { detail: kicad.cli }),
      onChange: setKicadRoot,
    }),
    installationCard({
      key: 'solidcraft',
      letter: 'Sc',
      color: C.warn,
      title: 'SolidCraft 3D CAD',
      blurb: 'Agent environment context only in this POC. No native launch and no mechanical preview; the 3D destination renders the selected PCB.',
      value: solidcraftRoot,
      placeholder: 'C:\\Program Files\\SolidCraft\\bin\\SolidCraft.exe',
      ok: solidcraft?.configured === true,
      status: solidcraft?.configured ? 'configured' : 'not configured',
      ...(solidcraft?.executable === undefined ? {} : { detail: solidcraft.executable }),
      onChange: setSolidcraftRoot,
    }),
    ...(message === '' ? [] : [createElement('p', { role: 'status', style: { ...MUTED, color: C.text2 } }, message)]),
  )
}
