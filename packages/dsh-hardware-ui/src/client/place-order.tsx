/**
 * The Place Order view: pick a KiCad project, then pick the operation.
 *
 * This is the plugin-owned entry point the desktop menu and the user both reach
 * without an agent message. It does exactly two things — list what the Host
 * discovered in the current workspace, and hand one project to the existing
 * order destination — because the manufacturing work already exists: packaging,
 * validation, the upload, the token and the page are the same code the agent's
 * tools and the order panel use. Nothing here prices, packages or scans on its
 * own; `discover()` is the Host's deterministic scan and every row is rendered
 * from its answer.
 *
 * Readiness is shown, not guessed: PCB needs a saved board, PCBA additionally
 * needs the project schematic the positions and BOM are exported from, and both
 * need a configured KiCad and a signed-in account. An unavailable operation keeps
 * its button visible but disabled with the reason next to it.
 */
import { createElement, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { HardwareArtifactInfo, HardwareProjectInfo, HardwareState } from './model.js'
import { COPY } from './copy.js'
import { messageOf, loadOrderConfig, type OrderConfigInfo } from './transport.js'
import { buttonStyle, C, cardStyle, disabled, dotStyle, MUTED, MONO, pillStyle, R, SECTION_TITLE } from './theme.js'

type UseStore = <S>(selector: (state: HardwareState) => S) => S

export interface PlaceOrderProps {
  readonly useStore?: UseStore
  readonly sessionId?: string
  readonly useSessions?: (selector: (state: {
    readonly ids: readonly string[]
    readonly byId: Readonly<Record<string, { readonly cwd?: string }>>
  }) => string | undefined) => string | undefined
  readonly discover: (cwd?: string, project?: string, session?: string) => Promise<{
    readonly cwd: string
    readonly projects?: readonly HardwareProjectInfo[]
    readonly issue?: { readonly code: string; readonly message: string }
  }>
  readonly installations: () => Promise<{ readonly kicad?: { readonly configured: boolean } }>
  readonly orderProject: (request: {
    readonly projectPath: string
    readonly boardPath: string
    readonly schematicPath?: string
    readonly kind: 'pcb' | 'smt'
  }) => void
}

const ROOT: CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0,
  boxSizing: 'border-box', background: C.base, color: C.text,
}
const HEAD: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  padding: '8px 12px', borderBottom: `1px solid ${C.borderSoft}`, flex: '0 0 auto',
}
const BODY: CSSProperties = {
  flex: '1 1 0', minHeight: 0, overflow: 'auto', padding: 12,
  display: 'flex', flexDirection: 'column', gap: 8,
}
const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
}
const NAME: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: C.text, minWidth: 0 }
const SUB: CSSProperties = { ...MUTED, fontFamily: MONO, fontSize: 10.5, wordBreak: 'break-all' }
const CHIP: CSSProperties = { ...pillStyle('muted'), fontSize: 9.5, padding: '0 5px', whiteSpace: 'nowrap' }
const REASON: CSSProperties = { ...MUTED, fontSize: 10, maxWidth: 190, lineHeight: 1.45 }

/** Boardless-safe artifact summary for one row. */
function artifactsLine(project: HardwareProjectInfo): string {
  const boards = project.boards?.length ?? 0
  const board = boards === 0 ? undefined : (project.defaultBoard ?? project.boards?.[0]?.path)
  const boardName = board === undefined ? undefined : board.slice(Math.max(board.lastIndexOf('\\'), board.lastIndexOf('/')) + 1)
  const schematic = project.schematic?.path
  const schematicName = schematic === undefined ? undefined : schematic.slice(Math.max(schematic.lastIndexOf('\\'), schematic.lastIndexOf('/')) + 1)
  return [
    COPY.order.placeOrder.boardCount(boards),
    boardName ?? COPY.order.placeOrder.noBoard,
    schematicName ?? COPY.order.placeOrder.noSchematic,
  ].join(' · ')
}

/** Path of the project directory relative to the scanned workspace. */
function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/u, '')
  if (!path.startsWith(normalizedRoot)) return path
  return path.slice(normalizedRoot.length).replace(/^[\\/]+/u, '') || '.'
}

export function PlaceOrderBody(props: PlaceOrderProps): ReactNode {
  const { discover, installations, orderProject, sessionId, useSessions } = props
  const cwd = useSessions?.(state => {
    if (sessionId === undefined) return undefined
    return state.byId[sessionId]?.cwd
  })
  const [root, setRoot] = useState<string>()
  const [projects, setProjects] = useState<readonly HardwareProjectInfo[]>()
  const [issue, setIssue] = useState<{ code: string; message: string }>()
  const [error, setError] = useState<string>()
  const [scanning, setScanning] = useState(false)
  const [kicadReady, setKicadReady] = useState<boolean>()
  const [config, setConfig] = useState<OrderConfigInfo>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let live = true
    setScanning(true)
    setError(undefined)
    discover(cwd, undefined, sessionId)
      .then((result) => {
        if (!live) return
        setRoot(result.cwd)
        setProjects(result.projects ?? [])
        setIssue(result.issue)
      })
      .catch((failure: unknown) => {
        if (!live) return
        setProjects([])
        setError(messageOf(failure))
      })
      .finally(() => { if (live) setScanning(false) })
    return () => { live = false }
  }, [cwd, sessionId, discover, revision])

  useEffect(() => {
    let live = true
    installations()
      .then((result) => { if (live) setKicadReady(result.kicad?.configured === true) })
      .catch(() => { if (live) setKicadReady(false) })
    loadOrderConfig()
      .then((value) => { if (live) setConfig(value) })
      .catch(() => { if (live) setConfig(undefined) })
    return () => { live = false }
  }, [installations])

  const signedIn = config?.hasToken
  const scanningNow = scanning

  /** Why one operation is unavailable for this row, in priority order. */
  const blockedReason = (kind: 'pcb' | 'pcba', project: HardwareProjectInfo): string | undefined => {
    if (kind === 'pcb') {
      if ((project.boards?.length ?? 0) === 0) return COPY.order.placeOrder.noBoard
    } else {
      if ((project.boards?.length ?? 0) === 0) return COPY.order.placeOrder.noBoard
      if (project.schematic === undefined) return COPY.order.placeOrder.noSchematic
    }
    if (kicadReady === false) return COPY.order.placeOrder.needsKicad
    if (signedIn === false) return COPY.order.placeOrder.needsSignIn
    return undefined
  }

  const order = (kind: 'pcb' | 'pcba', project: HardwareProjectInfo): void => {
    const boards = project.boards ?? []
    const board: HardwareArtifactInfo | undefined = project.defaultBoard === undefined
      ? boards[0]
      : boards.find(candidate => candidate.path === project.defaultBoard) ?? boards[0]
    if (board === undefined) return
    orderProject({
      projectPath: project.path,
      boardPath: board.path,
      ...(project.schematic === undefined ? {} : { schematicPath: project.schematic.path }),
      kind: kind === 'pcb' ? 'pcb' : 'smt',
    })
  }

  const row = (project: HardwareProjectInfo): ReactNode => {
    const pcbReason = blockedReason('pcb', project)
    const pcbaReason = blockedReason('pcba', project)
    return createElement(
      'div',
      {
        key: project.path,
        style: cardStyle({ gap: 6, padding: 10 }),
        'data-hardware-place-order-project': project.path,
        'data-hardware-place-order-pcb': pcbReason === undefined ? 'ready' : 'blocked',
        'data-hardware-place-order-pcba': pcbaReason === undefined ? 'ready' : 'blocked',
      },
      createElement(
        'div',
        { style: { ...ROW, justifyContent: 'space-between', alignItems: 'flex-start' } },
        createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          createElement('span', { style: NAME }, project.name),
          createElement('span', { style: SUB, title: project.path }, relativePath(root ?? '', project.path)),
        ),
        createElement('span', { style: CHIP }, artifactsLine(project)),
      ),
      createElement(
        'div',
        { style: { ...ROW, alignItems: 'flex-start', flexWrap: 'wrap' } },
        createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          createElement('button', {
            type: 'button',
            style: { ...buttonStyle('primary', { padding: '4px 10px', fontSize: 11 }), ...disabled(pcbReason !== undefined || scanningNow) },
            disabled: pcbReason !== undefined || scanningNow,
            'data-hardware-place-order-action': 'pcb',
            onClick: () => { order('pcb', project) },
          }, COPY.order.placeOrder.pcbAction),
          ...(pcbReason === undefined ? [] : [createElement('span', { key: 'pcb-why', style: REASON }, pcbReason)]),
        ),
        createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          createElement('button', {
            type: 'button',
            style: { ...buttonStyle('secondary', { padding: '4px 10px', fontSize: 11 }), ...disabled(pcbaReason !== undefined || scanningNow) },
            disabled: pcbaReason !== undefined || scanningNow,
            'data-hardware-place-order-action': 'pcba',
            onClick: () => { order('pcba', project) },
          }, COPY.order.placeOrder.pcbaAction),
          ...(pcbaReason === undefined ? [] : [createElement('span', { key: 'pcba-why', style: REASON }, pcbaReason)]),
        ),
      ),
    )
  }

  const header = createElement(
    'div',
    { style: HEAD },
    createElement('span', { style: { ...SECTION_TITLE, marginRight: 2 } }, COPY.order.placeOrder.title),
    createElement(
      'span',
      { style: { fontFamily: MONO, fontSize: 10.5, color: C.text3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 120px' }, title: root ?? '' },
      root ?? COPY.order.placeOrder.workspaceUnknown,
    ),
    createElement(
      'span',
      { style: pillStyle(kicadReady === false ? 'warn' : 'muted'), 'data-hardware-place-order-kicad': kicadReady === false ? 'missing' : kicadReady === true ? 'ok' : 'checking' },
      createElement('span', { style: dotStyle(kicadReady === false ? C.warn : kicadReady === true ? C.ok : C.text3, 6) }),
      kicadReady === false ? COPY.order.placeOrder.needsKicad : kicadReady === true ? COPY.order.placeOrder.kicadReady : COPY.order.placeOrder.checking,
    ),
    createElement(
      'span',
      { style: pillStyle(signedIn === false ? 'warn' : 'muted'), 'data-hardware-place-order-signin': signedIn === false ? 'missing' : signedIn === true ? 'ok' : 'checking' },
      createElement('span', { style: dotStyle(signedIn === false ? C.warn : signedIn === true ? C.ok : C.text3, 6) }),
      signedIn === false ? COPY.order.placeOrder.needsSignIn : signedIn === true ? COPY.order.placeOrder.signInReady : COPY.order.placeOrder.checking,
    ),
    createElement(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle('quiet', { padding: '3px 8px', fontSize: 10.5 }), ...disabled(scanningNow) },
        disabled: scanningNow,
        'data-hardware-place-order-refresh': true,
        onClick: () => { setRevision(value => value + 1) },
      },
      scanningNow ? COPY.order.placeOrder.refreshing : COPY.order.placeOrder.refresh,
    ),
  )

  const body = createElement(
    'div',
    { style: BODY },
    createElement('p', { style: MUTED }, COPY.order.placeOrder.lead),
    ...(error === undefined ? [] : [createElement('p', {
      key: 'error', role: 'status',
      style: { ...MUTED, color: C.warn, borderLeft: `2px solid ${C.warn}`, paddingLeft: 8 },
    }, COPY.order.placeOrder.discoveryFailed(error))]),
    ...(scanningNow && projects === undefined
      ? [createElement('p', { key: 'loading', style: MUTED }, COPY.order.placeOrder.loading)]
      : []),
    ...(projects === undefined || scanningNow || error !== undefined || projects.length > 0
      ? []
      : [createElement(
          'div',
          { key: 'empty', style: cardStyle({ alignItems: 'flex-start', gap: 4 }), 'data-hardware-place-order-empty': issue?.code ?? 'none' },
          createElement('span', { style: pillStyle('warn') }, COPY.order.placeOrder.noProjects),
          createElement('p', { style: MUTED }, COPY.order.placeOrder.noProjectsHint),
        )]),
    ...(projects === undefined ? [] : projects.map(row)),
  )

  return createElement('div', { style: ROOT, 'data-hardware-place-order': true }, header, body)
}
