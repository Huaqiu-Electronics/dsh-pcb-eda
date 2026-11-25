/**
 * Document body for `.step` and `.stp`.
 *
 * Bytes in, picture out. The source model is never written back and no derived
 * artefact is produced, so there is no cache to invalidate: a changed file
 * arrives as a new byte array, which re-runs this effect and replaces the model.
 *
 * The mount owns a WebGL context. A document tab is closed and reopened
 * constantly, and browsers cap live contexts (Chrome drops the oldest at ~16),
 * so disposal is not optional housekeeping here — it is what keeps the *other*
 * tabs' 3D views alive.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/StepBody
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { C, MONO, R } from '../theme.js'
import { OCCT_WASM_ROUTE } from '../../shared/occt-asset.js'
import { DOCUMENT_COPY } from './copy.js'
import type { DocumentBodyProps } from './contract.js'
import { DocumentRenderError } from './mount.js'
import { mountStepDocument } from './step.js'

/** Props the registration injects for the model kind. */
export interface StepBodyInjected {
  /** Same-origin URL of the packaged reader wasm; injected so tests can point elsewhere. */
  readonly wasmUrl?: string
}

/** Standard document props plus the reader location. */
export type StepBodyProps = DocumentBodyProps & StepBodyInjected

type StepState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready' }
  | { readonly phase: 'error'; readonly message: string }

const STAGE: React.CSSProperties = {
  position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: C.base,
}
const HOST: React.CSSProperties = { position: 'absolute', inset: 0 }
const CENTER: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', gap: 6, padding: 24, textAlign: 'center', color: C.text3, fontSize: 11, lineHeight: 1.6,
}
const ERROR_TITLE: React.CSSProperties = { margin: 0, color: C.text2, fontSize: 12, fontWeight: 600 }
const ERROR_LINE: React.CSSProperties = { margin: 0, maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const HINT: React.CSSProperties = {
  position: 'absolute', right: 8, bottom: 8, padding: '2px 8px', borderRadius: R.pill,
  background: 'rgba(0,0,0,0.55)', color: '#e4e4e7', fontSize: 10, fontFamily: MONO,
  pointerEvents: 'none', maxWidth: 'calc(100% - 16px)',
}

/** Human-readable text for a STEP failure. */
export function stepFailureText(error: unknown): string {
  const copy = DOCUMENT_COPY.state
  if (error instanceof DocumentRenderError) {
    if (error.reason === 'parse') return copy.stepInvalid
    if (error.reason === 'toolarge') return copy.tooLarge('32 MB')
    if (error.reason === 'aborted') return copy.aborted
    if (error.message.includes('webgl')) return copy.noWebgl
    if (error.message.includes('wasm')) return copy.wasmFailed
    return copy.renderFailed(error.message)
  }
  return copy.renderFailed(error instanceof Error ? error.message : String(error))
}

/**
 * Render one STEP/STP document inside its tab.
 * @param props - document bytes, tab lifetime, reader location.
 * @returns the model, a loading line, or an in-document failure.
 */
export function StepBody(props: StepBodyProps): ReactNode {
  const { content } = props
  const { tab } = props.useTabInfo()
  const host = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<StepState>({ phase: 'loading' })
  const data = content.kind === 'bytes' ? content.data : undefined
  const wasmUrl = props.wasmUrl ?? OCCT_WASM_ROUTE

  useEffect(() => {
    const container = host.current
    if (data === undefined || container === null) return
    const controller = new AbortController()
    const lifetime = AbortSignal.any([tab.signal, controller.signal])
    let mounted: { dispose(): void } | undefined
    setState({ phase: 'loading' })

    void (async () => {
      const live = await mountStepDocument({ bytes: data, container, signal: lifetime, wasmUrl })
      mounted = live
      if (lifetime.aborted) {
        live.dispose()
        mounted = undefined
        return
      }
      setState({ phase: 'ready' })
    })().catch((error: unknown) => {
      if (lifetime.aborted) return
      setState({ phase: 'error', message: stepFailureText(error) })
    })

    return () => {
      controller.abort()
      mounted?.dispose()
    }
  }, [data, tab.signal, wasmUrl])

  return (
    <div data-step-preview style={STAGE}>
      <div ref={host} style={HOST} data-step-host />
      {state.phase === 'loading' && (
        <p style={CENTER} data-step-loading>{DOCUMENT_COPY.state.stepLoading}</p>
      )}
      {state.phase === 'error' && (
        <div style={CENTER} role="alert" data-step-error>
          <p style={ERROR_TITLE}>{DOCUMENT_COPY.viewer.model}</p>
          <p style={ERROR_LINE}>{state.message}</p>
        </div>
      )}
      {state.phase === 'ready' && <span style={HINT} data-step-hint>{DOCUMENT_COPY.hint.model}</span>}
    </div>
  )
}
