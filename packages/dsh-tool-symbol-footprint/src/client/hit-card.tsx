/**
 * The keyed `tool.call.toolview` HIT card for symbol/footprint generation.
 *
 * Faithful React/TS port of the original hq-edge `GenHit` card, adapted to
 * the published DSH slot contract:
 *   - the component receives `ToolCallOwnerProps` + `sessionId` (session-scope
 *     standard kit);
 *   - "confirm"/"cancel"/"regenerate" send a user message back to the agent
 *     through `sessions.binding(sessionId).session.prompt(...)` (single-HIL:
 *     the node `ask()` stays authoritative, the card never invents a result);
 *   - the `needs_auth` phase renders an inline login card (the auth plugin's
 *     client already owns the postMessage handshake + node sync — this card is
 *     display + guidance only);
 *   - previews render from the artifact content via the bundled ecad-renderer.
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { projectToolCall, resultTextOf, fieldLabel, defaultFilenameFor, formatBytes, hashString, type GenResult, type ToolBlockLike } from './parse.js'
import {
  bgaGrid, classifyDimensions, clampDimension, dimensionBounds, dimensionConfirmMessage,
  dimensionDeclineMessage, formatDimension, normalizeDimensions, numVal, parseDimension,
  pickGeometry, pinCountOf, pkgFamilyLabel, rectFromValues, summaryOf, toleranceOf,
  validateDimensions, type DimensionValues,
} from './dims.js'
import { type Translate, useT } from './i18n.js'
import { resolveArtifact, renderArtifactToCanvas, sizeCanvasFor, triggerDownload } from './ecad.js'
import { placeSupportOf, type HqEdgePlaceLike } from './place.js'
import { useLocale, useTheme } from './theme.js'
import { buildLoginUrl, loginIframeBackground } from './login-url.js'
import type { AuthClientLike, AuthStateLike, PromptSender } from './index.js'
import { SvgFootprintEditor } from './svg-footprint-editor.jsx'
import type { FormData } from './config/index.js'

const TOOL_SYMBOL = 'generate_symbol_from_image'
const TOOL_FOOTPRINT_IMAGE = 'generate_footprint_from_image'
const TOOL_FOOTPRINT_DIMS = 'generate_footprint_from_dimensions'

export interface GenHitProps {
  toolName: string
  block?: ToolBlockLike
  sessionId?: string
  inspect?: () => void
  authState?: AuthStateLike
  sendPrompt?: PromptSender
  /**
   * Lazy accessor for the `huaqiuAuth` client service (auth plugin browser
   * half). Absent/undefined in a broken install — the needs_auth card then
   * falls back to the embedded auth.eda.cn iframe.
   */
  getAuth?: () => AuthClientLike | undefined
  /**
   * Lazy accessor for the host's `hqEdge` service (edge-bridge browser half).
   * Absent/undefined in standalone DSH — the Place button is then hidden.
   * Lazy (not captured once) so plugin load order and HQ Edge restarts both
   * resolve correctly at click time.
   */
  getHqEdge?: () => HqEdgePlaceLike | undefined
}

/** Kind inferred from the tool name — used while the call is not settled. */
function kindFromToolName(toolName: string): string | null {
  if (toolName === TOOL_SYMBOL) return 'symbol'
  if (toolName === TOOL_FOOTPRINT_IMAGE || toolName === TOOL_FOOTPRINT_DIMS) return 'footprint'
  return null
}

function kindLabel(kind: string | null, t: Translate): string {
  if (kind === 'symbol') return t('card.kind.symbol')
  if (kind === 'footprint') return t('card.kind.footprint')
  if (kind === 'schematic') return t('card.kind.schematic')
  if (kind === 'pcb') return t('card.kind.pcb')
  return kind || ''
}

function kindTitleKey(kind: string | null): string {
  if (kind === 'symbol') return 'card.title.symbol'
  if (kind === 'footprint') return 'card.title.footprint'
  return 'card.title.generic'
}

// ── header / summary / status ───────────────────────────────────────────────

function StatusDot({ state }: { state: 'ongoing' | 'error' | 'warning' | 'done' }): ReactElement {
  const color = state === 'done' ? 'var(--dsw-alias-state-success-primary, #34a853)'
    : state === 'error' ? 'var(--dsw-alias-state-error-primary, #d93025)'
    : state === 'warning' ? 'var(--dsw-alias-state-warning-primary, #f9ab00)'
    : 'var(--dsw-alias-state-running-primary, #1a73e8)'
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: color }} />
}

function statusDotState(phase: string): 'ongoing' | 'error' | 'warning' | 'done' {
  if (phase === 'generating') return 'ongoing'
  if (phase === 'failed') return 'error'
  if (phase === 'cancelled' || phase === 'needs_confirmation' || phase === 'needs_auth') return 'warning'
  return 'done'
}

function statusText(phase: string, t: Translate): string {
  if (phase === 'generating') return t('card.status.generating')
  if (phase === 'failed') return t('card.status.failed')
  if (phase === 'cancelled') return t('card.status.cancelled')
  if (phase === 'needs_confirmation') return t('card.status.confirm')
  return t('card.status.generated')
}

function genHitHeader(kind: string | null, phase: string, t: Translate): ReactElement {
  return (
    <div className="hq-genhit__header">
      <span className="hq-genhit__icon">⛁</span>
      <span className="hq-genhit__title">{t(kindTitleKey(kind))}</span>
      <span className="hq-genhit__status">
        <StatusDot state={statusDotState(phase)} />
        <span>{statusText(phase, t)}</span>
      </span>
    </div>
  )
}

function genHitSummary(result: GenResult, t: Translate): ReactElement | null {
  const badges: ReactElement[] = []
  if (result.kind) {
    badges.push(<span className="hq-genhit__badge" key="kind">{kindLabel(result.kind, t)}</span>)
  }
  if (result.pkgType) {
    badges.push(<span className="hq-genhit__badge" key="pkg">{t('card.meta.pkg')}: {result.pkgType}</span>)
  }
  if (result.filename) {
    badges.push(<span className="hq-genhit__badge hq-genhit__badge--mono" key="file">{result.filename}</span>)
  }
  const size = result.artifact?.size
  if (size != null) {
    const sizeText = formatBytes(size)
    if (sizeText) badges.push(<span className="hq-genhit__badge" key="size">{sizeText}</span>)
  }
  if (badges.length === 0) return null
  return <div className="hq-genhit__summary">{badges}</div>
}

// ── package silhouette (NextChat rich-footprint idea, lightweight SVG) ──────

/**
 * Draw a recognizable simplified package silhouette for `pkgType` from the
 * edited values: body + leads/balls/epad. Returns SVG element descriptors in
 * the editor viewBox.
 */
function packageSilhouette(
  pkgType: string | null,
  values: DimensionValues,
  geom: { x: number; y: number; w: number; h: number },
): ReactElement[] {
  const type = String(pkgType || '').toLowerCase()
  const bodyX = geom.x
  const bodyY = geom.y
  const bodyW = geom.w
  const bodyH = geom.h
  const padL = Math.max(2, Math.min(7, Math.round(Math.min(bodyW, bodyH) * 0.07)))
  const nodes: ReactElement[] = []
  nodes.push(
    <rect key="body" className="hq-genhit__body" x={bodyX} y={bodyY} width={bodyW} height={bodyH} rx={2} />,
  )
  const pins = pinCountOf(values, 8)
  const perSide = Math.max(2, Math.ceil(pins / 2))

  const side = (edge: 'L' | 'R' | 'T' | 'B'): ReactElement[] => {
    const arr: ReactElement[] = []
    if (edge === 'L' || edge === 'R') {
      const len = Math.min(padL, bodyW * 0.22)
      const x0 = edge === 'L' ? bodyX - len : bodyX + bodyW
      for (let i = 0; i < perSide; i++) {
        const y = bodyY + (i + 0.5) * (bodyH / perSide)
        const ph = Math.max(1.6, (bodyH / perSide) * 0.55)
        arr.push(<rect key={edge + i} className="hq-genhit__pad" x={x0} y={y - ph / 2} width={len} height={ph} rx={1} />)
      }
    } else {
      const len2 = Math.min(padL, bodyH * 0.22)
      const y0 = edge === 'T' ? bodyY - len2 : bodyY + bodyH
      for (let j = 0; j < perSide; j++) {
        const x = bodyX + (j + 0.5) * (bodyW / perSide)
        const pw = Math.max(1.6, (bodyW / perSide) * 0.55)
        arr.push(<rect key={edge + j} className="hq-genhit__pad" x={x - pw / 2} y={y0} width={pw} height={len2} rx={1} />)
      }
    }
    return arr
  }

  if (type === 'bga') {
    const g = bgaGrid(values, Math.max(2, Math.round(Math.sqrt(pins))))
    const ballR = Math.max(0.9, Math.min(bodyW, bodyH) / (Math.max(g.rows, g.cols) * 3.4))
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        nodes.push(
          <circle
            key={`ball${r}_${c}`}
            className="hq-genhit__ball"
            cx={bodyX + (c + 0.5) * (bodyW / g.cols)}
            cy={bodyY + (r + 0.5) * (bodyH / g.rows)}
            r={ballR}
          />,
        )
      }
    }
  } else if (type === 'qfn' || type === 'son') {
    const ep = Math.min(bodyW * 0.55, bodyH * 0.55)
    nodes.push(
      <rect
        key="epad"
        className="hq-genhit__epad"
        x={bodyX + (bodyW - ep) / 2}
        y={bodyY + (bodyH - ep) / 2}
        width={ep}
        height={ep}
        rx={1}
      />,
    )
    const edges = type === 'son' ? (['L', 'R'] as const) : (['L', 'R', 'T', 'B'] as const)
    for (const e of edges) nodes.push(...side(e))
  } else if (type === 'qfp' || type === 'plcc') {
    nodes.push(...side('L'), ...side('R'), ...side('T'), ...side('B'))
  } else {
    nodes.push(...side('L'), ...side('R'))
  }
  return nodes
}

// ── ECAD canvas preview ─────────────────────────────────────────────────────

interface GenHitPreviewProps {
  kind: string | null
  content: string
  srcKey: string | null
  t: Translate
}

function GenHitPreview({ kind, content, srcKey, t }: GenHitPreviewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [view, setView] = useState<{ view: 'loading' | 'ready' | 'error'; message: string }>({ view: 'loading', message: '' })

  useEffect(() => {
    let cancelled = false
    let disposeViewer: (() => void) | null = null
    setView({ view: 'loading', message: '' })
    ;(async () => {
      try {
        const canvas = canvasRef.current
        if (!canvas) return
        // Wait one layout frame so the canvas has its final CSS size.
        await new Promise((resolve) => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve)
          else setTimeout(resolve, 16)
        })
        if (cancelled || canvas !== canvasRef.current) return
        sizeCanvasFor(canvas)
        disposeViewer = await renderArtifactToCanvas(kind ?? 'symbol', content, canvas)
        if (cancelled || canvas !== canvasRef.current) return
        setView({ view: 'ready', message: '' })
      } catch (e) {
        if (!cancelled) {
          console.warn('[hq-genhit] preview render failed', e)
          setView({ view: 'error', message: String((e as Error)?.message || e) })
        }
      }
    })()
    return () => {
      cancelled = true
      try { disposeViewer?.() } catch { /* ignore */ }
    }
  }, [srcKey, kind, content])

  const overlay =
    view.view === 'loading'
      ? <div className="hq-genhit__stage-msg">{t('card.preview.loading')}</div>
      : view.view === 'error'
        ? <div className="hq-genhit__stage-msg hq-genhit__stage-msg--error">{t('card.preview.renderError')}{view.message}</div>
        : null

  return (
    <div className={`hq-genhit__stage hq-genhit__stage--${kind ?? 'symbol'}`}>
      <canvas ref={canvasRef} className="hq-genhit__canvas" />
      {overlay}
    </div>
  )
}

// ── Interactive dimension editor (rich-hit) ─────────────────────────────────

interface HqEdaDimensionEditorProps {
  dimensions: Record<string, unknown>
  pkgType: string | null
  fileName: string | null
  disabled: boolean
  t: Translate
  onConfirm: (values: DimensionValues, edited: Record<string, boolean>) => void
  onCancel: () => void
}

function pointerToViewBox(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  viewW: number,
  viewH: number,
): { x: number; y: number } {
  const rect = svg.getBoundingClientRect()
  const x = rect.width > 0 ? (clientX - rect.left) * (viewW / rect.width) : 0
  const y = rect.height > 0 ? (clientY - rect.top) * (viewH / rect.height) : 0
  return { x, y }
}

const COUNT_KEYS = new Set(['pin_count', 'pins', 'pinCount', 'rows', 'row', 'columns', 'column', 'cols', 'n_max', 'n', 'count', 'total_pins'])

function HqEdaDimensionEditor(props: HqEdaDimensionEditorProps): ReactElement {
  const { dimensions, pkgType, fileName, disabled, t, onConfirm, onCancel } = props
  const normalized = useMemo(() => normalizeDimensions(dimensions), [dimensions])
  const { widthKey, heightKey } = normalized

  const [values, setValues] = useState<DimensionValues>(() => normalized.values)
  const [fieldText, setFieldText] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const k of normalized.numericKeys) m[k] = formatDimension(normalized.values[k])
    return m
  })
  const [invalid, setInvalid] = useState<Record<string, boolean>>({})
  const [edited, setEdited] = useState<Record<string, boolean>>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [drag, setDrag] = useState<{
    mode: 'W' | 'H' | 'WH'
    startX: number
    startY: number
    startW: number
    startH: number
    rectW: number
    rectH: number
  } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const VIEW_W = 360
  const VIEW_H = 230
  const PAD = 34
  const geom = rectFromValues(values, widthKey, heightKey, VIEW_W, VIEW_H, PAD)
  const labelFor = (key: string): string => fieldLabel(key, t)
  const fieldUnit = (key: string): string => (COUNT_KEYS.has(key) ? '' : t('card.editor.unit'))

  const withKey = (obj: Record<string, number>, key: string, value: number): Record<string, number> => {
    const out = { ...obj }
    out[key] = value
    return out
  }
  const withKeyBool = (obj: Record<string, boolean>, key: string, value: boolean): Record<string, boolean> => {
    const out = { ...obj }
    out[key] = value
    return out
  }

  function startDrag(mode: 'W' | 'H' | 'WH') {
    return (ev: React.PointerEvent<SVGElement>): void => {
      if (disabled || !svgRef.current) return
      ev.preventDefault()
      const view = pointerToViewBox(svgRef.current, ev.clientX, ev.clientY, VIEW_W, VIEW_H)
      setDrag({
        mode,
        startX: view.x,
        startY: view.y,
        startW: widthKey && values[widthKey] != null ? values[widthKey] : 1,
        startH: heightKey && values[heightKey] != null ? values[heightKey] : 1,
        rectW: geom.w,
        rectH: geom.h,
      })
      try { svgRef.current.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
    }
  }

  function onPointerMove(ev: React.PointerEvent<SVGSVGElement>): void {
    if (!drag || !svgRef.current) return
    const view = pointerToViewBox(svgRef.current, ev.clientX, ev.clientY, VIEW_W, VIEW_H)
    let next = values
    let nextEdited = edited
    if (drag.mode === 'W' || drag.mode === 'WH') {
      if (widthKey) {
        const bW = dimensionBounds(widthKey)
        const newW = clampDimension(drag.startW + (view.x - drag.startX) * (drag.startW / drag.rectW), bW.min, bW.max)
        next = withKey(next, widthKey, newW)
        nextEdited = withKeyBool(nextEdited, widthKey, true)
      }
    }
    if (drag.mode === 'H' || drag.mode === 'WH') {
      if (heightKey) {
        const bH = dimensionBounds(heightKey)
        const newH = clampDimension(drag.startH + (view.y - drag.startY) * (drag.startH / drag.rectH), bH.min, bH.max)
        next = withKey(next, heightKey, newH)
        nextEdited = withKeyBool(nextEdited, heightKey, true)
      }
    }
    if (next !== values) setValues(next)
    if (nextEdited !== edited) setEdited(nextEdited)
  }

  function endDrag(): void {
    setDrag(null)
  }

  function onFieldChange(key: string, ev: React.ChangeEvent<HTMLInputElement>): void {
    const raw = ev.target.value
    setFieldText((prev) => ({ ...prev, [key]: raw }))
    const n = parseDimension(raw)
    if (n == null) {
      setInvalid((prev) => ({ ...prev, [key]: true }))
      return
    }
    const bounds = dimensionBounds(key)
    setInvalid((prev) => ({ ...prev, [key]: false }))
    setValues((prev) => withKey(prev, key, clampDimension(n, bounds.min, bounds.max)))
    setEdited((prev) => withKeyBool(prev, key, true))
  }

  function onFieldBlur(key: string): void {
    setFieldText((prev) => ({ ...prev, [key]: formatDimension(values[key]) }))
    setInvalid((prev) => ({ ...prev, [key]: false }))
  }

  function focusField(key: string): void {
    if (disabled || typeof document === 'undefined') return
    const el = document.querySelector(`.hq-genhit__field-input[data-field="${key}"]`) as HTMLInputElement | null
    if (el && el.focus) {
      el.focus()
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }

  const hasInvalid = Object.values(invalid).some(Boolean)

  // Dimension lines with arrowheads for W (top) and H (left).
  const topY = geom.y - 16
  const leftX = geom.x - 16
  const wMid = geom.x + geom.w / 2
  const hMid = geom.y + geom.h / 2
  const wLabel = widthKey && values[widthKey] != null ? `${formatDimension(values[widthKey])} ${t('card.editor.unit')}` : ''
  const hLabel = heightKey && values[heightKey] != null ? `${formatDimension(values[heightKey])} ${t('card.editor.unit')}` : ''
  const arrow = (pts: string): ReactElement => <polygon className="hq-genhit__arrow" points={pts} />
  const tolText = (key: string | null): string => {
    const tol = toleranceOf(values, key)
    if (!tol || tol.min == null || tol.max == null || tol.min === tol.max) return ''
    return `${formatDimension(tol.min)}\u2013${formatDimension(tol.max)} ${t('card.editor.unit')}`
  }
  const wTolText = tolText(widthKey)
  const hTolText = tolText(heightKey)

  const groups = classifyDimensions(normalized.numericKeys, widthKey, heightKey)
  const essentialKeys: string[] = []
  if (widthKey) essentialKeys.push(widthKey)
  if (heightKey) essentialKeys.push(heightKey)
  for (const ek of groups.essential) {
    if (ek !== widthKey && ek !== heightKey) essentialKeys.push(ek)
  }
  const advancedKeys = groups.advanced

  const renderField = (key: string): ReactElement => {
    const bounds = dimensionBounds(key)
    return (
      <div
        className={`hq-genhit__field${invalid[key] ? ' hq-genhit__field--invalid' : ''}`}
        key={key}
        title={invalid[key] ? t('card.editor.invalid') : undefined}
      >
        <label
          className={`hq-genhit__field-label${edited[key] ? ' hq-genhit__field-label--edited' : ''}`}
          onClick={() => focusField(key)}
        >
          {labelFor(key)}
        </label>
        {edited[key]
          ? <span className="hq-genhit__field-tag hq-genhit__field-tag--edited">{t('card.editor.edited')}</span>
          : <span className="hq-genhit__field-tag hq-genhit__field-tag--ai">{t('card.editor.ai')}</span>}
        <input
          className="hq-genhit__field-input"
          data-field={key}
          type="number"
          inputMode="decimal"
          min={bounds.min}
          max={bounds.max}
          step={0.1}
          value={fieldText[key] == null ? '' : fieldText[key]}
          disabled={disabled}
          onChange={(ev) => onFieldChange(key, ev)}
          onBlur={() => onFieldBlur(key)}
        />
        <span className="hq-genhit__field-unit">{fieldUnit(key)}</span>
      </div>
    )
  }

  // Validation strip.
  const issues = validateDimensions(values)
  const seen = new Set<string>()
  const uniqueIssues = issues.filter((it) => {
    if (seen.has(it.key)) return false
    seen.add(it.key)
    return true
  })
  const issueTexts = uniqueIssues.map((it) => {
    const codeLabel = it.code === 'min_gt_max' ? t('card.editor.issueMinGtMax')
      : it.code === 'out_of_range' ? t('card.editor.issueOutOfRange')
      : t('card.editor.invalid')
    return `${labelFor(it.key)}: ${codeLabel}`
  })
  const totalIssues = issueTexts.length + (hasInvalid ? 1 : 0)

  const canEditGeometry = !!(widthKey && heightKey)
  const summaryParts = summaryOf(values, widthKey, heightKey, t)

  return (
    <div className="hq-genhit__editor">
      {canEditGeometry
        ? (
          <svg
            ref={svgRef}
            className="hq-genhit__geom"
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <line className="hq-genhit__dimline" x1={geom.x} y1={topY} x2={geom.x + geom.w} y2={topY} />
            {arrow(`${geom.x},${topY} ${geom.x + 7},${topY - 3} ${geom.x + 7},${topY + 3}`)}
            {arrow(`${geom.x + geom.w},${topY} ${geom.x + geom.w - 7},${topY - 3} ${geom.x + geom.w - 7},${topY + 3}`)}
            <text
              className={`hq-genhit__dimlabel${widthKey ? ' hq-genhit__dimlabel--clickable' : ''}`}
              x={wMid}
              y={topY - 8}
              textAnchor="middle"
              onClick={widthKey ? () => focusField(widthKey) : undefined}
            >
              {wLabel}
            </text>
            {wTolText ? <text className="hq-genhit__tol" x={wMid} y={topY + 12} textAnchor="middle">{wTolText}</text> : null}
            <line className="hq-genhit__dimline" x1={leftX} y1={geom.y} x2={leftX} y2={geom.y + geom.h} />
            {arrow(`${leftX},${geom.y} ${leftX - 3},${geom.y + 7} ${leftX + 3},${geom.y + 7}`)}
            {arrow(`${leftX},${geom.y + geom.h} ${leftX - 3},${geom.y + geom.h - 7} ${leftX + 3},${geom.y + geom.h - 7}`)}
            <text
              className={`hq-genhit__dimlabel${heightKey ? ' hq-genhit__dimlabel--clickable' : ''}`}
              x={leftX - 8}
              y={hMid}
              textAnchor="middle"
              transform={`rotate(-90 ${leftX - 8} ${hMid})`}
              onClick={heightKey ? () => focusField(heightKey) : undefined}
            >
              {hLabel}
            </text>
            {hTolText
              ? <text className="hq-genhit__tol" x={leftX + 12} y={hMid} textAnchor="middle" transform={`rotate(-90 ${leftX + 12} ${hMid})`}>{hTolText}</text>
              : null}
            {packageSilhouette(pkgType, values, geom).map((node, ni) => (
              <Fragment key={node.key ?? `sil${ni}`}>{node}</Fragment>
            ))}
            <circle className="hq-genhit__handle" cx={geom.x + geom.w} cy={geom.y + geom.h / 2} r={6} onPointerDown={startDrag('W')} />
            <circle className="hq-genhit__handle hq-genhit__handle--h" cx={geom.x + geom.w / 2} cy={geom.y + geom.h} r={6} onPointerDown={startDrag('H')} />
            <circle className="hq-genhit__handle hq-genhit__handle--wh" cx={geom.x + geom.w} cy={geom.y + geom.h} r={7} onPointerDown={startDrag('WH')} />
          </svg>
        )
        : null}
      {canEditGeometry ? <div className="hq-genhit__drag-hint">{t('card.editor.dragHint')}</div> : null}
      <div className="hq-genhit__pkg">
        {pkgFamilyLabel(pkgType) ? <span className="hq-genhit__badge hq-genhit__badge--pkg">{pkgFamilyLabel(pkgType)}</span> : null}
        <span className="hq-genhit__pkg-meta">{t('card.editor.pins', { count: pinCountOf(values, 0) })}</span>
        {summaryParts.map((part, pi) => (
          <span className="hq-genhit__pkg-meta hq-genhit__pkg-meta--sep" key={`sum${pi}`}>· {part}</span>
        ))}
      </div>
      {essentialKeys.length > 0 ? <div className="hq-genhit__fields">{essentialKeys.map(renderField)}</div> : null}
      {advancedKeys.length > 0
        ? (
          <div className="hq-genhit__adv">
            <button
              type="button"
              className="hq-genhit__adv-toggle"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              aria-expanded={advancedOpen ? 'true' : 'false'}
            >
              {(advancedOpen ? '\u25be ' : '\u25b8 ') + t('card.editor.advanced') + ` (${advancedKeys.length})`}
            </button>
            {advancedOpen ? <div className="hq-genhit__fields hq-genhit__fields--adv">{advancedKeys.map(renderField)}</div> : null}
          </div>
        )
        : null}
      <div className={`hq-genhit__validation${totalIssues > 0 ? ' hq-genhit__validation--warn' : ''}`}>
        {totalIssues > 0
          ? (
            <span>
              {t('card.editor.validationIssue', { n: totalIssues })}
              {issueTexts.length > 0 ? <span className="hq-genhit__validation-detail">{issueTexts[0]}</span> : null}
            </span>
          )
          : <span>{t('card.editor.validationOk')}</span>}
      </div>
      <div className="hq-genhit__actions">
        <button type="button" className="hq-genhit__act" onClick={() => onConfirm(values, edited)} disabled={disabled || hasInvalid}>
          ✓ {t('card.editor.confirm')}
        </button>
        <button type="button" className="hq-genhit__act" onClick={onCancel} disabled={disabled}>
          ✕ {t('card.editor.cancel')}
        </button>
      </div>
    </div>
  )
}

// ── needs_auth login card ───────────────────────────────────────────────────

interface LoginCardProps {
  toolName: string
  authState?: AuthStateLike
  t: Translate
  getAuth?: () => AuthClientLike | undefined
}

function LoginCard({ toolName, authState, t, getAuth }: LoginCardProps): ReactElement {
  const dark = useTheme()
  const locale = useLocale()
  const authClient = getAuth?.()?.auth
  // HQ Edge host mode: EDA owns the credential — login must ask EDA to open
  // its own TriggerLoginDialog (hq-edge POST /api/v1/auth/login), not the
  // auth.eda.cn iframe (a browser-pushed token is ignored by the STRICT host
  // resolver). Standalone DSH keeps the inline iframe.

  // FILL mode (`fill=full`): this card IS the surface, so let the embed paint
  // it edge-to-edge with its own `bg-background`. Without it the embed's
  // `grid-rows-[20px_1fr_20px]` wrapper leaves two transparent strips above
  // and below the form, which read as white gaps in dark theme.
  const src = useMemo(
    () => buildLoginUrl({ lang: locale, theme: dark ? 'dark' : 'light' }),
    [locale, dark],
  )
  // Force a full remount on a theme/locale flip: Chrome keeps the old embed
  // loaded when only `src` changes (the embed is a Next.js page that reads
  // its URL params once on mount), silently ignoring the new `fill`/`theme`.
  const remountKey = `${locale}|${dark ? 'd' : 'l'}`

  const statusLine = (
    <p className="hq-genhit__login-status" style={{ color: authState?.authenticated ? '#1677ff' : '#d4380d' }}>
      {authState?.authenticated
        ? t('card.auth.loggedIn', {
            nickname: authState.nickname ? t('card.nicknameSep', { nickname: authState.nickname }) : '',
          })
        : t('card.auth.loggedOut')}
    </p>
  )

  if (authClient?.isHostMode?.()) {
    return (
      <div className="hq-genhit">
        <div className="hq-genhit__header">
          <span className="hq-genhit__icon">⛁</span>
          <span className="hq-genhit__title">{t('card.auth.title')}</span>
        </div>
        <div className="hq-genhit__login">
          <p className="hq-genhit__login-desc">{t('card.auth.descHost', { tool: toolName })}</p>
          {statusLine}
          <button
            type="button"
            className="hq-genhit__login-btn"
            onClick={() => {
              void authClient?.login?.({ lang: locale, theme: dark ? 'dark' : 'light' })
                .catch(() => { /* login cancelled / dialog failed — card keeps showing the button */ })
            }}
          >
            {t('card.auth.loginBtn')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="hq-genhit">
      <div className="hq-genhit__header">
        <span className="hq-genhit__icon">⛁</span>
        <span className="hq-genhit__title">{t('card.auth.title')}</span>
      </div>
      <div className="hq-genhit__login">
        <p className="hq-genhit__login-desc">{t('card.auth.desc', { tool: toolName })}</p>
        {statusLine}
        <iframe
          key={remountKey}
          src={src}
          title={t('card.auth.title')}
          className="hq-genhit__login-iframe"
          style={{ background: loginIframeBackground(dark) }}
          allow="clipboard-write"
        />
      </div>
    </div>
  )
}

// ── main GenHit card ────────────────────────────────────────────────────────

export const GenHit = memo(function GenHit(props: GenHitProps): ReactElement {
  const t = useT()
  const state = projectToolCall(props.block)

  const result = state.phase === 'completed' || state.phase === 'needs_confirmation'
    ? state.result : null
  const artifactKey = result?.artifact?.id ?? null
  const srcKey = artifactKey || (result?.content ? `inline:${hashString(result.content)}` : null)

  // Completed: resolve artifact → source (async, epoch-guarded).
  const [src, setSrc] = useState<{ phase: 'idle' | 'loading' | 'ready' | 'error' | 'missing'; kind: string | null; content: string | null; filename: string | null; error: string | null }>(
    { phase: 'idle', kind: null, content: null, filename: null, error: null },
  )
  useEffect(() => {
    if (state.phase !== 'completed') return
    if (!srcKey) { setSrc({ phase: 'missing', kind: null, content: null, filename: null, error: null }); return }
    let cancelled = false
    setSrc({ phase: 'loading', kind: null, content: null, filename: null, error: null })
    ;(async () => {
      try {
        if (artifactKey) {
          const art = await resolveArtifact(artifactKey)
          if (cancelled) return
          setSrc({ phase: 'ready', kind: art.type ?? result?.kind ?? null, content: art.content, filename: art.filename, error: null })
        } else if (result?.content) {
          setSrc({ phase: 'ready', kind: result.kind, content: result.content, filename: result.filename, error: null })
        } else {
          setSrc({ phase: 'missing', kind: null, content: null, filename: null, error: null })
        }
      } catch (e) {
        if (!cancelled) {
          console.warn('[hq-genhit] artifact resolve failed', e)
          setSrc({ phase: 'error', kind: null, content: null, filename: null, error: String((e as Error)?.message || e) })
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactKey, srcKey, state.phase])

  const [busy, setBusy] = useState<string | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  // Outcome of the last Place attempt (one-line status under the actions).
  const [placeStatus, setPlaceStatus] = useState<string | null>(null)

  function onDownload(): void {
    if (busy) return
    if (!src || src.phase !== 'ready' || src.content == null) return
    const filename = result?.filename ?? src.filename ?? defaultFilenameFor(src.kind, artifactKey)
    setBusy('download')
    try {
      triggerDownload(filename, src.content)
    } finally {
      setBusy(null)
    }
  }

  function onRegenerate(): void {
    if (busy) return
    setBusy('regenerate')
    const label = kindLabel(result?.kind ?? null, t)
    const prompt = t('card.regeneratePrompt', { kind: label })
    const p = props.sendPrompt
      ? props.sendPrompt(props.sessionId, prompt)
      : Promise.reject(new Error('no prompt sender'))
    p.then(
      () => setBusy(null),
      (err) => {
        console.warn('[hq-genhit] regenerate failed', err)
        setBusy(null)
      },
    )
  }

  /**
   * Place the generated symbol/footprint into the host EDA editor via HQ Edge
   * (`hqEdge.placeArtifact`). The artifact type is the result's own kind —
   * symbols go to sch/symbol editors, footprints to pcb/footprint editors
   * (gated by the shared frontend matrix; HQ Edge re-enforces server-side).
   */
  async function onPlace(): Promise<void> {
    if (busy) return
    const kind = result?.kind
    const uri = result?.artifact?.uri
    const filename = result?.artifact?.filename ?? result?.filename
    if (!kind || !uri) return
    const support = placeSupportOf(props.getHqEdge, kind === 'symbol' ? 'symbol' : 'footprint')?.()
    if (!support) return
    setBusy('place')
    setPlaceStatus(null)
    try {
      await support.place({
        type: kind === 'symbol' ? 'symbol' : 'footprint',
        artifactUri: uri,
        ...(filename ? { filename } : {}),
      })
      setPlaceStatus(t('card.place.done', { count: 1 }))
    } catch (err) {
      const detail = String((err as Error)?.message || err)
      console.warn('[hq-genhit] place failed', detail)
      setPlaceStatus(t('card.place.failed') + detail)
    } finally {
      setBusy(null)
    }
  }

  function onDimsConfirm(values: DimensionValues, edited: Record<string, boolean>): void {
    if (busy) return
    setBusy('confirm')
    const p = props.sendPrompt
      ? props.sendPrompt(props.sessionId, dimensionConfirmMessage(result?.pkgType ?? null, result?.fileName ?? null, values, edited))
      : Promise.reject(new Error('no prompt sender'))
    p.then(
      () => { setBusy(null); setAnswer('confirmed') },
      (err) => {
        console.warn('[hq-genhit] dimension confirm send failed', err)
        setBusy(null)
      },
    )
  }

  /**
   * Adapter: merge FormData → DimensionValues, forwarding the merged
   * dimensions back to the agent via a prompt — same path the old
   * HqEdaDimensionEditor used, but now the form is produced by the
   * NextChat-style SVG-backed editor above.
   */
  function onSvgEditorConfirm(data: FormData): void {
    if (busy) return
    setBusy('confirm')
    const dims: DimensionValues = {}
    const edited: Record<string, boolean> = {}
    for (const k of Object.keys(data)) {
      const raw = data[k]
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        dims[k] = raw
        edited[k] = true
      } else if (typeof raw === 'string') {
        const n = parseDimension(raw)
        if (n != null) { dims[k] = n; edited[k] = true }
      }
    }
    const prompt = dimensionConfirmMessage(result?.pkgType ?? null, result?.fileName ?? null, dims, edited)
    const p = props.sendPrompt
      ? props.sendPrompt(props.sessionId, prompt)
      : Promise.reject(new Error('no prompt sender'))
    p.then(
      () => { setBusy(null); setAnswer('confirmed') },
      (err) => {
        console.warn('[hq-genhit] svg-editor confirm send failed', err)
        setBusy(null)
      },
    )
  }

  /** User clicked "Extract" with a different pkg type — ask the agent to re-run extraction. */
  function onSvgEditorExtract(newPkgType: string): void {
    if (busy) return
    setBusy('extract')
    const prompt = `The user re-picked the package family as "${newPkgType}" and clicked Extract. Call generate_footprint_from_image again with package_type="${newPkgType}" to get a fresh extraction.`
    const p = props.sendPrompt
      ? props.sendPrompt(props.sessionId, prompt)
      : Promise.reject(new Error('no prompt sender'))
    p.then(
      () => setBusy(null),
      (err) => {
        console.warn('[hq-genhit] svg-editor extract send failed', err)
        setBusy(null)
      },
    )
  }

  function onDimsCancel(): void {
    if (busy) return
    setBusy('cancel')
    const p = props.sendPrompt
      ? props.sendPrompt(props.sessionId, dimensionDeclineMessage(result?.pkgType ?? null, result?.fileName ?? null))
      : Promise.reject(new Error('no prompt sender'))
    p.then(
      () => { setBusy(null); setAnswer('declined') },
      (err) => {
        console.warn('[hq-genhit] dimension decline send failed', err)
        setBusy(null)
      },
    )
  }

  // ── needs_auth: inline login card ─────────────────────────────────────────
  if (state.phase === 'needs_auth') {
    return <LoginCard toolName={props.toolName} authState={props.authState} t={t} getAuth={props.getAuth} />
  }

  // ── generating / cancelled ────────────────────────────────────────────────
  const headerKind = result ? result.kind : kindFromToolName(props.toolName)
  if (state.phase === 'generating' || state.phase === 'cancelled') {
    return (
      <div className="hq-genhit">
        {genHitHeader(headerKind, state.phase, t)}
      </div>
    )
  }

  // ── failed ────────────────────────────────────────────────────────────────
  if (state.phase === 'failed') {
    return (
      <div className="hq-genhit">
        {genHitHeader(headerKind, 'failed', t)}
        <div className="hq-genhit__error">{'message' in state ? state.message : t('card.error.toolFailed')}</div>
        <div className="hq-genhit__actions">
          <button type="button" className="hq-genhit__act" onClick={onRegenerate} disabled={busy === 'regenerate'}>
            ↻ {t('card.error.retry')}
          </button>
        </div>
      </div>
    )
  }

  // ── needs_confirmation: dimension editor ──────────────────────────────────
  if (state.phase === 'needs_confirmation' && result) {
    if (answer === 'confirmed') {
      return (
        <div className="hq-genhit">
          {genHitHeader(result.kind, 'completed', t)}
          <div className="hq-genhit__note">{t('card.editor.sent')}</div>
        </div>
      )
    }
    if (answer === 'declined') {
      return (
        <div className="hq-genhit">
          {genHitHeader(result.kind, 'cancelled', t)}
          <div className="hq-genhit__note">{t('card.editor.declined')}</div>
        </div>
      )
    }
    return (
      <div className="hq-genhit">
        {genHitHeader(result.kind, 'needs_confirmation', t)}
        {/* `result.agentNote` is an AGENT-ONLY directive — never render it.
            The human-facing equivalent is this localized hint. */}
        <div className="hq-genhit__note">{t('card.editor.hint')}</div>
        {result.dimensions && typeof result.dimensions === 'object'
          ? (
            <SvgFootprintEditor
              pkgType={result.pkgType}
              dimensions={result.dimensions as FormData}
              canEdit={busy === null}
              t={t}
              onConfirm={onSvgEditorConfirm}
              onExtract={onSvgEditorExtract}
            />
          )
          : null}
      </div>
    )
  }

  // ── completed ─────────────────────────────────────────────────────────────
  if (!result) {
    return <div className="hq-genhit">{genHitHeader(headerKind, 'failed', t)}</div>
  }
  const stageKind = src.phase === 'ready' && src.kind ? src.kind : (result.kind ?? 'symbol')
  let preview: ReactElement
  if (src.phase === 'ready' && src.content != null) {
    preview = <GenHitPreview kind={stageKind} content={src.content} srcKey={srcKey} t={t} />
  } else if (src.phase === 'loading') {
    preview = <div className={`hq-genhit__stage hq-genhit__stage--${stageKind}`}><div className="hq-genhit__stage-msg">{t('card.preview.loading')}</div></div>
  } else if (src.phase === 'error') {
    preview = <div className={`hq-genhit__stage hq-genhit__stage--${stageKind}`}><div className="hq-genhit__stage-msg">{t('card.preview.resolveError')}{src.error}</div></div>
  } else {
    preview = <div className={`hq-genhit__stage hq-genhit__stage--${stageKind}`}><div className="hq-genhit__stage-msg">{t('card.preview.missing')}</div></div>
  }

  const canDownload = src.phase === 'ready' && src.content != null
  // Place is offered only when the host provides hqEdge, the current editor
  // accepts this artifact kind (frontend matrix; HQ Edge re-enforces
  // server-side) and the node half resolved an artifact uri.
  const placeKind = result.kind === 'symbol' ? 'symbol' : 'footprint'
  const canPlace = !!placeSupportOf(props.getHqEdge, placeKind)?.() && !!result.artifact?.uri
  return (
    <div className="hq-genhit">
      {genHitHeader(result.kind, 'completed', t)}
      {genHitSummary(result, t)}
      {preview}
      <div className="hq-genhit__actions">
        <button type="button" className="hq-genhit__act" onClick={onDownload} disabled={!canDownload || busy === 'download'}>
          ⭳ {busy === 'download' ? t('card.action.downloading') : t('card.action.download')}
        </button>
        {canPlace
          ? (
            <button type="button" className="hq-genhit__act" onClick={onPlace} disabled={busy === 'place'}>
              ⇥ {busy === 'place' ? t('card.action.placing') : t('card.action.place')}
            </button>
          )
          : null}
        <button type="button" className="hq-genhit__act" onClick={onRegenerate} disabled={busy === 'regenerate'}>
          ↻ {busy === 'regenerate' ? t('card.action.regenerating') : t('card.action.regenerate')}
        </button>
        {typeof props.inspect === 'function'
          ? <button type="button" className="hq-genhit__act" onClick={() => props.inspect?.()}>{t('card.action.inspect')}</button>
          : null}
      </div>
      {placeStatus ? <div className="hq-genhit__note">{placeStatus}</div> : null}
    </div>
  )
})

// referenced to keep tree-shaking honest (resultTextOf used by tests/edge cases)
export { resultTextOf }
