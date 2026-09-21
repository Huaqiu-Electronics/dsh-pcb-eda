/**
 * `@huaqiu/component-gen-app` — Symbol generation page.
 *
 * Upload an image (required by the symbol-from-image generator) + optional
 * instruction → `runGenerateSymbol` via the component-gen server → live
 * progress → preview + download + history.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ComponentGenConfig, ComponentGenPorts, ReopenRequest } from '../ports.js'
import type { Translate } from '../copy/index.js'
import { UploadInput } from '../components/UploadInput.js'
import { ResultStage } from '../components/ResultStage.js'
import { useAuthGate } from '../hooks/useAuthGate.js'
import { useJobRunner } from '../hooks/useJobRunner.js'
import { symbolPinCount } from '../utils/symbol-pins.js'

export interface SymbolGenPageProps {
  ports: ComponentGenPorts
  t: Translate
  /** reopen a generated history entry into the completed stage. */
  reopen?: ReopenRequest | null
  /** the app calls back to switch tabs (not used on the symbol page). */
  onClose?: () => void
}

export function SymbolGenPage({ ports, t, reopen = null }: SymbolGenPageProps): ReactElement {
  const auth = useAuthGate(ports)
  const runner = useJobRunner(ports)
  const [config, setConfig] = useState<ComponentGenConfig | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [instruction, setInstruction] = useState('')

  // Stable refs so the reopen effect only re-runs when the request changes.
  const runnerRef = useRef(runner)
  runnerRef.current = runner
  const portsRef = useRef(ports)
  portsRef.current = ports

  // Reopen: load the generated artifact into the result stage and restore the
  // source image + instruction so the user can inspect / regenerate.
  useEffect(() => {
    if (!reopen) return
    const { entry } = reopen
    runnerRef.current.loadHistory(entry)
    if (entry.input?.imageId) {
      portsRef.current.inputImage(entry.input.imageId)
        .then((dataUrl) => setImageDataUrl(dataUrl))
        .catch(() => { /* best effort */ })
    }
    if (entry.input?.instruction) setInstruction(entry.input.instruction)
  }, [reopen])

  useEffect(() => {
    ports.config().then(setConfig).catch(() => { /* best effort */ })
  }, [ports])

  // 神策埋点：生成symbol
  useEffect(() => {
    if (runner.phase === 'failed') {
      ports.track?.('generate_symbol', { success: false, err_msg: runner.error })
    }
    if (runner.phase === 'completed' && !runner.jobId?.startsWith('history:')) {
      const artifact = runner.result.artifact as { id?: unknown } | undefined
      if (typeof artifact?.id === 'string') {
        void ports.artifactContent(artifact.id).then((source) => {
          ports.track?.('generate_symbol', { success: true, err_msg: '', pin_count: symbolPinCount(source) })
        })
      }
    }
  }, [runner.phase])

  const maxBytes = config?.limits.imageBytes ?? 4 * 1024 * 1024
  const authed = auth.phase === 'authenticated'
  const canGenerate = authed && !!imageDataUrl && runner.phase !== 'running'

  const generate = (): void => {
    if (!imageDataUrl) return
    void runner.run({
      kind: 'symbol',
      input: { imageDataUrl, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) },
    })
  }

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

          <UploadInput
            maxBytes={maxBytes}
            t={t}
            disabled={!authed || runner.phase === 'running'}
            imageDataUrl={imageDataUrl}
            file={file}
            onFile={(f, url) => { setFile(f); setImageDataUrl(url) }}
          />

          <div className="cga-field">
            <label className="cga-field__label">{t('symbol.instructionPlaceholder')}</label>
            <input
              className="cga-field__input"
              type="text"
              value={instruction}
              disabled={!authed || runner.phase === 'running'}
              onChange={(ev) => setInstruction(ev.target.value)}
            />
          </div>

          <div className="cga-actions">
            <button
              type="button"
              className="cga-btn cga-btn--primary"
              disabled={!canGenerate}
              onClick={generate}
            >
              {runner.phase === 'running' ? t('symbol.progress') : (runner.phase === 'completed' ? t('symbol.regenerate') : t('symbol.generate'))}
            </button>
            {runner.phase === 'running'
              ? <button type="button" className="cga-btn" onClick={() => void runner.cancel()}>{t('editor.cancelLabel')}</button>
              : null}
          </div>

          {runner.phase === 'running' ? <div className="cga-progress"><span className="cga-spinner" />{runner.progress || t('symbol.progress')}</div> : null}
          {runner.phase === 'failed'
            ? (
              <div className="cga-banner cga-banner--error">
                {t('symbol.failed')}: {runner.error}
                {runner.result?.status === 'needs_auth' ? ` (${t('auth.loginRequired')})` : ''}
              </div>
            )
            : null}
        </div>
      </div>

      {runner.phase === 'completed'
        ? <ResultStage ports={ports} kind="symbol" result={runner.result} t={t} srcKey={resultKey} />
        : null}
    </div>
  )
}
