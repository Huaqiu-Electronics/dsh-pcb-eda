/**
 * Saved-file ECAD rendering adapter.
 *
 * Reads the exact saved artifact through the host route, parses it with
 * `@huaqiu/kicad-sexpr-parser` and renders with `@huaqiu/ecad-renderer`'s
 * documented main-thread API. No renderer worker is used: the current worker
 * protocol is parser-only/stubbed in the published renderer.
 */
import { BoardParser, SchematicParser } from '@huaqiu/kicad-sexpr-parser'
import { renderPcb, renderSchematic } from '@huaqiu/ecad-renderer'
import { loadArtifactSource, type ArtifactSource } from './transport.js'
import { COPY } from './copy.js'

export type EcadKind = 'schematic' | 'pcb'
export interface MountedEcad {
  /** Documented renderer disposal: detaches the canvas and frees GPU resources. */
  dispose(): void
  readonly sourceRevision: string
  readonly source: ArtifactSource
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function aborted(signal: AbortSignal): DOMException {
  return new DOMException('render abandoned: navigation changed', 'AbortError')
}

/**
 * Mount one parsed artifact into `container`.
 *
 * The abort signal is checked after every asynchronous step; a result that
 * arrives after the navigation changed is disposed instead of attached, so a
 * late fetch or a slow parse can never paint into an obsolete viewer.
 */
export async function mountEcad(
  kind: EcadKind,
  artifactPath: string,
  container: HTMLElement,
  options: { readonly signal: AbortSignal; readonly revision?: string; readonly session?: string },
): Promise<MountedEcad> {
  const source = await loadArtifactSource(artifactPath, {
    signal: options.signal,
    ...(options.revision === undefined ? {} : { expectedRevision: options.revision }),
    ...(options.session === undefined ? {} : { session: options.session }),
  })
  if (options.signal.aborted) throw aborted(options.signal)
  if (source.kind !== undefined && source.kind !== kind) {
    throw new Error(COPY.preview.ecadKindMismatch(kind, source.kind))
  }

  // The renderer owns the backing resolution but not the CSS size, and it fits
  // the view to the canvas during `load()`. Supplying our own already-sized
  // canvas is therefore the only way the first fit matches the panel instead of
  // the renderer's 300x150 default.
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;outline:none'
  container.append(canvas)

  let rendered
  if (kind === 'schematic') {
    rendered = await renderSchematic(new SchematicParser().parse(source.text), { canvas, container, interactive: true })
  } else {
    rendered = await renderPcb(new BoardParser().parse(source.text), { canvas, container, interactive: true })
  }

  if (options.signal.aborted) {
    rendered.dispose()
    canvas.remove()
    throw aborted(options.signal)
  }

  // The viewer fits once during `load()`, before React has finished laying the
  // viewer tab out. Re-fit on the next painted frame so the first view matches
  // the panel it is actually in rather than the pre-layout canvas. Only at
  // mount: a later resize must not undo the user's own pan/zoom.
  const viewer = rendered.viewer as { zoom_fit_top_item?: () => void }
  if (typeof viewer.zoom_fit_top_item === 'function') {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    })
    if (!options.signal.aborted) viewer.zoom_fit_top_item()
  }

  return {
    dispose: () => {
      rendered.dispose()
      canvas.remove()
    },
    sourceRevision: source.revision,
    source,
  }
}
