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
import { ToolchainCard, useToolchain } from './toolchain-view.js'
import type { ToolchainController } from './toolchain.js'
import { COPY, issueText } from './copy.js'
import { messageOf } from './transport.js'
import {
  buttonStyle, C, cardStyle, disabled, DOT_COLORS, dotStyle, INPUT, MUTED, MONO, MONO_TEXT,
  pillStyle, R,
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
export type HardwareProps = SlotProps & HardwareController & {
  /**
   * The shared toolchain controller (§10.5).
   *
   * Delivered to every seat rather than created per surface: the wizard step,
   * the Settings section, the notice overlay and the sidebar dot all read this
   * one object, so none of them can hold a second, divergent idea of "configured".
   */
  readonly toolchain: ToolchainController
}

const EMPTY_TAB: TabInfo = { tab: { id: '', navigation: {} } }
const useEmptyTab = (): TabInfo => EMPTY_TAB

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }

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
const PANEL_ROOT: CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0,
  boxSizing: 'border-box', background: C.base, color: C.text,
}
/**
 * The panel's top edge.
 *
 * The tab strip that used to sit here is gone: this page's destination switches
 * ARE the panel's header. The right padding is the room the host lays its two
 * panel controls (full screen, collapse) over — both rows are 38px, so the
 * buttons centre on this row's centre line.
 */
const HEADER: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
  // The panel's two controls (fullscreen + collapse) are laid over this row's
  // right end: 28 + 8 + 28px wide, 12px from the column edge — the same inset
  // the conversation header's own button uses. The row reserves that whole
  // gutter, so nothing sits under them.
  height: 38, boxSizing: 'border-box', padding: '0 76px 0 10px',
  background: C.panel, borderBottom: `1px solid ${C.border}`, flex: '0 0 auto', minWidth: 0,
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

/** What an empty viewer says: what is missing, why, and how to get it. */
export interface MissingView {
  /** The destination-shaped absence, in the user's words. */
  readonly title: string
  readonly reason: string
  /** How the artifact can exist. Absent when the fix is a control already on screen. */
  readonly guidance?: string
}

/**
 * Resolve the placeholder for one destination, or `undefined` while there is
 * nothing to say (no discovery yet, or an artifact to render).
 *
 * The guidance points at the agent: this product's hardware is authored in the
 * conversation, so "暂无原理图" alone leaves the user with no next step.
 */
export function missingState(state: HardwareState, destination: HardwareDestination): MissingView | undefined {
  const discovery = state.discovery
  if (discovery === undefined) return undefined
  const title = COPY.placeholder.title[destination]
  if (discovery.issue?.code === 'selection-required' && (discovery.projects?.length ?? 0) > 1) {
    // The project select sits directly above this card; a second instruction
    // would point at a choice the user can already see.
    return { title, reason: COPY.discovery.selectionRequiredCount(discovery.projects?.length ?? 0) }
  }
  if (discovery.selected === undefined) {
    return { title, reason: COPY.discovery.noProjectSelected, guidance: COPY.placeholder.noProject }
  }
  if (destination === 'schematic' || destination === 'bom') {
    if (discovery.selected.schematic === undefined) {
      return { title, reason: COPY.discovery.noSchematic, guidance: COPY.placeholder.guide[destination] }
    }
  }
  if (destination === 'pcb' || destination === '3d') {
    if ((discovery.selected.boards?.length ?? 0) === 0) {
      return { title, reason: COPY.discovery.noBoard, guidance: COPY.placeholder.guide[destination] }
    }
  }
  if (destination === 'order') {
    if ((discovery.selected.boards?.length ?? 0) === 0) {
      return { title, reason: COPY.discovery.noBoardToOrder, guidance: COPY.placeholder.guide.order }
    }
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
        ? COPY.viewer.openInKicadTitle(artifact.path)
        : configured ? COPY.viewer.selectArtifactFirst : COPY.viewer.configureKicad,
      onClick: () => {
        if (artifact === undefined) return
        openNative({
          application,
          artifactPath: artifact.path,
          kind: active === '3d' ? 'pcb-3d' : active === 'bom' ? 'bom' : artifact.kind,
        }).catch((error: unknown) => { notice(messageOf(error)) })
      },
    },
    createElement('span', { style: dotStyle(configured ? C.ok : C.text3, 6) }),
    COPY.viewer.openInKicad,
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
  const missing = useStore(state => missingState(state, active))
  const workspaceRoot = useStore(state => state.workspaceRoot)
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
    discover(cwd, params?.projectPath, sessionId)
      .then((result) => { if (live) actions.setDiscovery(result, params?.path !== undefined) })
      .catch((error: unknown) => { if (live) actions.setNotice(COPY.viewer.discoveryFailed(messageOf(error))) })
    return () => { live = false }
  }, [cwd, sessionId, params?.projectPath, actions, discover])

  useEffect(() => {
    let live = true
    installations()
      .then((result) => { if (live) actions.setInstallations(result) })
      .catch((error: unknown) => { if (live) actions.setNotice(COPY.viewer.installationFailed(messageOf(error))) })
    return () => { live = false }
  }, [actions, installations])

  const selectedProject = discovery?.selected
  const kicadConfigured = installed?.kicad?.configured ?? false
  const notice = (message: string): void => { actions.setNotice(message) }
  const go = (destination: HardwareDestination): void => {
    actions.setActive(destination)
    openDestination(destination, destination === 'schematic' || destination === 'bom' ? schematicPath : pcbPath)
  }

  const header = createElement(
    'div',
    { style: HEADER, 'data-hardware-header': true, 'data-hardware-destinations': true },
    createElement(
      'div',
      { style: STRIP_GROUP },
      ...DESTINATIONS.map(destination => createElement(
        'button',
        {
          key: destination, type: 'button',
          style: destination === active ? { ...NAV_ITEM_ACTIVE, fontSize: 11 } : { ...NAV_ITEM, fontSize: 11 },
          'aria-pressed': destination === active,
          'data-destination': destination,
          title: DESTINATION_LABELS[destination],
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
      artifact === undefined ? COPY.viewer.noArtifact : artifact.path),
    createElement(
      'span',
      { style: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' } },
      ...(selectedProject === undefined ? [] : [createElement('span', { key: 'project', style: pillStyle('muted') }, selectedProject.name)]),
      ...(kicadConfigured
        ? [createElement('span', { key: 'kicad', style: pillStyle('ok') }, COPY.viewer.kicadVersion(installed?.kicad?.version ?? '').trim())]
        : [createElement('span', { key: 'kicad', style: pillStyle('warn'), title: installed?.kicad?.error ?? '' }, COPY.viewer.kicadMissing)]),
    ),
  )

  const selectors: ReactNode[] = []
  const selectStyle: CSSProperties = { ...INPUT, width: 'auto', maxWidth: 220, fontSize: 10.5 }
  if ((discovery?.projects?.length ?? 0) > 1 || discovery?.issue?.code === 'selection-required') {
    selectors.push(createElement(
      'select',
      {
        key: 'project', style: selectStyle, value: projectPath ?? '', 'aria-label': COPY.viewer.projectField,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const path = event.currentTarget.value
          actions.selectProject(path)
          discover(cwd, path, sessionId)
            .then(result => actions.setDiscovery(result))
            .catch((error: unknown) => actions.setNotice(messageOf(error)))
        },
      },
      option('', COPY.viewer.selectProject),
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
          key: 'sheet', style: selectStyle, value: schematicPath ?? '', 'aria-label': COPY.viewer.schematicSheetField,
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
          key: 'board', style: selectStyle, value: pcbPath ?? '', 'aria-label': COPY.viewer.boardField,
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
      : [createElement('span', { key: 'issue', role: 'status', style: MUTED },
          issueText(discovery.issue, {
            ...(discovery.cwd === undefined ? {} : { cwd: discovery.cwd }),
            ...(discovery.projects === undefined ? {} : { count: discovery.projects.length }),
          }))]),
  )

  return createElement(
    'div',
    { style: PANEL_ROOT, 'data-hardware-destination': active },
    createElement('style', null, PANEL_STYLE),
    header,
    meta,
    selectors.length === 0 && noticeText === undefined && (discovery?.issue === undefined || discovery.issue.code === 'selection-required')
      ? null
      : createElement('div', { style: { padding: '6px 10px 0' } }, banner),
    createElement(
      'div',
      { style: { ...BODY, overflow: active === 'order' || active === 'bom' ? 'auto' : 'hidden' } },
      ...(missing === undefined
        ? [createElement(HardwarePreview, {
            key: `preview:${info.tab.id}:${String(navRevision)}:${active}:${artifact?.path ?? ''}`,
            destination: active,
            artifact,
            ...(schematicPath === undefined ? {} : { schematicPath }),
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
            ...(sessionId === undefined ? {} : { session: sessionId }),
            revision: navRevision,
            configured: kicadConfigured,
          })]
        : [createElement('div', {
            key: 'missing',
            style: cardStyle({ alignItems: 'center', justifyContent: 'center', flex: '1 1 0', gap: 6, padding: 20 }),
            'data-hardware-state': 'missing',
          },
          createElement('span', { style: pillStyle('warn') }, missing.title),
          createElement('p', {
            role: 'status',
            style: { ...MUTED, fontSize: 11.5, textAlign: 'center', maxWidth: 320 },
          }, missing.reason),
          ...(missing.guidance === undefined
            ? []
            : [createElement('p', {
                key: 'guidance',
                'data-hardware-guidance': true,
                style: { ...MUTED, color: C.text2, fontSize: 10.5, lineHeight: 1.6, textAlign: 'center', maxWidth: 360 },
              }, missing.guidance)]))]),
    ),
  )
}

/** Settings section: the two toolchain cards, read from the shared controller. */
export function HardwareSettingsSection(props: HardwareProps): ReactNode {
  const { toolchain } = props
  const snapshot = useToolchain(toolchain)
  useEffect(() => { toolchain.start() }, [toolchain])
  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 14 }, 'data-hardware-settings': true },
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
      createElement('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: C.text } }, COPY.settings.title),
      createElement('p', { style: { ...MUTED, margin: 0, lineHeight: 1.6 } }, COPY.settings.lead),
    ),
    createElement(ToolchainCard, { tool: 'kicad', controller: toolchain, snapshot, variant: 'settings' }),
    createElement(ToolchainCard, { tool: 'solidcraft', controller: toolchain, snapshot, variant: 'settings' }),
    ...(snapshot.error === undefined ? [] : [
      createElement('p', { key: 'error', role: 'status', style: { ...MUTED, color: C.accent } }, snapshot.error),
    ]),
  )
}
