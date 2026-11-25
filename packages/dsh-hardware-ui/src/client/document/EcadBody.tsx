/**
 * Document body for `.kicad_sch` and `.kicad_pcb`.
 *
 * One component for both kinds, because the differences are exactly three: the
 * parser/renderer the mount picks, the interaction hint, and whether a sheet
 * hierarchy is disclosed. Splitting it in two would duplicate the whole
 * lifecycle to vary three strings.
 *
 * Lifecycle, in the order the document seat drives it:
 *
 * 1. **Content arrives** as complete bytes (`loading: 'bytes-complete'`), so the
 *    body never reads the file itself and never sees a partial document.
 * 2. **A revision change replaces the content object**, so the effect re-runs,
 *    aborts the previous mount and rebuilds — a renderer never shows the
 *    previous revision's pixels under the new revision's text.
 * 3. **The tab ends**, aborting `tab.signal`; the mount is disposed and the
 *    canvas removed. The body is not `keepMounted`, so this also runs on a tab
 *    switch.
 *
 * Every failure is rendered *inside* the document: the MDI shell, the
 * conversation and the other tabs are unaffected by a malformed board.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/EcadBody
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { C, MONO, R } from '../theme.js'
import { DOCUMENT_COPY } from './copy.js'
import type { DocumentBodyProps } from './contract.js'
import { DocumentRenderError, mountEcadDocument, parseEcadSource, type EcadDocumentKind } from './mount.js'
import { documentFilePath } from './paths.js'
import { sheetReferences, type SheetReference } from './sheets.js'

/** Resolve one declared child sheet to "readable" or not, through the Host's own workspace read. */
export type ProbeSheetFile = (path: string, signal: AbortSignal) => Promise<boolean>

/** Props the registration injects for one kind. */
export interface EcadBodyInjected {
  readonly kind: EcadDocumentKind
  readonly probeSheet?: ProbeSheetFile
}

/** Standard document props plus the kind this registration renders. */
export type EcadBodyProps = DocumentBodyProps & EcadBodyInjected

type SheetStatus = SheetReference & { readonly found: boolean | undefined }

type BodyState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly sheets: readonly SheetStatus[] }
  | { readonly phase: 'error'; readonly message: string }

const STAGE: React.CSSProperties = {
  position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden',
  background: C.base,
}
const HOST: React.CSSProperties = { position: 'absolute', inset: 0 }
const CENTER: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center', gap: 6, padding: 24, textAlign: 'center',
  color: C.text3, fontSize: 11, lineHeight: 1.6,
}
const ERROR_TITLE: React.CSSProperties = { margin: 0, color: C.text2, fontSize: 12, fontWeight: 600 }
const ERROR_LINE: React.CSSProperties = { margin: 0, maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const HINT: React.CSSProperties = {
  position: 'absolute', right: 8, bottom: 8, padding: '2px 8px', borderRadius: R.pill,
  background: 'rgba(0,0,0,0.55)', color: '#e4e4e7', fontSize: 10, fontFamily: MONO,
  pointerEvents: 'none', maxWidth: 'calc(100% - 16px)',
}
const SHEETS: React.CSSProperties = {
  position: 'absolute', left: 8, right: 8, bottom: 8, padding: '6px 8px', borderRadius: R.md,
  background: 'rgba(0,0,0,0.62)', color: '#e4e4e7', fontSize: 10, fontFamily: MONO,
  display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '40%', overflow: 'auto',
}
const SHEET_ROW: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'baseline' }

/** Human-readable text for a mount failure, keyed by the reason it carries. */
function failureText(error: unknown): string {
  const copy = DOCUMENT_COPY.state
  if (error instanceof DocumentRenderError) {
    if (error.reason === 'parse') return copy.parseFailed(error.message)
    if (error.reason === 'toolarge') return copy.tooLarge('32 MB')
    if (error.reason === 'aborted') return copy.aborted
    return copy.renderFailed(error.message)
  }
  return copy.renderFailed(error instanceof Error ? error.message : String(error))
}

/** Decode document bytes as UTF-8, dropping a BOM KiCad never writes but editors add. */
export function decodeDocumentText(data: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(data)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Render one ECAD document inside its tab.
 * @param props - document content, resource identity, tab lifetime and kind.
 * @returns the rendered document, a loading line, or an in-document failure.
 */
export function EcadBody(props: EcadBodyProps): ReactNode {
  const { content, kind, resourceAddress } = props
  const { tab } = props.useTabInfo()
  const host = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<BodyState>({ phase: 'loading' })
  const data = content.kind === 'bytes' ? content.data : undefined
  const path = useMemo(() => documentFilePath(resourceAddress)?.path, [resourceAddress])

  useEffect(() => {
    const container = host.current
    if (data === undefined || container === null) return
    const controller = new AbortController()
    const lifetime = AbortSignal.any([tab.signal, controller.signal])
    let mounted: { dispose(): void } | undefined
    setState({ phase: 'loading' })

    void (async () => {
      const text = decodeDocumentText(data)
      let references: readonly SheetReference[] = []
      let live: { dispose(): void }
      if (kind === 'schematic') {
        // Parsing once for the hierarchy keeps the disclosure and the render
        // reading the same model: a sheet list that disagreed with the picture
        // would be worse than no list.
        const parsed = parseEcadSource('schematic', text)
        references = sheetReferences(parsed, path ?? '')
        live = await mountEcadDocument({ kind, text, container, signal: lifetime, parsed })
      } else {
        live = await mountEcadDocument({ kind, text, container, signal: lifetime })
      }
      mounted = live
      if (lifetime.aborted) {
        // The tab or the revision ended while the viewer was fitting; the mount
        // is live and nothing else holds it.
        live.dispose()
        mounted = undefined
        return
      }
      setState({ phase: 'ready', sheets: references.map(reference => ({ ...reference, found: undefined })) })
    })().catch((error: unknown) => {
      if (lifetime.aborted) return
      setState({ phase: 'error', message: failureText(error) })
    })

    return () => {
      controller.abort()
      mounted?.dispose()
    }
  }, [data, kind, path, tab.signal])

  // Child sheets are resolved after the picture is up: existence is a Host read
  // per reference, and a slow one must not delay the render the user asked for.
  const probe = props.probeSheet
  useEffect(() => {
    if (state.phase !== 'ready' || probe === undefined) return
    const pending = state.sheets.filter(sheet => sheet.resolved !== undefined && sheet.found === undefined)
    if (pending.length === 0) return
    const controller = new AbortController()
    const lifetime = AbortSignal.any([tab.signal, controller.signal])
    void (async () => {
      const outcomes = await Promise.all(pending.map(async (sheet) => {
        try {
          return { resolved: sheet.resolved as string, found: await probe(sheet.resolved as string, lifetime) }
        } catch {
          return { resolved: sheet.resolved as string, found: false }
        }
      }))
      if (lifetime.aborted) return
      setState((current) => {
        if (current.phase !== 'ready') return current
        const byPath = new Map(outcomes.map(outcome => [outcome.resolved, outcome.found]))
        return {
          phase: 'ready',
          sheets: current.sheets.map(sheet => (sheet.resolved === undefined || !byPath.has(sheet.resolved)
            ? sheet
            : { ...sheet, found: byPath.get(sheet.resolved) })),
        }
      })
    })()
    return () => { controller.abort() }
  }, [state, probe, tab.signal])

  const sheets = state.phase === 'ready' ? state.sheets : []
  return (
    <div data-ecad-preview data-ecad-kind={kind} style={STAGE}>
      <div ref={host} style={HOST} data-ecad-host />
      {state.phase === 'loading' && (
        <p style={CENTER} data-ecad-loading>{DOCUMENT_COPY.state.loading}</p>
      )}
      {state.phase === 'error' && (
        <div style={CENTER} role="alert" data-ecad-error>
          <p style={ERROR_TITLE}>{kind === 'schematic' ? DOCUMENT_COPY.viewer.schematic : DOCUMENT_COPY.viewer.pcb}</p>
          <p style={ERROR_LINE}>{state.message}</p>
        </div>
      )}
      {state.phase === 'ready' && sheets.length === 0 && (
        <span style={HINT} data-ecad-hint>{DOCUMENT_COPY.hint.schematic}</span>
      )}
      {state.phase === 'ready' && sheets.length > 0 && (
        <div style={SHEETS} data-ecad-sheets>
          <span>{DOCUMENT_COPY.sheets.title(sheets.length)}</span>
          {sheets.map(sheet => (
            <span key={sheet.resolved ?? sheet.declared} style={SHEET_ROW} data-ecad-sheet={sheet.found === false ? 'missing' : 'present'}>
              <span>{sheet.found === false ? '!' : '·'}</span>
              <span>{sheet.found === false ? DOCUMENT_COPY.sheets.missing(sheet.label) : DOCUMENT_COPY.sheets.found(sheet.label)}</span>
            </span>
          ))}
          <span style={{ opacity: 0.7 }}>{DOCUMENT_COPY.sheets.hint}</span>
        </div>
      )}
    </div>
  )
}
