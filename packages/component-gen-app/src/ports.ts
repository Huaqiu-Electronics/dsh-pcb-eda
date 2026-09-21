/**
 * `@huaqiu/component-gen-app` — the whole contract between the portable app
 * and its host (DSH adapter or standalone server).
 *
 * The app has ZERO DSH imports. It only knows this ports interface. Two
 * adapters implement it with the same HTTP client against different origins:
 *
 *   - DSH adapter  → `createDshPorts()` in `dsh-tool-symbol-footprint`, fetch
 *     to `/api/v1/huaqiu/component-gen/*` (plugin-owned webServer route).
 *   - Standalone   → `createHttpPorts()` in `api/component-gen-client.ts`,
 *     fetch to `http://localhost:<port>/api/v1/huaqiu/component-gen/*`.
 */

// ── Domain types (shared with `@huaqiu/component-gen-server`) ────────────────

export type ComponentGenPage = 'symbol' | 'footprint'

export type JobKind = 'symbol' | 'extract-footprint' | 'generate-footprint'

export type JobStatus =
  | 'queued'
  | 'running'
  | 'needs_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface JobInput {
  /** data URL of the uploaded image (server stores a thumbnail into history). */
  imageDataUrl?: string
  instruction?: string
  packageType?: string
  dimensions?: Record<string, number>
  fileName?: string
  /** which dimensions the human edited (footprint confirmations). */
  edited?: Record<string, boolean>
}

export interface JobState {
  id: string
  kind: JobKind
  status: JobStatus
  progress?: string
  /** structured result of the generation function (status/kind/fileUrl/...). */
  result?: Record<string, unknown>
  /** extracted dimensions for the `needs_confirmation` phase. */
  dimensions?: Record<string, unknown>
  pkgType?: string | null
  fileName?: string | null
  error?: string
  createdAt: string
  updatedAt: string
}

export type JobEvent =
  | { type: 'progress'; message: string; at: string }
  | { type: 'needs_confirmation'; dimensions: Record<string, unknown>; pkgType?: string | null; fileName?: string | null; at: string }
  | { type: 'completed'; job: JobState; at: string }
  | { type: 'failed'; error: string; result?: Record<string, unknown>; at: string }
  | { type: 'cancelled'; at: string }

export interface StartJobRequest {
  kind: JobKind
  input: JobInput
}

export interface HistoryQuery {
  limit?: number
  cursor?: string | null
}

export interface HistoryPage {
  entries: HistoryEntry[]
  nextCursor?: string | null
}

export interface HistoryEntry {
  id: string
  kind: 'symbol' | 'footprint'
  createdAt: string
  status: 'generated' | 'failed' | 'cancelled'
  input: {
    imageId?: string
    instruction?: string
    packageType?: string
    dimensions?: Record<string, number>
  }
  /** which dimensions the human edited (footprint confirmations). */
  edited?: Record<string, boolean>
  result?: {
    artifactId: string
    filename: string
    fileUrl?: string
    size?: number
    /** HQ Edge-resolvable URI captured at generation time (Place action). */
    uri?: string
  }
  error?: string
}

export interface HistoryPatch {
  status?: HistoryEntry['status']
  result?: HistoryEntry['result']
  error?: string
  edited?: Record<string, boolean>
}

/** Request to reopen a generated history entry in the active generation page. */
export interface ReopenRequest {
  /** monotonically increasing so re-clicking the same entry re-applies. */
  n: number
  entry: HistoryEntry
}

export interface ComponentGenConfig {
  hostMode: boolean
  capabilities: {
    symbol: boolean
    footprint: boolean
  }
  limits: {
    /** max accepted input image bytes. */
    imageBytes: number
  }
}

/** Auth capability consumed through the public `@huaqiu/dsh-auth` surface. */
export interface ComponentGenAuthPort {
  isAuthenticated(): Promise<boolean>
  getUserInfo(): Promise<{ nickname?: string } | null>
  /** Trigger the existing dsh-auth login flow (host-owned). */
  login(): Promise<void>
  onAuthStateChanged(listener: (authenticated: boolean) => void): () => void
}

/**
 * Optional Place capability: send a generated artifact into the host EDA
 * editor through HQ Edge (`hqEdge.placeArtifact`, same-origin edge-bridge).
 *
 * Structurally defined — the app stays DSH-agnostic. The host adapter decides
 * availability via `canPlace` (editor compatibility, UX-only: HQ Edge
 * re-enforces the same matrix server-side). Absent in standalone deployments,
 * in which case the app hides the Place action.
 */
export interface ComponentGenPlacePort {
  canPlace(type: 'symbol' | 'footprint'): boolean
  placeArtifact(request: { type: 'symbol' | 'footprint'; artifactUri: string; filename?: string }): Promise<unknown>
}

/** The whole contract the app needs from its host. */
export interface ComponentGenPorts {
  track?(event: string, properties?: Record<string, unknown>): void
  config(): Promise<ComponentGenConfig>
  startJob(req: StartJobRequest, signal?: AbortSignal): Promise<JobState>
  jobEvents(jobId: string, onEvent: (e: JobEvent) => void): () => void
  abortJob(jobId: string): Promise<void>
  history(query: HistoryQuery): Promise<HistoryPage>
  historyEntry(id: string): Promise<HistoryEntry | null>
  patchHistory(id: string, patch: HistoryPatch): Promise<HistoryEntry>
  deleteHistory(id: string): Promise<void>
  /** raw artifact text for preview (from `@huaqiu/dsh-artifacts` routes). */
  artifactContent(artifactId: string): Promise<string>
  /** data URL of a stored input thumbnail. */
  inputImage(imageId: string): Promise<string>
  auth: ComponentGenAuthPort
  /** Optional Place-into-editor capability (HQ Edge host only). */
  place?: ComponentGenPlacePort
}
