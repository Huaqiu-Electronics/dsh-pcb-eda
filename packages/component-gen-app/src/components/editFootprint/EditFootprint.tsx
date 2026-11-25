/**
 * SVG-backdrop footprint dimension editor — port of NextChat
 * `app/components/chat/editFootprint/index.tsx`.
 *
 * Each package family has a background SVG (qfn.svg, bga.svg, …) plus an
 * optional side view; editable values are absolutely-positioned DataPoints on
 * top of it, joined by decorative divider ticks. Clicking a DataPoint while
 * editing swaps it for an inline input/select; extraFields sit below the
 * diagram; Confirm forwards the merged payload.
 */
import { Suspense, lazy, useCallback, useMemo, useState, type ReactElement } from 'react'
import { resolvePkgConfig, type DataPoint, type Divider, type FormData } from './config/index.js'
import type { DimensionValues } from '../../utils/dims.js'
import type { Translate } from '../../copy/index.js'
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

export interface EditFootprintProps {
  /** Package family detected by the extractor (may be "pkgTypeNotFound"). */
  pkgType: string | null
  /** Raw backend dimensions — never mutated locally. */
  dimensions: Record<string, unknown>
  canEdit: boolean
  t: Translate
  onConfirm: (values: DimensionValues, edited: Record<string, boolean>) => void
  onCancel: () => void
  /** Re-run extraction with a different package family (提取 button). */
  onExtract?: (pkgType: string) => void
}

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

/** Lazy background — mirrors NextChat's dynamic import of the per-pkg SVG. */
const BackgroundImg = lazy(async (): Promise<{ default: (p: { pkgType: string; isEditing: boolean }) => ReactElement }> => {
  const Component = ({ pkgType, isEditing }: { pkgType: string; isEditing: boolean }): ReactElement => (
    <img
      src={SVG_URL[pkgType] ?? ''}
      alt=""
      className="cga-eip__bg"
      style={{ pointerEvents: isEditing ? 'auto' : 'none' }}
      draggable={false}
    />
  )
  return { default: Component }
})

/** Coerce raw backend values into the numeric dimension map the runner expects. */
function toDimensionValues(data: FormData): DimensionValues {
  const out: DimensionValues = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === 'select_pkgType') continue
    const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
    if (Number.isFinite(n)) out[key] = n
  }
  return out
}

export function EditFootprint(props: EditFootprintProps): ReactElement {
  const { pkgType, dimensions, canEdit, t, onConfirm, onCancel, onExtract } = props

  const configKey = pkgType ?? ''
  const config = useMemo(() => resolvePkgConfig(configKey), [configKey])

  const initialFormData = useMemo<FormData>(() => {
    const out: FormData = {}
    for (const [key, value] of Object.entries(dimensions)) {
      if (typeof value === 'string' || typeof value === 'number') out[key] = value
    }
    return out
  }, [dimensions])

  const [isEditing, setIsEditing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<FormData>(initialFormData)
  const [extraFormData, setExtraFormData] = useState<FormData>({})
  const [editedKeys, setEditedKeys] = useState<Record<string, boolean>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const dataPoints = config.DataPointList.map((point) => {
    const dimVal = dimensions[point.id]
    return {
      ...point,
      value: typeof dimVal === 'string' || typeof dimVal === 'number' ? dimVal : point.value,
    }
  })

  const extraFields = useMemo(() => {
    const list = config.extraFieldsList
    if (!list || list.length === 0) return []
    return list.map((field) => {
      if (field.name === 'select_pkgType') return { ...field, value: pkgType ?? '' }
      const v = dimensions[field.name]
      return { ...field, value: typeof v === 'string' || typeof v === 'number' ? v : field.value }
    })
  }, [config.extraFieldsList, dimensions, pkgType])

  const handleDataPointClick = useCallback((id: string) => {
    if (!isEditing) return
    setEditingId(id)
  }, [isEditing])

  const handleDataUpdate = useCallback((id: string, value: string, type: string) => {
    setFormData((prev) => ({ ...prev, [id]: type === 'input' ? Number(value) : value }))
    setEditedKeys((prev) => ({ ...prev, [id]: true }))
  }, [])

  const handleExtraFieldChange = useCallback((name: string, value: string, type: string) => {
    setExtraFormData((prev) => ({ ...prev, [name]: type === 'input' ? Number(value) : value }))
  }, [])

  const handleSubmit = useCallback((currentFormData: FormData) => {
    setIsSubmitting(true)
    try {
      const merged: FormData = { ...currentFormData, ...extraFormData }
      delete merged.select_pkgType
      onConfirm(toDimensionValues(merged), editedKeys)
      setIsEditing(false)
      setEditingId(null)
    } finally {
      setIsSubmitting(false)
    }
  }, [editedKeys, extraFormData, onConfirm])

  const handleCancel = useCallback(() => {
    setIsEditing(false)
    setEditingId(null)
    setFormData(initialFormData)
    setExtraFormData({})
    setEditedKeys({})
    onCancel()
  }, [initialFormData, onCancel])

  const extractSubmit = useCallback(() => {
    const picked = extraFormData.select_pkgType
    if (typeof picked !== 'string' || !picked) return
    setIsEditing(false)
    setEditingId(null)
    onExtract?.(picked)
  }, [extraFormData, onExtract])

  const renderDataPoint = (point: DataPoint): ReactElement => {
    const value = formData[point.id] ?? point.value
    if (editingId === point.id) {
      return (
        <div key={point.id} className="cga-eip__editor" style={{ left: point.x, top: point.y }}>
          {point.type === 'select'
            ? (
              <select
                className="cga-eip__select"
                value={String(value)}
                onChange={(ev) => handleDataUpdate(point.id, ev.target.value, 'select')}
                onBlur={() => setEditingId(null)}
                autoFocus
              >
                {point.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            )
            : null}
          {point.type === 'input'
            ? (
              <input
                className="cga-eip__input"
                type="number"
                value={String(value)}
                onChange={(ev) => handleDataUpdate(point.id, ev.target.value, 'input')}
                onBlur={() => setEditingId(null)}
                onKeyDown={(ev) => { if (ev.key === 'Enter') setEditingId(null) }}
                autoFocus
              />
            )
            : null}
        </div>
      )
    }
    return (
      <div
        key={point.id}
        className={isEditing ? 'cga-eip__point cga-eip__point--editable' : 'cga-eip__point'}
        style={{ left: point.x, top: point.y }}
        onClick={() => handleDataPointClick(point.id)}
      >
        {value}
      </div>
    )
  }

  const renderDivider = (item: Divider, index: number): ReactElement => (
    <div
      key={index}
      className={item.direction && item.direction === 'horizontal' ? 'cga-eip__divider-h' : 'cga-eip__divider-v'}
      style={{ left: item.x, top: item.y }}
    />
  )

  const extraFieldsNode = extraFields.length > 0
    ? (
      <div className="cga-eip__fields">
        {extraFields.map((field) => {
          const displayValue = extraFormData[field.name] ?? field.value
          return (
            <div key={field.name} className="cga-eip__field">
              <label className="cga-eip__field-label">{field.label}</label>
              {field.type !== 'select'
                ? (isEditing
                  ? (
                    <input
                      className="cga-eip__field-input"
                      type="number"
                      value={String(displayValue)}
                      onChange={(ev) => handleExtraFieldChange(field.name, ev.target.value, 'input')}
                      required={field.required}
                    />
                  )
                  : <span className="cga-eip__field-value">{String(displayValue)}</span>)
                : null}
              {field.type === 'select'
                ? (
                  <select
                    className="cga-eip__field-select"
                    value={String(displayValue)}
                    onChange={(ev) => handleExtraFieldChange(field.name, ev.target.value, 'select')}
                    required={field.required}
                  >
                    <option value="">{t('editor.selectPlaceholder')}</option>
                    {field.options?.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                )
                : null}
              {field.name === 'select_pkgType'
                ? (
                  <button type="button" className="cga-eip__extract" onClick={extractSubmit}>
                    {t('editor.extractLabel')}
                  </button>
                )
                : null}
            </div>
          )
        })}
      </div>
    )
    : null

  const notFound = configKey === 'pkgTypeNotFound' || config.DataPointList.length === 0

  if (notFound) {
    return (
      <div className="cga-eip">
        <p className="cga-eip__notfound">{t('editor.notSupported')}</p>
      </div>
    )
  }

  return (
    <div className="cga-eip">
      <p className="cga-eip__hint">{t('editor.svgHint')}</p>
      <div className="cga-eip__body">
        <div className="cga-eip__stage">
          <div className="cga-eip__canvas">
            <Suspense fallback={<div className="cga-eip__hint">{t('app.loading')}</div>}>
              <BackgroundImg pkgType={configKey} isEditing={isEditing} />
            </Suspense>
            {!['bga'].includes(configKey)
              ? (
                <div className="cga-eip__side">
                  <Suspense fallback={<div className="cga-eip__hint">{t('app.loading')}</div>}>
                    <BackgroundImg pkgType={`${configKey}_side`} isEditing={isEditing} />
                  </Suspense>
                </div>
              )
              : null}
            {dataPoints.map(renderDataPoint)}
            {config.dividerList.map(renderDivider)}
          </div>
        </div>
        <div className="cga-eip__sidepanel">
          {extraFieldsNode}
          {canEdit
            ? (
              <div className="cga-eip__actions">
                {!isEditing
                  ? (
                    <>
                      <button type="button" className="cga-btn cga-btn--outline" onClick={() => setIsEditing(true)}>
                        {t('editor.editLabel')}
                  </button>
                  <button type="button" className="cga-btn cga-btn--primary" onClick={() => handleSubmit(formData)}>
                    {t('editor.generateLabel')}
                  </button>
                </>
              )
              : (
                <>
                  <button type="button" className="cga-btn cga-btn--outline" onClick={handleCancel}>
                    {t('editor.cancelLabel')}
                  </button>
                  <button
                    type="button"
                    className="cga-btn cga-btn--primary"
                    onClick={() => handleSubmit(formData)}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? t('editor.submittingLabel') : t('editor.confirmLabel')}
                  </button>
                </>
              )}
          </div>
        )
        : null}
        </div>
      </div>
    </div>
  )
}
