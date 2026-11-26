/**
 * SVG-backdrop footprint dimension editor — a faithful port of
 * NextChat `app/components/chat/editFootprint/index.tsx`.
 *
 * The editor renders a package-specific SVG silhouette (e.g. qfn.svg,
 * bga.svg), overlays clickable DataPoints positioned by absolute x/y,
 * shows decorative dividers between paired min/max points, and below
 * the diagram renders extraFields (pin counts, package-family re-pick).
 *
 * Interaction is identical to the original: clicking a DataPoint when
 * editing is enabled toggles an inline `<input>`/`<select>`, a side-view
 * SVG is auto-added for non-BGA families, and the Confirm button builds
 * the merged form payload that is forwarded up to the host (GenHit) via
 * onConfirm / onExtract callbacks instead of BINDINGS.process_cmd.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { resolvePkgConfig, type PkgConfig, type FormData, type ExtraField } from './config/index.js'
import { type Translate } from './i18n.js'
import {
  BGA as bgaSvg,
  DIP as dipSvg, DIP_SIDE as dipSideSvg,
  PLCC as plccSvg, PLCC_SIDE as plccSideSvg,
  QFN as qfnSvg, QFN_SIDE as qfnSideSvg,
  QFP as qfpSvg, QFP_SIDE as qfpSideSvg,
  SON as sonSvg, SON_SIDE as sonSideSvg,
  SOP as sopSvg, SOP_SIDE as sopSideSvg,
  SOT23 as sot23Svg, SOT23_SIDE as sot23SideSvg,
} from './svg-assets.js'

interface SvgFootprintEditorProps {
  pkgType: string | null
  /** Backend-provided dimensions (raw props, never mutated locally). */
  dimensions: FormData
  canEdit: boolean
  t: Translate
  /** Host calls this with merged {dimensions ∪ extraFields} when user clicks 生成/确认. */
  onConfirm: (data: FormData) => void
  /** Host calls this when user picks a different pkgType and clicks 提取. */
  onExtract: (newPkgType: string) => void
}

/** Pre-resolved url table — tsdown emits .svg imports as asset URLs. */
const SVG_URL: Record<string, string> = {
  bga: bgaSvg,
  dip: dipSvg, dip_side: dipSideSvg,
  plcc: plccSvg, plcc_side: plccSideSvg,
  qfn: qfnSvg, qfn_side: qfnSideSvg,
  qfp: qfpSvg, qfp_side: qfpSideSvg,
  son: sonSvg, son_side: sonSideSvg,
  sop: sopSvg, sop_side: sopSideSvg,
  sot23: sot23Svg, sot23_side: sot23SideSvg,
}

/** Matches NextChat's lazy-background — loads the per-pkg SVG as a ReactComponent. */
const BackgroundImg = lazy(async (): Promise<{ default: (p: { pkgType: string; isEditing: boolean }) => ReactElement }> => {
  // Wrap a plain <img> into the component shape NextChat uses. tsdown's .svg
  // loader emits asset URLs (strings), so we can't directly re-export as a
  // ReactComponent the way SVGR would. We wrap the URL instead — layout is
  // identical because the `<img>` fills its container with width:100%.
  const Component = ({ pkgType, isEditing }: { pkgType: string; isEditing: boolean }): ReactElement => {
    const src = SVG_URL[pkgType] ?? ''
    return (
      <img
        src={src}
        alt=""
        style={{
          width: '100%',
          height: 'auto',
          display: 'block',
          pointerEvents: isEditing ? 'auto' : 'none',
          userSelect: 'none',
        }}
        draggable={false}
      />
    )
  }
  return { default: Component }
})

export function SvgFootprintEditor(props: SvgFootprintEditorProps): ReactElement {
  const { pkgType, dimensions, canEdit, t, onConfirm, onExtract } = props

  // Use the exact same fallback key NextChat does — "pkgTypeNotFound". If the
  // backend didn't set pkgType at all we land in the same branch via nullish
  // coalescing to the default empty config (DataPointList.length === 0).
  const configKey = pkgType ?? ''
  const config: PkgConfig = useMemo(() => resolvePkgConfig(configKey), [configKey])

  // ── local state (identical to NextChat) ──────────────────────────────────
  const [isEditing, setIsEditing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<FormData>(dimensions)
  const [extraFormData, setExtraFormData] = useState<FormData>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  // ── derived values (identical to NextChat index.tsx) ─────────────────────
  // Pre-computed DataPoints — NextChat pulls value from the raw `dimensions`
  // props here (not formData) because the inline editor re-reads formData
  // live during render.
  const dataPoints = config.DataPointList.map((point) => {
    const dimVal = dimensions[point.id]
    return { ...point, value: dimVal !== undefined ? dimVal : point.value }
  })

  // extraFields memo — matches NextChat's dependency list: ONLY
  // extraFieldsList + dimensions. The select is later rendered from
  // extraFormData so user-changes flow through.
  const extraFields = useMemo<ExtraField[]>(() => {
    const list = config.extraFieldsList
    if (!list || list.length === 0) return []
    return list.map((field) => {
      if (field.name === 'select_pkgType') {
        return { ...field, value: pkgType ?? '' }
      }
      const v = dimensions[field.name]
      return { ...field, value: v !== undefined ? v : field.value }
    })
  }, [config.extraFieldsList, dimensions, pkgType])

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleDataPointClick = useCallback((id: string) => {
    if (!isEditing) return
    setEditingId(id)
  }, [isEditing])

  const handleDataUpdate = useCallback((id: string, value: string, type: string) => {
    setFormData((prev) => ({ ...prev, [id]: type === 'input' ? Number(value) : value }))
  }, [])

  const handleExtraFieldChange = useCallback((name: string, value: string, type: string) => {
    setExtraFormData((prev) => ({ ...prev, [name]: type === 'input' ? Number(value) : value }))
  }, [])

  const handleSubmit = useCallback(async (currentFormData: FormData) => {
    setIsSubmitting(true)
    try {
      const allData: FormData = { ...currentFormData, ...extraFormData }
      delete allData.select_pkgType
      onConfirm(allData)
      setIsEditing(false)
      setEditingId(null)
    } finally {
      setIsSubmitting(false)
    }
  }, [extraFormData, onConfirm])

  const extractSubmit = useCallback(() => {
    const picked = extraFormData.select_pkgType
    if (typeof picked !== 'string' || !picked) return
    onExtract(picked)
    setIsEditing(false)
    setEditingId(null)
  }, [onExtract, extraFormData])

  // ── render helpers ────────────────────────────────────────────────────────

  const renderDataPoint = useCallback((point: typeof config.DataPointList[number]) => {
    const isEditingThis = editingId === point.id
    const value = formData[point.id] ?? point.value
    const color = 'var(--black)'
    if (isEditingThis) {
      return (
        <div key={point.id} style={{ position: 'absolute', left: point.x, top: point.y, zIndex: 10 }}>
          {point.type === 'select' && (
            <select
              value={String(value)}
              onChange={(e) => handleDataUpdate(point.id, e.target.value, 'select')}
              onBlur={() => setEditingId(null)}
              autoFocus
              style={{ padding: 2, borderRadius: 4, border: '1px solid #bbb', fontSize: 13, minWidth: 50 }}
            >
              {point.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )}
          {point.type === 'input' && (
            <input
              type="number"
              value={String(value)}
              onChange={(e) => handleDataUpdate(point.id, e.target.value, 'input')}
              onBlur={() => setEditingId(null)}
              onKeyDown={(e) => e.key === 'Enter' && setEditingId(null)}
              autoFocus
              style={{ borderRadius: 4, border: '1px solid #bbb', fontSize: 12, boxSizing: 'border-box', height: 24, padding: '0px', textAlign: 'left', width: 40, display: 'block', maxWidth: 'initial', minHeight: 'initial' }}
            />
          )}
        </div>
      )
    }
    return (
      <div
        key={point.id}
        onClick={() => handleDataPointClick(point.id)}
        style={{
          position: 'absolute',
          left: point.x,
          top: point.y,
          cursor: isEditing ? 'pointer' : 'default',
          padding: '1px 3px',
          borderRadius: 4,
          background: isEditing ? 'rgba(24,144,255,0.08)' : 'transparent',
          border: isEditing ? '1px dashed #1890ff' : 'none',
          fontSize: 12,
          color,
          zIndex: 5,
          boxSizing: 'content-box',
          minHeight: 18,
          minWidth: 4,
          wordBreak: 'keep-all',
        }}
      >
        {value}
      </div>
    )
  }, [editingId, formData, isEditing, handleDataPointClick, handleDataUpdate])

  const renderDivider = (item: typeof config.dividerList[number], index: number) => {
    const dividerColor = 'var(--black)'
    return item.direction && item.direction === 'horizontal' ? (
      <div
        key={index}
        style={{
          position: 'absolute',
          left: item.x,
          top: item.y,
          boxSizing: 'content-box',
          height: 2,
          width: 8,
          borderTop: `1px solid ${dividerColor}`,
        }}
      />
    ) : (
      <div
        key={index}
        style={{
          position: 'absolute',
          left: item.x,
          top: item.y,
          boxSizing: 'content-box',
          height: 8,
          width: 2,
          borderLeft: `1px solid ${dividerColor}`,
        }}
      />
    )
  }

  const renderExtraFields = useMemo(() => {
    return (
      <div style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 10, paddingTop: '20px' }}>
        {extraFields.map((field) => {
          const displayValue = extraFormData[field.name] ?? field.value
          const isPkgPicker = field.name === 'select_pkgType'
          return (
            <div
              key={field.name}
              style={isPkgPicker
                ? { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }
                : { display: 'flex', alignItems: 'center', gap: 6, minHeight: 24, whiteSpace: 'nowrap' }}
            >
              <label style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>{field.label}</label>
              <div style={isPkgPicker ? { display: 'flex', alignItems: 'center', gap: 6 } : undefined}>
              {field.type !== 'select' && (isEditing
                ? (
                  <input
                    type="number"
                    value={String(displayValue)}
                    onChange={(e) => handleExtraFieldChange(field.name, e.target.value, 'input')}
                    required={field.required}
                    style={{ width: 60, padding: 2, minHeight: 'initial', height: 24, textAlign: 'left', borderRadius: 4, border: '1px solid #bbb', fontSize: 12, maxWidth: 'initial', boxSizing: 'border-box' }}
                  />
                )
                : <span style={{ fontSize: 13 }}>{displayValue}</span>)}
              {field.type === 'select' && (
                <select
                  value={String(displayValue)}
                  onChange={(e) => handleExtraFieldChange(field.name, e.target.value, 'select')}
                  required={field.required}
                  style={{ flex: isPkgPicker ? 1 : '0 0 auto', minWidth: 0, width: isPkgPicker ? undefined : 70, padding: 2, minHeight: 'auto', height: 24, textAlign: 'left', borderRadius: 4, border: '1px solid #bbb', fontSize: 12 }}
                >
                  <option value="">请选择</option>
                  {field.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              )}
              {isPkgPicker && (
                <button
                  onClick={extractSubmit}
                  style={{ flexShrink: 0, padding: '3px 8px', color: '#1890ff', border: '0.5px solid #a9d1ff', background: '#f2f8ff', borderRadius: 4, fontSize: 12, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                >提取</button>
              )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }, [isEditing, extraFormData, extraFields, handleExtraFieldChange, extractSubmit])

  // ── lifecycle stub — NextChat has an empty effect block ────────────────────
  useEffect(() => {
    return
  }, [])

  // ── assemble (identical layout to NextChat) ────────────────────────────────
  const notFound = pkgType === 'pkgTypeNotFound' || config.DataPointList.length === 0

  return (
    <>
      <p style={{ margin: 0, padding: 0, lineHeight: '20px', fontSize: '13px' }}>
        {!notFound
          ? t('card.editor.svgHint')
          : <b style={{ lineHeight: '28px', fontSize: '15px' }}>{t('card.editor.notSupported')}</b>}
      </p>
      {!notFound ? (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', paddingTop: 12 }}>
          <div style={{ zoom: 0.8, flex: '0 0 auto', width: 330, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.15)', borderRadius: 10, background: '#fff', padding: '14px 10px' }}>
            <div style={{ position: 'relative', width: '100%', minHeight: 220 }}>
              <Suspense fallback={<div>Loading...</div>}>
                <BackgroundImg pkgType={configKey} isEditing={isEditing} />
              </Suspense>
              {!['bga'].includes(configKey) && (
                <div style={{ marginTop: 30 }}>
                  <Suspense fallback={<div>Loading...</div>}>
                    <BackgroundImg pkgType={`${configKey}_side`} isEditing={isEditing} />
                  </Suspense>
                </div>
              )}
              {dataPoints.map(renderDataPoint)}
              {config.dividerList.length > 0 && config.dividerList.map(renderDivider)}
            </div>
          </div>
          <div style={{ flex: '1 1 auto', minWidth: 130, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {renderExtraFields}
            {(canEdit || notFound) && !notFound && (
              <div style={{ marginTop: 2, display: 'flex', gap: 8, paddingTop: 8, borderTop: '0.5px solid rgba(127,127,127,0.15)' }}>
                {!isEditing ? (
                  <>
                    <button
                      onClick={() => setIsEditing(true)}
                      style={{ flex: 1, padding: '4px 0', background: '#fff', color: '#333', border: '0.5px solid #d0d0d0', borderRadius: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >编辑</button>
                    <button
                      onClick={() => handleSubmit(formData)}
                      style={{ flex: 1, padding: '4px 0', background: '#1677ff', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >生成</button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => { setIsEditing(false); setEditingId(null); setFormData(dimensions); setExtraFormData({}) }}
                      style={{ flex: 1, padding: '4px 0', background: '#fff', color: '#333', border: '0.5px solid #d0d0d0', borderRadius: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >取消</button>
                    <button
                      onClick={() => handleSubmit(formData)}
                      disabled={isSubmitting}
                      style={{ flex: 1, padding: '4px 0', background: '#1890ff', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, cursor: isSubmitting ? 'not-allowed' : 'pointer', opacity: isSubmitting ? 0.6 : 1, whiteSpace: 'nowrap' }}
                    >{isSubmitting ? '提交中...' : '确认'}</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}
