/** Same-origin calls to the `@huaqiu/hardware-artifacts` Host routes. */
import { describeHostError } from './copy.js'
import type {
  DiscoveryInfo, HardwareProjectInfo, InstallationsInfo, NativeApplication,
} from './model.js'

const PREFIX = '/api/v1/hardware'

interface Envelope<T> {
  readonly ok?: boolean
  readonly error?: { readonly code?: string; readonly message?: string }
  readonly data?: T
  readonly [key: string]: unknown
}

/**
 * One failed call → one `Error` whose message is already user-facing zh_CN.
 *
 * The route envelope carries a stable `code`, so the sentence is chosen here
 * instead of at every render site (the panel, the stages and the settings
 * section all show `error.message`). The code stays on the error object for
 * callers that branch on it. Host detail survives inside the message only when
 * {@link describeHostError} judges it technical rather than prose.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PREFIX}${path}`, init)
  const body = await response.json().catch(() => undefined) as Envelope<T> | undefined
  if (!response.ok || body?.ok === false) {
    const code = body?.error?.code
    const detail = body?.error?.message ?? `HTTP ${response.status}`
    const error = new Error(describeHostError(code, detail))
    throw code === undefined ? error : Object.assign(error, { code })
  }
  return body as T
}

/**
 * Readable text of a thrown value.
 *
 * `String(new Error('x'))` is `"Error: x"`, which is why every message the UI
 * renders goes through here instead of `String(error)`.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function query(cwd: string | undefined, project?: string, session?: string): string {
  const params = new URLSearchParams()
  if (cwd !== undefined && cwd !== '') params.set('cwd', cwd)
  if (project !== undefined && project !== '') params.set('project', project)
  if (session !== undefined && session !== '') params.set('session', session)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

export async function loadProjects(cwd?: string, project?: string, session?: string): Promise<DiscoveryInfo> {
  const body = await request<DiscoveryInfo>(`/projects${query(cwd, project, session)}`)
  const fallback: DiscoveryInfo = {
    cwd: body.cwd,
    projects: Array.isArray(body.projects) ? body.projects : [],
    ...(body.selected === undefined ? {} : { selected: body.selected as HardwareProjectInfo }),
    ...(body.issue === undefined ? {} : { issue: body.issue }),
  }
  return fallback
}

export async function loadInstallations(): Promise<InstallationsInfo> {
  return request<InstallationsInfo>('/installations')
}

export async function environment(): Promise<{ text?: string; childEnv?: Record<string, string> }> {
  return request<{ text?: string; childEnv?: Record<string, string> }>('/environment')
}

export async function openArtifact(requestBody: {
  application: NativeApplication
  artifactPath: string
  kind: string
  projectPath?: string
  session?: string
}): Promise<void> {
  await request('/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
}

/** Saved text of one authorized `.kicad_sch` or `.kicad_pcb`. */
export interface ArtifactSource {
  readonly path: string
  readonly kind: 'schematic' | 'pcb'
  readonly revision: string
  readonly bytes: number
  readonly mtimeMs?: number
  readonly text: string
}

export async function loadArtifactSource(
  artifactPath: string,
  options: {
    readonly signal?: AbortSignal
    readonly expectedRevision?: string
    readonly session?: string
    /** Workspace root the panel already discovered; the host adds it to the session's own. */
    readonly cwd?: string
  } = {},
): Promise<ArtifactSource> {
  const params = new URLSearchParams({ path: artifactPath })
  if (options.expectedRevision !== undefined && options.expectedRevision !== '') {
    params.set('revision', options.expectedRevision)
  }
  if (options.session !== undefined && options.session !== '') params.set('session', options.session)
  if (options.cwd !== undefined && options.cwd !== '') params.set('cwd', options.cwd)
  return request<ArtifactSource>(`/source?${params.toString()}`, options.signal === undefined ? {} : { signal: options.signal })
}

/** Generated PCB GLB for one authorized `.kicad_pcb`. */
export interface GlbArtifact {
  readonly url: string
  readonly path: string
  readonly revision: string
  readonly bytes: number
  readonly generatedAt: string
  readonly cached: boolean
}

/** Grouped BOM rows produced by the host from the saved root schematic. */
export interface BomRecord {
  readonly references: readonly string[]
  readonly quantity: number
  readonly value: string
  readonly footprint: string
  readonly dnp: boolean
  readonly fields: Readonly<Record<string, string>>
}

export interface BomProjection {
  readonly path: string
  readonly revision: string
  readonly generatedAt: string
  readonly cached: boolean
  readonly rows: readonly BomRecord[]
  readonly source: string
}

export async function loadBom(
  artifactPath: string,
  options: { readonly session?: string; readonly cwd?: string; readonly signal?: AbortSignal } = {},
): Promise<BomProjection> {
  return request<BomProjection>('/bom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: artifactPath,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

/** Prepare the GLB; the returned `url` is served by the same host route. */
export async function prepareBoardGlb(
  artifactPath: string,
  cwd?: string,
  signal?: AbortSignal,
  session?: string,
): Promise<GlbArtifact & { readonly url: string }> {
  return request<GlbArtifact & { readonly url: string }>('/glb', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: artifactPath,
      ...(cwd === undefined ? {} : { cwd }),
      ...(session === undefined ? {} : { session }),
    }),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** What the Order destination may do, as the host sees it. */
export interface OrderConfigInfo {
  readonly configured: boolean
  readonly baseUrl: string
  /** A signed-in Huaqiu session or an explicitly configured token. */
  readonly hasToken: boolean
  readonly provider: string
}

export async function loadOrderConfig(): Promise<OrderConfigInfo> {
  return request<OrderConfigInfo>('/order')
}

export interface BoardFactsInfo {
  readonly layers: number
  readonly widthMm: number
  readonly heightMm: number
  readonly thicknessMm: number
  readonly minTrackMm?: number
  readonly minViaDrillMm?: number
  readonly outerOz?: number
  readonly innerOz?: number
}

export interface PackageInfo {
  readonly zipName: string
  readonly zipBytes: number
  readonly files: readonly { readonly name: string; readonly bytes: number }[]
}

/** A fabrication package prepared on the host; nothing has been uploaded. */
export interface FabricationProjection {
  readonly boardPath: string
  readonly revision: string
  readonly generatedAt: string
  readonly facts: BoardFactsInfo
  readonly archive: PackageInfo
  readonly assembly?: {
    readonly positions: number
    readonly bomLines: number
    readonly positionsBytes: number
    readonly bomBytes: number
  }
}

export async function prepareFabrication(
  boardPath: string,
  schematicPath?: string,
  cwd?: string,
  signal?: AbortSignal,
  session?: string,
): Promise<FabricationProjection> {
  return request<FabricationProjection>('/fabrication', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: boardPath,
      ...(schematicPath === undefined ? {} : { schematic: schematicPath }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(session === undefined ? {} : { session }),
    }),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** One placed order, as returned by the host after the backend answered. */
export interface PlacedOrder {
  readonly kind: 'pcb' | 'smt'
  /** The exact URL KiCad's own action loads in its order webview. */
  readonly orderUrl: string
  /** The backend's raw URL, before KiCad's query parameters were added. */
  readonly responseUrl: string
  readonly launched: boolean
  readonly launcher?: string
  readonly status: 'launched' | 'ready'
  readonly message: string
  readonly endpoint: string
  readonly archive: PackageInfo
  readonly assembly?: FabricationProjection['assembly']
}

/**
 * Submit one order. `confirm` is what the host requires; the panel sets it only
 * after the user confirms the upload in the dialog. The host never opens the
 * page by itself — the client shows `orderUrl` in its own Browser tab.
 */
export async function placeOrder(
  kind: 'pcb' | 'smt',
  requestBody: {
    path: string
    schematic?: string
    /** Workspace root of the panel's session; the base for a relative path. */
    cwd?: string
    session?: string
    quantity?: number
    confirm: boolean
  },
  signal?: AbortSignal,
): Promise<PlacedOrder> {
  return request<PlacedOrder>(`/order/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Hand an already-created order page back to the OS default browser. */
export async function openOrderUrl(url: string): Promise<{ readonly launched: boolean; readonly command: string }> {
  return request<{ readonly launched: boolean; readonly command: string }>('/order/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}
