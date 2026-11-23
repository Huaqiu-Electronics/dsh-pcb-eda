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
  options: { readonly signal: AbortSignal; readonly revision?: string },
): Promise<MountedEcad> {
  const source = await loadArtifactSource(artifactPath, options.signal, options.revision)
  if (options.signal.aborted) throw aborted(options.signal)
  if (source.kind !== undefined && source.kind !== kind) {
    throw new Error(`host returned a ${source.kind} artifact for a ${kind} preview`)
  }

  let rendered
  if (kind === 'schematic') {
    rendered = await renderSchematic(new SchematicParser().parse(source.text), { container, interactive: true })
  } else {
    rendered = await renderPcb(new BoardParser().parse(source.text), { container, interactive: true })
  }

  if (options.signal.aborted) {
    rendered.dispose()
    throw aborted(options.signal)
  }

  return {
    dispose: () => { rendered.dispose() },
    sourceRevision: source.revision,
    source,
  }
}
