/**
 * One preview surface per destination. Every asynchronous mount is keyed by the
 * navigation revision and owns an AbortController, so a superseded navigation
 * disposes its predecessor instead of painting over it.
 */
import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isAbortError, mountEcad } from './ecad.js'
import { mountGlb } from './glb.js'
import { loadBom, prepareBoardGlb, type BomProjection } from './transport.js'
import type { HardwareArtifactInfo, HardwareDestination } from './model.js'

const STAGE: CSSProperties = {
  position: 'relative', flex: '1 1 auto', minHeight: 240, overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.3))', borderRadius: 8,
  background: 'var(--dsw-alias-bg-base, #111318)',
}
const MESSAGE: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
  margin: 0, padding: 16, textAlign: 'center', fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
}
const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 }
const TH: CSSProperties = { textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid rgba(127,127,127,0.3)' }
const TD: CSSProperties = { padding: '4px 6px', borderBottom: '1px solid rgba(127,127,127,0.15)', verticalAlign: 'top' }
const SCRIPT: CSSProperties = {
  margin: 0, padding: '8px 10px', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  background: 'color-mix(in srgb, currentColor 6%, transparent)',
}

type Status = 'loading' | 'ready' | 'error'

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function statusLine(status: Status, message?: string): ReactNode {
  return createElement('p', { style: MESSAGE, role: 'status', 'data-hardware-stage': status }, message
    ?? (status === 'loading' ? 'Loading saved artifact…' : ''))
}

function EcadStage({ kind, path, revision }: { kind: 'schematic' | 'pcb'; path: string; revision?: string }): ReactNode {
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
        setMessage(describe(error))
      })
    return () => {
      live = false
      controller.abort()
      mounted?.dispose()
      element.replaceChildren()
    }
  }, [kind, path, revision])

  return createElement(
    'div',
    { style: STAGE, 'data-hardware-ecad': kind },
    ...(status === 'ready' ? [] : [statusLine(status, message)]),
    createElement('div', { key: 'canvas', ref: container, style: { width: '100%', height: '100%' } }),
    ...(status === 'ready' && sourceRevision !== undefined
      ? [createElement('p', {
          key: 'rev', style: { ...MESSAGE, height: 'auto', justifyContent: 'flex-start', padding: '4px 8px' },
        }, `Saved source revision ${sourceRevision.slice(0, 12)}…`)]
      : []),
  )
}

function GlbStage({ boardPath, cwd }: { boardPath: string; cwd?: string }): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [message, setMessage] = useState<string>()
  const [revision, setRevision] = useState<string>()

  useEffect(() => {
    const element = container.current
    if (element === null) return
    const controller = new AbortController()
    let live = true
    let mounted: { dispose(): void } | undefined
    setStatus('loading')
    setMessage(undefined)
    element.replaceChildren()
    const run = async (): Promise<void> => {
      const glb = await prepareBoardGlb(boardPath, cwd, controller.signal)
      if (!live) return
      setRevision(glb.revision)
      mounted = await mountGlb(glb.url, element, { signal: controller.signal })
      if (!live) {
        mounted.dispose()
        return
      }
      setStatus('ready')
    }
    run().catch((error: unknown) => {
      if (!live || isAbortError(error)) return
      setStatus('error')
      setMessage(describe(error))
    })
    return () => {
      live = false
      controller.abort()
      mounted?.dispose()
      element.replaceChildren()
    }
  }, [boardPath, cwd])

  return createElement(
    'div',
    { style: STAGE, 'data-hardware-glb': true },
    ...(status === 'ready' ? [] : [statusLine(status, message)]),
    createElement('div', { key: 'canvas', ref: container, style: { width: '100%', height: '100%' } }),
    ...(status === 'ready' && revision !== undefined
      ? [createElement('p', {
          key: 'rev', style: { ...MESSAGE, height: 'auto', justifyContent: 'flex-start', padding: '4px 8px' },
        }, `Generated from saved board revision ${revision.slice(0, 12)}…`)]
      : []),
  )
}

function BomStage({ schematicPath }: { schematicPath: string }): ReactNode {
  const [status, setStatus] = useState<Status>('loading')
  const [message, setMessage] = useState<string>()
  const [bom, setBom] = useState<BomProjection>()

  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setStatus('loading')
    loadBom(schematicPath, controller.signal)
      .then((projection) => {
        if (!live) return
        setBom(projection)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (!live || isAbortError(error)) return
        setStatus('error')
        setMessage(describe(error))
      })
    return () => { live = false; controller.abort() }
  }, [schematicPath])

  if (status !== 'ready' || bom === undefined) {
    return createElement('div', { style: { ...STAGE, overflow: 'auto' } }, statusLine(status, message))
  }
  return createElement(
    'div',
    { style: { ...STAGE, overflow: 'auto', padding: 8 }, 'data-hardware-bom': true },
    createElement('p', { style: { ...MESSAGE, height: 'auto', padding: '0 0 8px' } },
      `${bom.rows.length} grouped lines from ${bom.path} (revision ${bom.revision.slice(0, 12)}…)`),
    createElement('table', { style: TABLE },
      createElement('thead', {}, createElement('tr', {},
        ...['Refs', 'Qty', 'Value', 'Footprint', 'Notes'].map(label => createElement('th', { key: label, style: TH }, label)))),
      createElement('tbody', {},
        ...bom.rows.map((row, index) => createElement('tr', { key: `${row.references.join(',')}:${String(index)}` },
          createElement('td', { style: TD }, row.references.join(' ')),
          createElement('td', { style: TD }, String(row.quantity)),
          createElement('td', { style: TD }, row.value),
          createElement('td', { style: TD }, row.footprint),
          createElement('td', { style: TD },
            [row.dnp ? 'DNP' : '', ...Object.entries(row.fields).map(([key, value]) => `${key}=${value}`)]
              .filter(Boolean).join(' · ')),
        ))),
    ),
  )
}

/**
 * Order Placing entry points.
 *
 * The UI never constructs a quote/order URL or a second backend: it shows the
 * exact existing agent tool call for the selected board so the purchase path
 * still runs through the tool's own confirmation flow.
 */
function OrderStage({ boardPath, schematicPath }: { boardPath: string; schematicPath?: string }): ReactNode {
  const [lines, setLines] = useState<number>()
  useEffect(() => {
    if (schematicPath === undefined) return
    const controller = new AbortController()
    let live = true
    loadBom(schematicPath, controller.signal)
      .then((bom) => { if (live) setLines(bom.rows.length) })
      .catch(() => { if (live) setLines(undefined) })
    return () => { live = false; controller.abort() }
  }, [schematicPath])

  const calls = [
    { tool: 'quote_pcb', args: { pcbPath: boardPath } },
    { tool: 'place_pcb_order', args: { pcbPath: boardPath } },
    { tool: 'quote_smt', args: { pcbPath: boardPath } },
    { tool: 'place_smt_order', args: { pcbPath: boardPath } },
  ]
  return createElement(
    'div',
    { style: { ...STAGE, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }, 'data-hardware-order': true },
    createElement('p', { style: { ...MESSAGE, height: 'auto', padding: 0, justifyContent: 'flex-start' } },
      `Selected board: ${boardPath}`),
    createElement('p', { style: { ...MESSAGE, height: 'auto', padding: 0, justifyContent: 'flex-start' } },
      lines === undefined ? 'BOM context unavailable.' : `BOM context: ${String(lines)} grouped lines from the selected project.`),
    createElement('p', { style: { ...MESSAGE, height: 'auto', padding: 0, justifyContent: 'flex-start' } },
      'Ask the agent to run one of these existing tool calls. Quoting and ordering keep their own confirmation step; this panel never places an order.'),
    ...calls.map(call => createElement('div', { key: call.tool },
      createElement('p', { style: { margin: '0 0 4px', fontSize: 12, fontWeight: 600 } }, call.tool),
      createElement('pre', { style: SCRIPT }, JSON.stringify(call, null, 2)),
    )),
  )
}

export interface HardwarePreviewProps {
  readonly destination: HardwareDestination
  readonly artifact?: HardwareArtifactInfo
  readonly projectPath?: string
  /** Monotonic navigation revision; a change disposes the previous mount. */
  readonly revision: number
  readonly notice?: string
}

/** Destination → preview dispatcher. */
export function HardwarePreview({ destination, artifact, projectPath, revision }: HardwarePreviewProps): ReactNode {
  if (artifact === undefined) return null
  const key = `${destination}:${artifact.path}:${String(revision)}`
  if (destination === 'schematic' || destination === 'pcb') {
    return createElement(EcadStage, {
      key, kind: destination === 'schematic' ? 'schematic' : 'pcb', path: artifact.path, revision: artifact.revision,
    })
  }
  if (destination === '3d') return createElement(GlbStage, { key, boardPath: artifact.path, cwd: projectPath })
  if (destination === 'bom') return createElement(BomStage, { key, schematicPath: artifact.path })
  return createElement(OrderStage, {
    key, boardPath: artifact.path, ...(projectPath === undefined ? {} : { schematicPath: artifact.sourcePath ?? undefined }),
  })
}
