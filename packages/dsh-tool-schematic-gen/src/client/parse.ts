/**
 * Pure projection layer for the schematic/system-design HIT card.
 *
 * Result shapes produced by the node half (`src/tools.ts`):
 *   generate_schematic_from_description →
 *     { status:'generated', kind:'schematic', design_name, schFiles:[{filename}],
 *       schArtifacts:[{id,type,filename,size,uri?}], kicadPro, project_achieve_url, note? }
 *   generate_system_module_graph →
 *     { status:'generated', kind:'system', design_name, module_count,
 *       connection_count, module_names, zip_bytes,
 *       zipArtifact:{id,type:'zip',filename,size,uri?}, note? }
 *   both may return { status:'needs_auth', kind, hint }
 *   both may return { status:'needs_subscription', kind, packageName,
 *     currentQuota, hint } — no available GEN generation quota.
 *
 * `uri` (when present) is the HQ Edge-resolvable handle the Place action uses.
 */

export interface ContentBlockLike {
  type?: string
  text?: string
}

export interface ToolBlockLike {
  content?: readonly ContentBlockLike[]
  isError?: boolean
  error?: { code?: string } | null
}

export interface ArtifactRef {
  id: string
  type: string | null
  filename: string | null
  size: number | null
  /**
   * HQ Edge-resolvable URI (`file://`) for the artifact bytes — the handle the
   * Place action passes to `hqEdge.placeArtifact`. `null` when the node half
   * could not resolve it (standalone DSH, older node half): the card then
   * hides Place.
   */
  uri: string | null
}

export interface SchResult {
  status: string | null
  kind: string | null
  artifact: ArtifactRef | null
  /** Every placeable artifact (schematic sheets / the project zip). */
  artifacts: ArtifactRef[]
  designName: string | null
  fileCount: number | null
  moduleCount: number | null
  connectionCount: number | null
  /** User-safe status detail — rendered by the card. */
  note: string | null
  /** Subscription detail (only for status 'needs_subscription'). */
  packageName: string | null
  currentQuota: number | null
  /**
   * Agent-only directive/explanation. Parsed only so the shape is explicit;
   * the card deliberately never renders it.
   */
  agentNote: string | null
}

export type ProjectedPhase =
  | { phase: 'generating' }
  | { phase: 'failed'; message: string }
  | { phase: 'needs_auth'; result: SchResult }
  | { phase: 'needs_subscription'; result: SchResult }
  | { phase: 'completed'; result: SchResult }
  | { phase: 'unknown' }

export function resultTextOf(block: ToolBlockLike | undefined): string {
  const content = block?.content
  if (!Array.isArray(content)) return ''
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string') return c.text
  }
  return ''
}

function firstLine(text: string): string {
  const t = text.trim()
  const nl = t.indexOf('\n')
  return nl === -1 ? t : t.slice(0, nl)
}

function artOf(a: unknown): ArtifactRef | null {
  if (!a || typeof a !== 'object') return null
  const o = a as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : null
  if (!id) return null
  return {
    id,
    type: typeof o.type === 'string' ? o.type : null,
    filename: typeof o.filename === 'string' ? o.filename : null,
    size: typeof o.size === 'number' ? o.size : null,
    uri: typeof o.uri === 'string' && o.uri.length > 0 ? o.uri : null,
  }
}

export function parseSchResult(text: string): SchResult | null {
  const t = text.trim()
  if (!t) return null
  let v: unknown
  try {
    v = JSON.parse(t)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>

  const status = typeof o.status === 'string' ? o.status : null
  const kind = typeof o.kind === 'string' ? o.kind : null

  let artifact: ArtifactRef | null = null
  const artifacts: ArtifactRef[] = []
  if (kind === 'system') {
    artifact = artOf(o.zipArtifact)
    if (artifact) artifacts.push(artifact)
  } else {
    // The project zip is the single source of truth (sheets + footprints); the
    // per-sheet artifacts are a legacy fallback when no zip was stored.
    const zipRef = artOf(o.zipArtifact)
    if (zipRef) {
      artifact = zipRef
      artifacts.push(zipRef)
    }
    const list = Array.isArray(o.schArtifacts) ? (o.schArtifacts as unknown[]) : []
    for (const entry of list) {
      const ref = artOf(entry)
      if (ref) artifacts.push(ref)
    }
    if (!artifact) artifact = artifacts.length > 0 ? artifacts[0]! : null
  }

  return {
    status,
    kind,
    artifact,
    artifacts,
    designName: typeof o.design_name === 'string' && o.design_name ? o.design_name : null,
    fileCount: Array.isArray(o.schFiles) ? (o.schFiles as unknown[]).length
      : (Array.isArray(o.schArtifacts) ? (o.schArtifacts as unknown[]).length : null),
    moduleCount: typeof o.module_count === 'number' ? o.module_count : null,
    connectionCount: typeof o.connection_count === 'number' ? o.connection_count : null,
    note: typeof o.note === 'string' ? o.note : null,
    packageName: typeof o.packageName === 'string' && o.packageName ? o.packageName : null,
    currentQuota: typeof o.currentQuota === 'number' ? o.currentQuota : null,
    agentNote: typeof o.agentNote === 'string' ? o.agentNote : null,
  }
}

export function projectToolCall(block: ToolBlockLike | undefined): ProjectedPhase {
  if (!block || typeof block !== 'object') return { phase: 'unknown' }
  if (!Array.isArray(block.content)) return { phase: 'generating' }
  if (block.isError === true) {
    const errText = resultTextOf(block)
    const errCode = block.error && typeof block.error.code === 'string' ? block.error.code : null
    return { phase: 'failed', message: firstLine(errText) || (errCode ? `tool error: ${errCode}` : 'generation failed') }
  }
  const text = resultTextOf(block)
  const parsed = parseSchResult(text)
  if (!parsed) return { phase: 'failed', message: firstLine(text) || 'unparseable tool result' }
  if (parsed.status === 'generated') return { phase: 'completed', result: parsed }
  if (parsed.status === 'needs_auth') return { phase: 'needs_auth', result: parsed }
  if (parsed.status === 'needs_subscription') return { phase: 'needs_subscription', result: parsed }
  if (parsed.kind) return { phase: 'completed', result: parsed }
  return { phase: 'failed', message: `unexpected tool status: ${parsed.status}` }
}

export function formatBytes(n: number | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Filename for download: prefer the artifact filename, else derive from kind. */
export function downloadFilenameFor(kind: string | null, artifact: ArtifactRef | null, designName: string | null): string {
  if (artifact?.filename) return artifact.filename
  const base = designName && designName.length > 0 ? designName : 'generated'
  if (kind === 'system') return `${base}.zip`
  if (kind === 'schematic') return `${base}.kicad_sch`
  return `${base}.txt`
}
