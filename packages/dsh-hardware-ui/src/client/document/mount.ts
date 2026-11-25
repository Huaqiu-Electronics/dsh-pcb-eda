/**
 * Mount a workspace document's ECAD content into a container.
 *
 * This is the document-preview sibling of `../ecad.ts`, not a replacement: the
 * product viewer reads its artifact through the hardware-artifacts host route,
 * while a document preview already *has* the file bytes from DSH's own
 * workspace read. Same parser, same renderer, different content source — which
 * is the whole point of the difference (`docs/tasks/…full-impl-code-spec.md`
 * §5.3: do not merge the two implementations to share a little code).
 *
 * Behaviour the document seat requires, and how each is met:
 *
 * - **A late result never paints.** Every asynchronous step is followed by an
 *   abort check, and a render that settles after the tab or the revision moved
 *   on is disposed instead of attached.
 * - **A failed render is a value, not a crash.** The caller receives a rejected
 *   promise carrying a readable message; the body renders it inside the
 *   document.
 * - **Nothing outlives the document.** `dispose()` releases the renderer's own
 *   GPU resources and removes the canvas this module created — the renderer's
 *   `dispose()` detaches its listeners but leaves the element in place.
 * - **A zero-sized host is waited for, never fitted into.** The renderer fits the
 *   view during `load()` against the canvas it is given, so mounting into a box
 *   that has no layout yet would fit to nothing; the mount waits for a
 *   measurable box and gives up only when the document itself goes away.
 * - **A timeout is a real deadline.** A render that never settles is abandoned
 *   with a readable message instead of leaving the body loading forever.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/mount
 */

import { BoardParser, SchematicParser, type boardProto, type schematicProto } from '@huaqiu/kicad-sexpr-parser'
import { renderPcb, renderSchematic } from '@huaqiu/ecad-renderer'

/** Kinds of ECAD document this adapter renders. */
export type EcadDocumentKind = 'schematic' | 'pcb'

/** A renderer attached to a live document body. */
export interface MountedEcadDocument {
  /** Release the renderer and the canvas it was mounted into. Idempotent. */
  dispose(): void
}

/** Why a mount failed, without losing the renderer's own message. */
export class DocumentRenderError extends Error {
  readonly reason: 'parse' | 'render' | 'timeout' | 'aborted' | 'toolarge'

  constructor(reason: DocumentRenderError['reason'], message: string) {
    super(message)
    this.name = 'DocumentRenderError'
    this.reason = reason
  }
}

/** Content size above which a document is refused before parsing. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
/** Default ceiling for one mount, generous enough for a large board on a cold start. */
export const DEFAULT_RENDER_TIMEOUT_MS = 30_000

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function abortError(signal: AbortSignal): DocumentRenderError {
  const reason = signal.reason instanceof Error ? signal.reason.message : 'render abandoned'
  return new DocumentRenderError('aborted', reason)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unknown error'
}

/**
 * Wait until a container has a measurable box.
 *
 * A document body is laid out by the panel's flex column, so the first effect
 * can run before the box exists — and a tab restored into a collapsed panel has
 * no box at all until the user expands it. The wait therefore has no deadline of
 * its own: it ends when the box appears or when the document goes away. Failing
 * on a timer would turn "the panel is collapsed" into a rendering error the user
 * has to dismiss; waiting leaves the loading line up until there is somewhere to
 * draw, which is what is actually happening.
 * @param container - element the renderer will fill.
 * @param signal - document lifetime; the only thing that ends the wait empty-handed.
 */
export async function waitForLayout(container: HTMLElement, signal: AbortSignal): Promise<void> {
  const measurable = (): boolean => container.clientWidth > 0 && container.clientHeight > 0
  if (measurable()) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: DocumentRenderError): void => {
      if (settled) return
      settled = true
      observer?.disconnect()
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = (): void => { finish(abortError(signal)) }
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => { if (measurable()) finish() })
    observer?.observe(container)
    if (signal.aborted) {
      finish(abortError(signal))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // A tab that mounts while the pane is animating in has no box in the first
    // frame but does in the next; the observer alone would wait for a change.
    requestAnimationFrame(() => { if (measurable()) finish() })
  })
}

/** Run one renderer promise under a deadline, disposing a result that arrives too late. */
async function withinDeadline<T extends { dispose(): void }>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  let abandoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const release = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
  // A render that settles after the deadline must still free its GPU resources;
  // nothing else holds a reference to it by then.
  const disposeIfAbandoned = (): void => {
    if (!abandoned) return
    void work.then(result => { result.dispose() }, () => {})
  }
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      abandoned = true
      disposeIfAbandoned()
      reject(abortError(signal))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      abandoned = true
      disposeIfAbandoned()
      reject(new DocumentRenderError('timeout', `render did not finish within ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    const result = await Promise.race([work, deadline])
    if (abandoned || signal.aborted) {
      result.dispose()
      throw abortError(signal)
    }
    return result
  } finally {
    release()
  }
}

/** Create the absolutely-positioned canvas the renderer draws into. */
function createCanvas(container: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  // The renderer owns the backing resolution but not the CSS box. Handing it an
  // already-sized canvas is what makes its first fit match the panel instead of
  // its 300x150 default.
  canvas.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;outline:none'
  canvas.dataset.ecadCanvas = ''
  container.append(canvas)
  return canvas
}

/** Parse ECAD source text with the shared parser, reporting the parser's own message. */
export function parseEcadSource(kind: EcadDocumentKind, text: string): schematicProto.I_KicadSch | boardProto.I_KicadPCB {
  try {
    return kind === 'schematic' ? new SchematicParser().parse(text) : new BoardParser().parse(text)
  } catch (error) {
    throw new DocumentRenderError('parse', messageOf(error))
  }
}

export interface EcadDocumentRequest {
  readonly kind: EcadDocumentKind
  /** Decoded document text; the file itself stays authoritative and is never written back. */
  readonly text: string
  readonly container: HTMLElement
  /** Document lifetime: the tab's signal, or a superseded revision's controller. */
  readonly signal: AbortSignal
  readonly timeoutMs?: number
  /** Parsed model, when the caller already parsed it to read the sheet hierarchy. */
  readonly parsed?: schematicProto.I_KicadSch | boardProto.I_KicadPCB
}

/**
 * Parse, render and attach one ECAD document.
 * @param request - content, target container, lifetime and deadline.
 * @returns the live mount; call `dispose()` when the document closes or reloads.
 */
export async function mountEcadDocument(request: EcadDocumentRequest): Promise<MountedEcadDocument> {
  const { kind, text, container, signal } = request
  const timeoutMs = request.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
  if (signal.aborted) throw abortError(signal)
  await waitForLayout(container, signal)
  if (signal.aborted) throw abortError(signal)

  // Parsing is synchronous and can block for a large board; yield once so the
  // document body paints its loading state before the main thread stalls.
  await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
  if (signal.aborted) throw abortError(signal)

  const parsed = request.parsed ?? parseEcadSource(kind, text)
  if (signal.aborted) throw abortError(signal)

  const canvas = createCanvas(container)
  let rendered
  try {
    rendered = await withinDeadline(
      kind === 'schematic'
        ? renderSchematic(parsed as schematicProto.I_KicadSch, { canvas, container, interactive: true })
        : renderPcb(parsed as boardProto.I_KicadPCB, { canvas, container, interactive: true }),
      signal,
      timeoutMs,
    )
  } catch (error) {
    canvas.remove()
    if (error instanceof DocumentRenderError) throw error
    throw new DocumentRenderError('render', messageOf(error))
  }

  // The renderer fits once during `load()`, before the document body has its
  // final box. Re-fit after two painted frames so the first view matches the
  // panel; only at mount, because a later resize must not undo the user's own
  // pan and zoom.
  const viewer = rendered.viewer as { zoom_fit_top_item?: () => void }
  if (typeof viewer.zoom_fit_top_item === 'function') {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    })
    if (!signal.aborted) {
      try {
        viewer.zoom_fit_top_item()
      } catch {
        // A viewer that has been disposed by its own aborted load cannot fit;
        // the drawn frame is still valid, so this is not a mount failure.
      }
    }
  }

  let disposed = false
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      rendered.dispose()
      canvas.remove()
    },
  }
}
