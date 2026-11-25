/**
 * Registration of the Hardware Engineering document renderers.
 *
 * The whole point of this module is how little it does: four file extensions
 * become four entries in DSH's existing document-preview registry, and the
 * existing `text` tab type — which already claims every workspace file — renders
 * our bodies through the keyed `sidebar.right.tab.document` seat. No second tab
 * system, no second explorer, no document identity of our own, and no change to
 * the panel layout: the MDI decides *when* a document opens, we only decide
 * *how* these four types are drawn.
 *
 * Priority is `'extension'` (a plugin implementation) rather than `'builtin'`,
 * which is what makes the ECAD viewer, not the plain-text view, the default for
 * a `.kicad_sch`. The text view stays available in the document's viewer menu
 * because the owner keeps every matching definition as a candidate — being able
 * to read the raw S-expression of the file you are looking at is a feature, not
 * a fallback.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document
 */

import { DOCUMENT_BODY_SLOT, type DocumentClientContext, type DocumentPreviewDefinition } from './contract.js'
import { DOCUMENT_COPY } from './copy.js'
import { EcadBody, type EcadBodyInjected } from './EcadBody.js'
import { StepBody, type StepBodyInjected } from './StepBody.js'
import type { ProbeSheetFile } from './EcadBody.js'

/** Implementation identity of the schematic body; also its document slot key. */
export const SCHEMATIC_BODY_ID = '@huaqiu/dsh-hardware-ui/document/schematic'
/** Implementation identity of the PCB body; also its document slot key. */
export const PCB_BODY_ID = '@huaqiu/dsh-hardware-ui/document/pcb'
/** Implementation identity of the 3D model body; also its document slot key. */
export const STEP_BODY_ID = '@huaqiu/dsh-hardware-ui/document/step'

/** Suffixes each registration claims. Matching is case-insensitive in the registry. */
export const SCHEMATIC_EXTENSIONS = ['kicad_sch'] as const
export const PCB_EXTENSIONS = ['kicad_pcb'] as const
export const STEP_EXTENSIONS = ['step', 'stp'] as const

/**
 * The four registrations, in the order they are installed.
 * @returns fresh definitions; the registry rejects a duplicate id, so callers cannot share one object.
 */
export function documentPreviewDefinitions(): readonly DocumentPreviewDefinition[] {
  return [
    {
      id: SCHEMATIC_BODY_ID,
      extensions: SCHEMATIC_EXTENSIONS,
      priority: 'extension',
      title: () => DOCUMENT_COPY.viewer.schematic,
      // Both ECAD formats are read whole before parsing: the parser needs the
      // complete S-expression tree, and a board or schematic is far below the
      // Host's complete-read cap.
      loading: 'bytes-complete',
      wrap: false,
    },
    {
      id: PCB_BODY_ID,
      extensions: PCB_EXTENSIONS,
      priority: 'extension',
      title: () => DOCUMENT_COPY.viewer.pcb,
      loading: 'bytes-complete',
      wrap: false,
    },
    {
      id: STEP_BODY_ID,
      extensions: STEP_EXTENSIONS,
      priority: 'extension',
      title: () => DOCUMENT_COPY.viewer.model,
      loading: 'bytes-complete',
      wrap: false,
    },
  ]
}

/** What the host half of the product can contribute to the document surfaces. */
export interface DocumentPreviewOptions {
  /**
   * Build the child-sheet probe for one session, or return undefined when the
   * workspace remote is unavailable. Absent means "disclose the references
   * without claiming to know whether they exist".
   */
  readonly probeSheet?: (sessionId: string) => ProbeSheetFile | undefined
  /** Same-origin URL of the packaged STEP reader; defaults to the host route. */
  readonly stepWasmUrl?: string
}

/**
 * Install the document renderers on a client context.
 *
 * Every seat is guarded: a Host without the document-preview service simply
 * gets no ECAD preview, and the product's own panel keeps working. Registration
 * runs inside `ctx.effect` when the framework offers it, so unloading the plugin
 * (or an HMR reload) retires the definitions and bodies with it.
 * @param ctx - client context carrying the document registry and slot registry.
 * @param options - host-provided contributions.
 */
export function installDocumentPreviews(ctx: DocumentClientContext, options: DocumentPreviewOptions = {}): void {
  const previews = ctx.documentPreviews
  const slots = ctx.slots
  if (previews === undefined || slots === undefined) return
  const effect = (fn: () => (() => void) | void, label: string): void => {
    if (ctx.effect !== undefined) ctx.effect(fn, label)
    else void fn()
  }

  for (const definition of documentPreviewDefinitions()) {
    effect(() => previews.register(definition), `hardware-ui: document ${definition.id}`)
  }

  const ecad = (kind: 'schematic' | 'pcb', id: string): void => {
    effect(() => slots.inject(DOCUMENT_BODY_SLOT, () => slots.register({
      name: DOCUMENT_BODY_SLOT,
      key: id,
      // The injected slice is what the body reads; the framework calls this
      // once per mount with the enclosing session.
      inject: (sessionId: unknown): EcadBodyInjected => {
        const probe = options.probeSheet?.(String(sessionId))
        return { kind, ...(probe === undefined ? {} : { probeSheet: probe }) }
      },
    }, EcadBody)), `hardware-ui: document body ${id}`)
  }
  ecad('schematic', SCHEMATIC_BODY_ID)
  ecad('pcb', PCB_BODY_ID)

  effect(() => slots.inject(DOCUMENT_BODY_SLOT, () => slots.register({
    name: DOCUMENT_BODY_SLOT,
    key: STEP_BODY_ID,
    inject: (): StepBodyInjected => (options.stepWasmUrl === undefined ? {} : { wasmUrl: options.stepWasmUrl }),
  }, StepBody)), `hardware-ui: document body ${STEP_BODY_ID}`)
}
