/**
 * One preview surface per destination.
 *
 * Every asynchronous mount is keyed by the navigation revision and owns an
 * AbortController, so a superseded navigation disposes its predecessor instead
 * of painting over it. A load that finishes after the viewer moved on is
 * disposed, never attached.
 */
import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isAbortError, mountEcad } from './ecad.js'
import { mountGlb } from './glb.js'
import { loadBom, messageOf, prepareBoardGlb, type BomProjection } from './transport.js'
import { OrderPanel } from './order.js'
import { COPY } from './copy.js'
import {
  C, cardStyle, dotStyle, MONO, MONO_TEXT, pillStyle, R, SECTION_TITLE,
} from './theme.js'
import type { HardwareArtifactInfo, HardwareDestination } from './model.js'

const STAGE: CSSProperties = {
  position: 'relative', flex: '1 1 0', minHeight: 200, overflow: 'hidden',
  border: `1px solid ${C.border}`, borderRadius: R.lg, background: C.base,
}
const OVERLAY: CSSProperties = {
  position: 'absolute', bottom: 8, left: 8, display: 'flex', alignItems: 'center', gap: 6,
  padding: '2px 8px', borderRadius: R.pill, background: 'rgba(0,0,0,0.55)', color: '#e4e4e7',
  fontSize: 10, fontFamily: MONO, backdropFilter: 'blur(6px)', pointerEvents: 'none',
  maxWidth: 'calc(100% - 16px)', overflow: 'hidden',
}
const TOP_RIGHT: CSSProperties = {
  position: 'absolute', top: 8, right: 8, display: 'flex', alignItems: 'center', gap: 4,
  padding: '1px 3px', pointerEvents: 'none',
}
const CENTER: CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  // `flex` as well as `height`: the BOM stage wraps this in a row box, and a
  // height-only child there shrank to its text instead of filling the stage.
  flex: '1 1 auto', width: '100%', boxSizing: 'border-box',
  height: '100%', gap: 6, padding: 20, textAlign: 'center',
}
const CENTER_TEXT: CSSProperties = { margin: 0, fontSize: 11, color: C.text3, maxWidth: 340, lineHeight: 1.6 }
const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 11 }
const TH: CSSProperties = {
  textAlign: 'left', padding: '5px 8px', position: 'sticky', top: 0, zIndex: 1,
  background: C.raised, color: C.text2, fontWeight: 600, fontSize: 10,
  borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
}
const TD: CSSProperties = {
  padding: '4px 8px', borderBottom: `1px solid ${C.borderSoft}`, verticalAlign: 'top', color: C.text,
}
const SCRIPT: CSSProperties = {
  margin: 0, padding: '6px 8px', borderRadius: R.md, fontSize: 10, whiteSpace: 'pre-wrap',
  wordBreak: 'break-all', background: C.base, fontFamily: MONO, color: C.text2,
}

type Status = 'loading' | 'ready' | 'error'

function shortRevision(revision: string | undefined): string {
  return revision === undefined ? '' : revision.slice(0, 10)
}

/**
 * The stage's placeholder: what is missing, why, and what to do about it.
 *
 * Every variant is one centred column, so an empty schematic, an empty BOM and a
 * failed export sit in the same place. A placeholder never stops at "not
 * available": the last line always says how the artifact can exist — normally by
 * asking the agent to create it.
 */
function statusLine(status: Status, input: {
  /** What the stage is missing, in the user's words ("暂无原理图"). */
  readonly title: string
  readonly message?: string
  /** The technical next step, when there is one (configure KiCad, saved-file preview only). */
  readonly hint?: string
  /** How to obtain the artifact. Omitted when the blocker is a setting, not a missing file. */
  readonly guidance?: string
}): ReactNode {
  const text = input.message ?? (status === 'loading' ? COPY.preview.loading : '')
  return createElement(
    'div',
    { style: CENTER, role: 'status', 'data-hardware-stage': status },
    status === 'loading'
      ? createElement('span', {
          style: {
            width: 18, height: 18, borderRadius: R.pill, border: `2px solid ${C.borderSoft}`,
            borderTopColor: C.info, animation: 'dsh-hw-spin 900ms linear infinite',
          },
        })
      : createElement('span', { style: { ...pillStyle('warn'), fontFamily: MONO } }, input.title),
    text === '' ? null : createElement('p', { style: CENTER_TEXT }, text),
    input.hint === undefined
      ? null
      : createElement('p', { style: { ...CENTER_TEXT, fontSize: 10 } }, input.hint),
    input.guidance === undefined
      ? null
      : createElement('p', {
          style: { ...CENTER_TEXT, fontSize: 10.5, color: C.text2 }, 'data-hardware-guidance': true,
        }, input.guidance),
  )
}

function Stage(props: {
  /** Passed as the third `createElement` argument; React folds it into props. */
  readonly children?: ReactNode
  readonly overlay?: ReactNode
  readonly topRight?: ReactNode
  readonly label: string
  readonly attrs?: Record<string, unknown>
}): ReactNode {
  return createElement(
    'div',
    { style: { ...STAGE, display: 'flex', flexDirection: 'column' }, ...props.attrs },
    props.topRight === undefined ? null : createElement('div', { style: TOP_RIGHT }, props.topRight),
    props.children,
    props.overlay === undefined ? null : createElement('div', { style: OVERLAY }, props.overlay),
  )
}

function EcadStage({ kind, path, revision, session, cwd }: {
  kind: 'schematic' | 'pcb'
  path: string
  revision?: string
  session?: string
  cwd?: string
}): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [message, setMessage] = useState<string>()
  const [sourceRevision, setSourceRevision] = useState<string>()

  useEffect(() => {
    const element = container.current
    if (element === null) return
    const controller = new AbortController()
    let live = true
    let mounted: { dispose(): void } | undefined
    setStatus('loading')
    setMessage(undefined)
    element.replaceChildren()
    mountEcad(kind, path, element, {
      signal: controller.signal,
      ...(revision === undefined ? {} : { revision }),
      ...(session === undefined ? {} : { session }),
      ...(cwd === undefined ? {} : { cwd }),
    })
      .then((result) => {
        if (!live) {
          result.dispose()
          return
        }
        mounted = result
        setSourceRevision(result.sourceRevision)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!live || isAbortError(error)) return
        setStatus('error')
        setMessage(messageOf(error))
      })
    return () => {
      live = false
      controller.abort()
      mounted?.dispose()
      element.replaceChildren()
    }
  }, [kind, path, revision, session, cwd])

  return createElement(
    Stage,
    {
      label: kind,
      attrs: { 'data-hardware-ecad': kind },
      topRight: status === 'ready'
        ? [
            createElement('span', { key: 'kind', style: { ...pillStyle('muted'), fontSize: 9.5 } }, kind === 'schematic' ? COPY.preview.kindSchematic : COPY.preview.kindBoard),
            sourceRevision === undefined
              ? null
              : createElement('span', { key: 'rev', style: { ...pillStyle('muted'), fontSize: 9.5 } }, COPY.preview.revision(shortRevision(sourceRevision))),
          ]
        : undefined,
      overlay: status === 'ready'
        ? [createElement('span', { key: 'dot', style: dotStyle(kind === 'schematic' ? C.info : C.ok, 6) }),
            COPY.preview.ecadOverlay]
        : undefined,
    },
    createElement(
      'div',
      { style: { position: 'relative', flex: '1 1 0', minHeight: 160 } },
      ...(status === 'ready'
        ? []
        : [statusLine(status, {
            title: COPY.placeholder.title[kind],
            ...(message === undefined ? {} : { message }),
            ...(status === 'error'
              ? { hint: COPY.preview.ecadHint, guidance: COPY.placeholder.guide[kind] }
              : {}),
          })]),
      createElement('div', { key: 'canvas', ref: container, style: { position: 'absolute', inset: 0 } }),
    ),
  )
}

function GlbStage({ boardPath, cwd, session, configured }: {
  boardPath: string
  /** Workspace root the host authorizes against; omitted when discovery did not report one. */
  cwd?: string
  session?: string
  configured: boolean
}): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [message, setMessage] = useState<string>()
  const [revision, setRevision] = useState<string>()
  const [cached, setCached] = useState(false)

  useEffect(() => {
    const element = container.current
    if (element === null) return
    if (!configured) {
      setStatus('error')
      setMessage(COPY.preview.kicadNotConfigured)
      return
    }
    const controller = new AbortController()
    let live = true
    let mounted: { dispose(): void } | undefined
    setStatus('loading')
    setMessage(COPY.preview.glbExporting)
    element.replaceChildren()
    const run = async (): Promise<void> => {
      const glb = await prepareBoardGlb(boardPath, cwd, controller.signal, session)
      if (!live) return
      setRevision(glb.revision)
      setCached(glb.cached)
      setMessage(COPY.preview.glbLoading)
      mounted = await mountGlb(glb.url, element, { signal: controller.signal })
      if (!live) {
        mounted.dispose()
        return
      }
      setStatus('ready')
      setMessage(undefined)
    }
    run().catch((error: unknown) => {
      if (!live || isAbortError(error)) return
      setStatus('error')
      setMessage(messageOf(error))
    })
    return () => {
      live = false
      controller.abort()
      mounted?.dispose()
      element.replaceChildren()
    }
  }, [boardPath, cwd, session, configured])

  return createElement(
    Stage,
    {
      label: '3d',
      attrs: { 'data-hardware-glb': true },
      topRight: status === 'ready'
        ? [
            createElement('span', { key: 'mode', style: pillStyle('muted', { fontSize: 9.5 }) }, cached ? COPY.preview.glbCached : COPY.preview.glbGenerated),
            createElement('span', { key: 'rev', style: pillStyle('muted', { fontSize: 9.5 }) }, COPY.preview.revision(shortRevision(revision))),
          ]
        : undefined,
      overlay: status === 'ready' ? COPY.preview.glbOverlay : 'kicad-cli pcb export glb',
    },
    createElement(
      'div',
      { style: { position: 'relative', flex: '1 1 0', minHeight: 160 } },
      ...(status === 'ready'
        ? []
        : [statusLine(status, {
            title: COPY.placeholder.title['3d'],
            ...(message === undefined ? {} : { message }),
            // A missing installation is a setting to fix, not an artifact to
            // create, so the agent guidance would point the wrong way.
            ...(status === 'error' && configured ? { guidance: COPY.placeholder.guide['3d'] } : {}),
          })]),
      createElement('div', { key: 'canvas', ref: container, style: { position: 'absolute', inset: 0 } }),
    ),
  )
}

/**
 * BOM table.
 *
 * Rows come from `kicad-cli sch export bom`, so a missing installation is a
 * configuration state, not a failure: the stage reports it without calling the
 * host, the same way the 3D stage does.
 */
function BomStage({ schematicPath, session, cwd, configured }: {
  schematicPath: string
  session?: string
  cwd?: string
  configured: boolean
}): ReactNode {
  const [status, setStatus] = useState<Status>('loading')
  const [message, setMessage] = useState<string>()
  const [bom, setBom] = useState<BomProjection>()

  useEffect(() => {
    if (!configured) {
      setStatus('error')
      setMessage(COPY.preview.kicadNotConfigured)
      return
    }
    const controller = new AbortController()
    let live = true
    setStatus('loading')
    loadBom(schematicPath, {
      signal: controller.signal,
      ...(session === undefined ? {} : { session }),
      ...(cwd === undefined ? {} : { cwd }),
    })
      .then((projection) => {
        if (!live) return
        setBom(projection)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!live || isAbortError(error)) return
        setStatus('error')
        setMessage(messageOf(error))
      })
    return () => { live = false; controller.abort() }
  }, [schematicPath, session, cwd, configured])

  if (status !== 'ready' || bom === undefined) {
    return createElement(
      Stage,
      { label: 'bom', attrs: { 'data-hardware-bom': true }, overlay: 'kicad-cli sch export bom' },
      // The wrapper is a row box so the placeholder can claim its full width;
      // without that the BOM placeholder sat at the stage's left edge while
      // every other destination centred.
      createElement(
        'div',
        { style: { flex: '1 1 0', minWidth: 0, display: 'flex' } },
        statusLine(status, {
          title: COPY.placeholder.title.bom,
          ...(message === undefined ? {} : { message }),
          ...(status === 'error' && !configured ? { hint: COPY.preview.bomHint } : {}),
          ...(status === 'error' && configured ? { guidance: COPY.placeholder.guide.bom } : {}),
        }),
      ),
    )
  }

  const total = bom.rows.reduce((sum, row) => sum + row.quantity, 0)
  return createElement(
    'div',
    {
      style: cardStyle({ padding: 0, overflow: 'hidden', flex: '1 1 0', minHeight: 0 }),
      'data-hardware-bom': true,
    },
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${C.border}` } },
      createElement('span', { style: SECTION_TITLE }, COPY.preview.bomTitle(bom.rows.length)),
      createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
        createElement('span', { style: pillStyle('muted') }, COPY.preview.bomPlacements(total)),
        createElement('span', { style: pillStyle('muted') }, COPY.preview.revision(shortRevision(bom.revision))),
      ),
    ),
    createElement(
      'div',
      { style: { flex: '1 1 0', minHeight: 0, overflow: 'auto' } },
      createElement(
        'table',
        { style: TABLE },
        createElement('thead', {}, createElement('tr', {},
          ...COPY.preview.bomColumns.map(label =>
            createElement('th', { key: label, style: TH }, label)))),
        createElement('tbody', {},
          ...bom.rows.map((row, index) => createElement('tr', {
            key: `${row.references.join(',')}:${String(index)}`,
            style: index % 2 === 1 ? { background: 'color-mix(in srgb, currentColor 3%, transparent)' } : undefined,
          },
          createElement('td', { style: { ...TD, ...MONO_TEXT, whiteSpace: 'nowrap' } }, row.references.join(' ')),
          createElement('td', { style: { ...TD, ...MONO_TEXT } }, String(row.quantity)),
          createElement('td', { style: TD }, row.value),
          createElement('td', { style: { ...TD, color: C.text2, fontFamily: MONO, fontSize: 10 } }, row.footprint),
          createElement('td', { style: { ...TD, color: C.text3, fontSize: 10 } },
            [row.dnp ? 'DNP' : '', ...Object.entries(row.fields).map(([key, value]) => `${key}=${value}`)]
              .filter(Boolean).join(' · ')),
          ))),
      ),
    ),
  )
}

export interface HardwarePreviewProps {
  readonly destination: HardwareDestination
  readonly artifact?: HardwareArtifactInfo
  /** Selected schematic, used for the BOM/order context. */
  readonly schematicPath?: string
  /** Workspace root of the session on screen; every host read is authorized against it. */
  readonly workspaceRoot?: string
  /** DSH session the panel belongs to; sent with every host read. */
  readonly session?: string
  /** Monotonic navigation revision; a change disposes the previous mount. */
  readonly revision: number
  /** Whether a validated KiCad installation exists. */
  readonly configured?: boolean
}

/** Destination → preview dispatcher. */
export function HardwarePreview({
  destination, artifact, schematicPath, workspaceRoot, session, revision, configured = false,
}: HardwarePreviewProps): ReactNode {
  if (artifact === undefined) return null
  const key = `${destination}:${artifact.path}:${String(revision)}`
  if (destination === 'schematic' || destination === 'pcb') {
    return createElement(EcadStage, {
      key,
      kind: destination === 'schematic' ? 'schematic' : 'pcb',
      path: artifact.path,
      ...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
      ...(session === undefined ? {} : { session }),
      ...(workspaceRoot === undefined ? {} : { cwd: workspaceRoot }),
    })
  }
  if (destination === '3d') {
    return createElement(GlbStage, {
      key, boardPath: artifact.path, ...(workspaceRoot === undefined ? {} : { cwd: workspaceRoot }),
      ...(session === undefined ? {} : { session }), configured,
    })
  }
  if (destination === 'bom') {
    return createElement(BomStage, {
      key,
      schematicPath: artifact.path,
      ...(session === undefined ? {} : { session }),
      ...(workspaceRoot === undefined ? {} : { cwd: workspaceRoot }),
      configured,
    })
  }
  return createElement(OrderPanel, {
    key,
    boardPath: artifact.path,
    boardTitle: artifact.title || artifact.path,
    ...(schematicPath === undefined ? {} : { schematicPath }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    ...(session === undefined ? {} : { session }),
    configured,
  })
}
