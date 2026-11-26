/**
 * Copy for the document-rendering surfaces, backed by the same DSH locale
 * namespace as `../copy.ts`.
 *
 * The dictionaries are flat `{name}` templates in `../locales.ts`; this module
 * keeps the structured read API so the bodies do not carry a `t` seat. Reads go
 * through the active locale at call time, and DSH's renderer re-renders the
 * document slot on a language change.
 *
 * Extension names, viewer verbs and unit symbols are not translated.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/copy
 */

import { translateCopy } from '../copy.js'

export const DOCUMENT_COPY = {
  /** Toolbar labels for the document viewer menu. */
  viewer: {
    get schematic(): string { return translateCopy('document.viewer.schematic') },
    get pcb(): string { return translateCopy('document.viewer.pcb') },
    get model(): string { return translateCopy('document.viewer.model') },
  },
  /** Progress and state lines. */
  state: {
    get loading(): string { return translateCopy('document.state.loading') },
    get stepLoading(): string { return translateCopy('document.state.stepLoading') },
    tooLarge: (limit: string): string => translateCopy('document.state.tooLarge', { limit }),
    parseFailed: (message: string): string => translateCopy('document.state.parseFailed', { message }),
    renderFailed: (message: string): string => translateCopy('document.state.renderFailed', { message }),
    get aborted(): string { return translateCopy('document.state.aborted') },
    /** Shown when the WebGL canvas cannot be created (no GPU, blocklisted driver). */
    get noWebgl(): string { return translateCopy('document.state.noWebgl') },
    get stepInvalid(): string { return translateCopy('document.state.stepInvalid') },
    get wasmFailed(): string { return translateCopy('document.state.wasmFailed') },
  },
  /** Interaction hints overlaid on a rendered document. */
  hint: {
    get schematic(): string { return translateCopy('document.hint.schematic') },
    get model(): string { return translateCopy('document.hint.model') },
  },
  /** Child-sheet disclosure under a schematic. */
  sheets: {
    title: (count: number): string => translateCopy('document.sheets.title', { count }),
    missing: (label: string): string => translateCopy('document.sheets.missing', { label }),
    found: (label: string): string => translateCopy('document.sheets.found', { label }),
    get hint(): string { return translateCopy('document.sheets.hint') },
  },
}
