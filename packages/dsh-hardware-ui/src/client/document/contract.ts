/**
 * Structural view of the DSH document-preview seats this package extends.
 *
 * Why structural and not imported: the DSH client packages are not installed in
 * this repository (only `@deepseek-ai/cordis` is), and the sibling packages
 * declare the same seams by shape for the same reason (`dsh-eda-selection`,
 * `dsh-huaqiu-about`, `dsh-tool-pcb-viewer/src/client/panel.tsx`). Every field
 * below is read from the framework's published contract, not guessed:
 *
 * - `DocumentPreviewDefinition` / `DocumentLoadMode`
 *   `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/document/registry.ts:6-33`
 * - `DocumentContent` / `DocumentBodyOwner` / `DocumentPreviewProps`
 *   `…/src/client/document/contract.ts:17-98`
 * - the owner fields a body actually receives, and the `locale`-less prop set
 *   `…/src/client/TextPreview.tsx:381-386`
 * - `sidebar.right.tab.document` is a keyed slot whose `key` is the definition
 *   id and whose props carry the enclosing tab reader
 *   `…/src/client/document/contract.ts:48-60`
 *
 * A drift in any of these is a compile-time failure here, not a runtime
 * surprise: the body components consume this module's types only.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/contract
 */

/** Content delivery mode the document owner performs for a renderer. */
export type DocumentLoadMode = 'text-pages' | 'bytes-complete' | 'renderer'

/** One renderer implementation, independent of its keyed body registration. */
export interface DocumentPreviewDefinition {
  /** Unique implementation name, also the document slot key. */
  readonly id: string
  /** File suffixes without a leading dot; matching is case-insensitive. */
  readonly extensions: readonly string[]
  /** Suffixes among `extensions` that are not readable text. */
  readonly binaryExtensions?: readonly string[]
  /** External implementations win over product implementations. */
  readonly priority?: 'builtin' | 'extension'
  /** Localized implementation label, evaluated when the toolbar renders. */
  readonly title: () => string
  /** Content delivery mode supplied by the document owner. */
  readonly loading: DocumentLoadMode
  /** Whether the implementation consumes the document's wrap preference. */
  readonly wrap?: boolean
  /** Whether a `text-pages` body exposes source-line anchors. */
  readonly sourceLines?: boolean
}

/** One loaded text window; unused by whole-byte renderers, required by the union. */
export interface DocumentTextPage {
  readonly offset: number
  readonly text: string
  readonly lines: number
}

/** Ordinary file contents, or a request for the selected renderer to load them. */
export type DocumentContent =
  | {
    readonly kind: 'text'
    readonly text: string
    readonly pages: readonly DocumentTextPage[]
    readonly eof: boolean
  }
  | { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> }
  | {
    readonly kind: 'renderer'
    readonly revision: number
    readonly loaded: (version: string) => void
    readonly failed: () => void
    readonly reload: () => void
  }

/** Content and viewing inputs the document body owner supplies. */
export interface DocumentBodyOwner {
  readonly addResource: (address: string) => void
  readonly setResources: (addresses: readonly string[]) => void
  readonly resourceAddress: string
  readonly content: DocumentContent
  readonly wrap: boolean
  readonly scrollportRef: (element: HTMLElement | null) => void
}

/** The enclosing document tab, as the tab reader exposes it. */
export interface DocumentTabInfo {
  readonly tab: {
    readonly id: string
    /** Aborted when the tab record ends; every asynchronous mount binds to it. */
    readonly signal: AbortSignal
  }
}

/** Standard props of a `sidebar.right.tab.document` body. */
export interface DocumentBodyProps extends DocumentBodyOwner {
  readonly sessionId: string
  readonly useTabInfo: () => DocumentTabInfo
}

/** The slice of the slot registry this package registers through. */
export interface SlotSpec {
  readonly name: string
  readonly key: string
  readonly locale?: string
  readonly store?: unknown
  readonly inject?: (...args: unknown[]) => object
}

/** The slice of the slot service this package calls. */
export interface SlotService {
  inject(key: string, callback: () => () => void): () => void
  register(spec: SlotSpec, component: unknown): () => void
}

/** The slice of the document-preview registry this package calls. */
export interface DocumentPreviewService {
  register(definition: DocumentPreviewDefinition): () => void
}

/** Workspace byte window, matching the Host endpoint's `readBytes` options. */
export interface WorkspaceByteReadOptions {
  readonly range?: { readonly offset?: number; readonly length?: number }
  readonly baseFile?: string
}

/** Result envelope of one Client Remote call: failures travel, they do not throw. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

/** The slice of `remote.workspaceFiles` a child-sheet probe needs. */
export interface WorkspaceFilesRemote {
  readBytes(
    sessionId: string,
    path: string,
    options: WorkspaceByteReadOptions,
    signal?: AbortSignal,
  ): Promise<RemoteResult<unknown>>
}

/**
 * Client context this package's document integration needs.
 *
 * Every service is optional: the product UI registered by `apply` must keep
 * working on a Host whose document-preview service is absent, so the caller
 * guards each seat instead of parking the whole plugin behind `inject`.
 */
export interface DocumentClientContext {
  readonly documentPreviews?: DocumentPreviewService
  readonly slots?: SlotService
  readonly remote?: { readonly workspaceFiles?: WorkspaceFilesRemote }
  effect?(fn: () => (() => void) | void, label?: string): void
  inject?(dependencies: readonly string[], callback: (scope: DocumentClientContext) => void): void
  get?(name: string): unknown
}

/** The document seat every body registers into. */
export const DOCUMENT_BODY_SLOT = 'sidebar.right.tab.document'
