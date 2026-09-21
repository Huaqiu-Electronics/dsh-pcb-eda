/**
 * `@huaqiu/component-gen-app` — Footprint generation page.
 *
 * Two workflows, both driven by the app itself (single-HIL):
 *   1. needs_confirmation — extract → dimension editor → confirm →
 *      generate-footprint from the human-approved values.
 *   2. direct generation — extract returns a standard footprint immediately
 *      (fast path) → preview + download.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ComponentGenConfig, ComponentGenPorts, ReopenRequest } from '../ports.js'
import type { Translate } from '../copy/index.js'
import type { DimensionValues } from '../utils/dims.js'
import { UploadInput } from '../components/UploadInput.js'
import { GeometryEditor } from '../components/GeometryEditor.js'
import { ResultStage } from '../components/ResultStage.js'
import { useAuthGate } from '../hooks/useAuthGate.js'
import { useJobRunner } from '../hooks/useJobRunner.js'

export interface FootprintGenPageProps {
  ports: ComponentGenPorts
  t: Translate
  /** reopen a generated history entry into the completed stage. */
  reopen?: ReopenRequest | null
}

export function FootprintGenPage({ ports, t, reopen = null }: FootprintGenPageProps): ReactElement {
  const auth = useAuthGate(ports)
  const runner = useJobRunner(ports)
  const [config, setConfig] = useState<ComponentGenConfig | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [hint, setHint] = useState('')

  // Stable refs so the reopen effect only re-runs when the request changes.
  const runnerRef = useRef(runner)
  runnerRef.current = runner
  const portsRef = useRef(ports)
  portsRef.current = ports

  // Reopen: load the generated artifact into the result stage and restore the
  // source image + package-type hint so the user can inspect / regenerate.
  useEffect(() => {
    if (!reopen) return
    const { entry } = reopen
    runnerRef.current.loadHistory(entry)
    if (entry.input?.imageId) {
      portsRef.current.inputImage(entry.input.imageId)
        .then((dataUrl) => setImageDataUrl(dataUrl))
        .catch(() => { /* best effort */ })
    }
    if (entry.input?.packageType) setHint(entry.input.packageType)
  }, [reopen])

  useEffect(() => {
    ports.config().then(setConfig).catch(() => { /* best effort */ })
  }, [ports])

  const maxBytes = config?.limits.imageBytes ?? 4 * 1024 * 1024
  const authed = auth.phase === 'authenticated'
  const busy = runner.phase === 'running'

  const extract = useCallback((): void => {
    if (!imageDataUrl) return
    void runner.run({
      kind: 'extract-footprint',
      input: {
        imageDataUrl,
        ...(hint.trim() ? { packageType: hint.trim() } : {}),
      },
    })
      .then(() => ports.track?.('generate_footprint', { err_msg: '' }))
      .catch((err) => ports.track?.('generate_footprint', {
        err_msg: String((err as Error)?.message || err),
      }))
  }, [imageDataUrl, hint, runner, ports])

  const confirmDimensions = useCallback((values: DimensionValues, edited: Record<string, boolean>): void => {
    void runner.run({
      kind: 'generate-footprint',
      input: {
        // Re-stamp the source image so the server keeps an authoritative copy
        // and the generated history entry can reopen it (the extract job's
        // entry is not the one shown in history).
        imageDataUrl: imageDataUrl ?? undefined,
        packageType: (runner.pkgType ?? hint.trim()) || undefined,
        fileName: runner.fileName ?? undefined,
        dimensions: values,
        edited,
      },
    })
  }, [runner, hint, imageDataUrl])

  const cancelConfirm = useCallback((): void => {
    runner.clear()
  }, [runner])

  const resultKey = useMemo(() => `${runner.jobId ?? 'none'}:${runner.phase}`, [runner.jobId, runner.phase])

  return (
    <div className="cga-app">
      <div className="cga-panel">
        <div className="cga-panel__body">
          {auth.phase === 'unknown' ? <div className="cga-progress"><span className="cga-spinner" />{t('app.loading')}</div> : null}
          {auth.phase === 'unauthenticated'
            ? (
              <div className="cga-auth">
                <span>{t('auth.loginRequired')}</span>
                <button type="button" className="cga-btn" onClick={auth.login}>{t('auth.login')}</button>
              </div>
            )
            : null}

          {runner.phase !== 'needs_confirmation'
            ? (
              <>
                <UploadInput
                  maxBytes={maxBytes}
                  t={t}
                  disabled={!authed || busy}
                  imageDataUrl={imageDataUrl}
                  file={file}
                  onFile={(f, url) => { setFile(f); setImageDataUrl(url) }}
                />
                <div className="cga-field">
                  <label className="cga-field__label">{t('footprint.hintPlaceholder')}</label>
                  <input
                    className="cga-field__input"
                    type="text"
                    value={hint}
                    disabled={!authed || busy}
                    onChange={(ev) => setHint(ev.target.value)}
                  />
                </div>
                <div className="cga-actions">
                  <button
                    type="button"
                    className="cga-btn cga-btn--primary"
                    disabled={!authed || !imageDataUrl || busy}
                    onClick={extract}
                  >
                    {busy ? t('footprint.extractProgress') : t('footprint.extract')}
                  </button>
                  {busy
                    ? <button type="button" className="cga-btn" onClick={() => void runner.cancel()}>{t('editor.cancelLabel')}</button>
                    : null}
                </div>
              </>
            )
            : null}

          {runner.phase === 'running' && runner.jobId
            ? <div className="cga-progress"><span className="cga-spinner" />{runner.progress || t('footprint.extractProgress')}</div>
            : null}

          {runner.phase === 'needs_confirmation' && runner.dimensions
            ? (
              <>
                <div className="cga-banner cga-banner--info">{t('footprint.needsConfirmation')}</div>
                <GeometryEditor
                  dimensions={runner.dimensions}
                  pkgType={runner.pkgType}
                  fileName={runner.fileName}
                  disabled={false}
                  t={t}
                  onConfirm={confirmDimensions}
                  onCancel={cancelConfirm}
                />
              </>
            )
            : null}

          {runner.phase === 'failed'
            ? (
              <div className="cga-banner cga-banner--error">
                {t('footprint.failed')}: {runner.error}
                {runner.result?.status === 'needs_auth' ? ` (${t('auth.loginRequired')})` : ''}
              </div>
            )
            : null}
        </div>
      </div>

      {runner.phase === 'completed'
        ? <ResultStage ports={ports} kind="footprint" result={runner.result} t={t} srcKey={resultKey} />
        : null}
    </div>
  )
}
