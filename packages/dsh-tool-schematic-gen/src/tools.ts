/**
 * `@huaqiu/dsh-tool-schematic-gen` — the two agent-visible tools.
 *
 * Faithful TypeScript port of the `hq-edge` plugin's tool bodies, adapted to
 * the published DSH plugin surface:
 *   - the eda.cn account always comes from the `huaqiuAuth` service (no demo
 *     credentials — migration plan review #9);
 *   - generated artifacts are stored in the `huaqiuArtifacts` service
 *     (in-process, not a loopback);
 *   - tools are `defineTool` with `output.schema = { type: 'json' }` and a
 *     structured (lossless-JSON) result.
 *
 * Tools:
 *   generate_schematic_from_description   description → KiCad schematic
 *   generate_system_module_graph          description → module graph → KiCad zip
 *
 * @module @huaqiu/dsh-tool-schematic-gen
 */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HuaqiuAuthService } from '@huaqiu/dsh-auth'
import type { CreateArtifactResult, HuaqiuArtifacts } from '@huaqiu/dsh-artifacts'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import {
  agentIds,
  buildHeaders,
  buildRunBody,
  sanitizeZipBaseName,
  type EdaAccount,
  type SchematicGenConfig,
} from './config.js'
import { consumeCopilotkit, exportModuleGraphZip, HTTP_TIMEOUT_MS } from './sse.js'
import { fetchGenQuota, type GenQuota } from './quota.js'
import type { ProgressNote, RunProgress, TodoItem } from './progress.js'
import type { TraceEvent } from './trace.js'

/** Structural alias of the DSH `JsonValue` (see part-search Phase 1 §15.2.1). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** The normalized domain values are lossless-JSON plain objects except that
 *  optional fields are `undefined`, which fails DSH's lossless-JSON validation. */
function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-schematic-gen'
const log = getLogger(COMPONENT)

/** Agent-facing timeout hints. */
export const TOOL_TIMEOUT_MS = {
  generate_schematic_from_description: HTTP_TIMEOUT_MS,
  generate_system_module_graph: HTTP_TIMEOUT_MS,
} as const

/** Zip files up to this size are inlined as a base64 data URL on fallback;
 *  larger ones are written to a temp file and returned by path. */
export const MAX_INLINE_ZIP_BYTES = 1_000_000

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

// ── Runtime environment ──────────────────────────────────────────────────────

export interface SchematicGenDeps {
  fetchImpl?: typeof fetch
  writeFileImpl?: (path: string, data: Buffer | string) => Promise<void>
  tmpDirImpl?: () => string
  uuidImpl?: () => string
}

export interface SchematicGenEnv {
  config: SchematicGenConfig
  /** `huaqiuAuth` node service — the eda.cn account capability. */
  auth: HuaqiuAuthService['auth']
  /** `huaqiuArtifacts` node service — preview-artifact store. */
  artifacts: HuaqiuArtifacts
  timeoutMs: number
  /**
   * Optional live-progress sink, keyed by the tool call id. Absent in tests
   * and when the `webServer` service is unavailable — progress reporting is
   * best-effort and must never be able to fail a generation.
   */
  progress?: RunProgress | null
  deps?: SchematicGenDeps
}

/** Resolve the eda.cn account from the auth capability (no baked-in creds). */
async function resolveAccount(auth: HuaqiuAuthService['auth']): Promise<EdaAccount | null> {
  if (!auth || typeof auth.getUserInfo !== 'function') return null
  try {
    const info = await auth.getUserInfo()
    if (info && typeof info.id === 'string' && typeof info.token === 'string' && info.id.length > 0 && info.token.length > 0) {
      return { userId: info.id, userToken: info.token }
    }
    return null
  } catch (err) {
    log.warn('could not resolve the eda.cn account', { error: String((err as Error)?.message || err) })
    return null
  }
}

/** Fresh run id, injectable for tests. */
function newRunId(env: SchematicGenEnv): string {
  return typeof env.deps?.uuidImpl === 'function' ? env.deps.uuidImpl() : randomUUID()
}

/**
 * Minimal structural view of DSH's `ToolRunContext`. We only need two fields:
 * `signal` (cancellation) and `callId` — the tool-call identity that the
 * `tool.call.toolview` slot hands to the browser component as `props.callId`.
 * Typed structurally so tests can pass a plain object.
 */
export interface ToolExecLike {
  signal?: AbortSignal
  callId?: string
}

export interface RunProgressHandle {
  onTrace(events: TraceEvent[]): void
  onState(state: Record<string, unknown>): void
  onTodos(todos: TodoItem[]): void
  onNote(note: ProgressNote): void
  done(): void
  failed(message: string): void
}

/**
 * Bind one tool invocation to the progress store.
 *
 * Every returned callback is a no-op when there is no store or no `callId`,
 * so a tool can call these unconditionally.
 */
function progressFor(
  env: SchematicGenEnv,
  exec: ToolExecLike | undefined,
  toolName: string,
  kind: 'schematic' | 'system',
): RunProgressHandle {
  const store = env.progress
  const callId = typeof exec?.callId === 'string' && exec.callId.length > 0 ? exec.callId : ''
  const live = store && callId ? { store, callId } : null
  if (live) live.store.start(live.callId, toolName, kind)
  return {
    onTrace: (events) => { if (live) live.store.pushTrace(live.callId, events) },
    onState: (state) => { if (live) live.store.updateState(live.callId, state) },
    onTodos: (todos) => { if (live) live.store.setTodos(live.callId, todos) },
    onNote: (note) => { if (live) live.store.setNote(live.callId, note) },
    done: () => { if (live) live.store.finish(live.callId) },
    failed: (message) => { if (live) live.store.fail(live.callId, message) },
  }
}

/** Store a generated artifact in the user-wide preview store (in-process). */
async function createPreviewArtifact(
  env: SchematicGenEnv,
  type: 'schematic' | 'zip',
  filename: string,
  content: string,
  contentEncoding?: 'utf8' | 'base64',
): Promise<CreateArtifactResult> {
  if (!env.artifacts || typeof env.artifacts.create !== 'function') {
    throw new Error('schematic-gen: huaqiuArtifacts service unavailable — cannot store preview artifact')
  }
  return env.artifacts.create({ type, filename, content, contentEncoding })
}

/**
 * Best-effort cross-process URI for a stored artifact (`file://` to its
 * content on disk). This is what the Place action hands to HQ Edge — an
 * artifact *id* is store-local and meaningless there. Never throws: a
 * generation must not fail because the URI is unavailable; the card simply
 * hides Place when there is no uri.
 */
async function artifactUriOf(env: SchematicGenEnv, id: string): Promise<string | null> {
  try {
    if (!env.artifacts || typeof env.artifacts.getDownloadUri !== 'function') return null
    return await env.artifacts.getDownloadUri(id)
  } catch (err) {
    log.warn('getDownloadUri failed', { id, error: String((err as Error)?.message || err) })
    return null
  }
}

/** Artifact entry shape in the tool result (parsed by the client card). */
interface ArtifactEntry {
  id: string
  type: string
  filename: string
  size: number
  /** HQ Edge-resolvable URI (`file://`), present when resolvable. */
  uri?: string
}

async function toArtifactEntry(env: SchematicGenEnv, created: CreateArtifactResult): Promise<ArtifactEntry> {
  const entry: ArtifactEntry = { id: created.id, type: created.type, filename: created.filename, size: created.size }
  const uri = await artifactUriOf(env, created.id)
  if (uri) entry.uri = uri
  return entry
}

// ── Deliverable extraction ───────────────────────────────────────────────────

export interface SchematicSheet {
  filename: string
  content: string
}

export interface ExtractedSchematic {
  outProject: string
  project_achieve_url: string
  kicadPro: string
  schFiles: SchematicSheet[]
  error: string
}

/**
 * Pull the schematic deliverable out of the final agent state. `schFiles`
 * carry the `.kicad_sch` content inline, so the text is returned verbatim.
 */
export function extractSchematic(state: Record<string, unknown>): ExtractedSchematic {
  const rawFiles = Array.isArray(state.schFiles) ? state.schFiles : []
  const schFiles = rawFiles
    .map((f) => {
      const file = f && typeof f === 'object' ? f as Record<string, unknown> : {}
      return {
        filename: typeof file.filename === 'string' ? file.filename : '',
        content: typeof file.content === 'string'
          ? file.content
          : (typeof file.content === 'object' && file.content !== null
            ? JSON.stringify(file.content)
            : String(file.content ?? '')),
      }
    })
    .filter((f) => f.filename.length > 0)
  return {
    outProject: typeof state.outProject === 'string' ? state.outProject : '',
    project_achieve_url: typeof state.project_achieve_url === 'string' ? state.project_achieve_url : '',
    kicadPro: typeof state.kicadPro === 'string' ? state.kicadPro : '',
    schFiles,
    error: typeof state.error === 'string' ? state.error : '',
  }
}

/** Pull the module graph out of the final system-design state. */
export function extractModuleGraph(state: Record<string, unknown>): Record<string, unknown> | null {
  const mg = state && state.module_graph
  return mg && typeof mg === 'object' ? (mg as Record<string, unknown>) : null
}

// ── Shared tail: materialize schematic artifacts ─────────────────────────────

interface MaterializedSchematic {
  schFiles: Array<{ filename: string; content?: string }>
  schArtifacts?: Array<ArtifactEntry>
  /** User-safe status detail — the client card renders this. */
  note?: string
  /** Agent-only explanation/directive — the client card MUST NOT render it. */
  agentNote?: string
}

/**
 * Store each `.kicad_sch` sheet as a preview artifact and return the
 * structured result. Artifact creation is BEST-EFFORT and non-fatal: on any
 * failure the raw content is preserved inline so the result card can still
 * render it.
 */
async function materializeSchematicArtifacts(env: SchematicGenEnv, schFiles: SchematicSheet[]): Promise<MaterializedSchematic> {
  const outFiles: Array<{ filename: string; content?: string }> = schFiles.map((f) => ({ filename: f.filename }))
  const artifacts: ArtifactEntry[] = []
  let anyFailed = false
  let errorNote = ''

  for (let i = 0; i < schFiles.length; i++) {
    const file = schFiles[i]!
    try {
      const created = await createPreviewArtifact(env, 'schematic', file.filename, file.content)
      artifacts.push(await toArtifactEntry(env, created))
    } catch (storeErr) {
      anyFailed = true
      outFiles[i]!.content = file.content // data-loss guard
      const msg = String((storeErr as Error)?.message || storeErr)
      errorNote += (errorNote ? '; ' : '') + file.filename + ': ' + msg
    }
  }

  const result: MaterializedSchematic = { schFiles: outFiles }
  if (artifacts.length > 0) result.schArtifacts = artifacts
  if (anyFailed) {
    // Split by audience: the degraded state is worth telling the human, but
    // "the result card can render them directly / the full source is in the
    // zip" is an explanation for the agent about why it need not worry.
    result.note = 'Preview artifact storage partially or fully unavailable (' + errorNote + ').'
    result.agentNote =
      'Sheets without an artifact id still carry their source inline, so the result card can ' +
      'render them directly. Full source is always in the project zip/export.'
  }
  return result
}

// ── Tool bodies ──────────────────────────────────────────────────────────────

/**
 * Structured `needs_auth` result returned when the eda.cn login is missing —
 * the signal that makes login a human-in-the-loop step. The web client
 * (dsh-auth client half) renders a login card with an embedded auth.eda.cn
 * iframe for this result; the model asks the user to complete the login and
 * then retries the tool. Throwing here would hide that HIT surface.
 */
export function needsAuth(kind: 'schematic' | 'system'): Record<string, unknown> {
  return {
    status: 'needs_auth',
    kind,
    hint:
      'This tool requires a Huaqiu EDA (eda.cn) login. The web client is showing ' +
      'a login card with an embedded eda.cn login iframe — ask the user to complete ' +
      'the login there (or use the 华秋EDA login button in the sidebar), then call ' +
      'this tool again.',
  }
}

/**
 * Structured `needs_subscription` result returned when the resolved account
 * has NO available GEN generation quota (subscription exhausted / none).
 *
 * Mirrors `needs_auth`: the web client renders a subscription card (which
 * opens the subscription dialog automatically ONCE per session and always
 * offers the subscribe button); the MODEL is told every time — the `hint`
 * below is the every-call notice the user asked for.
 */
export function needsSubscription(kind: 'schematic' | 'system', quota: GenQuota): Record<string, unknown> {
  return {
    status: 'needs_subscription',
    kind,
    packageName: quota.packageName,
    currentQuota: quota.currentQuota,
    hint:
      'This account has no available GEN generation quota for ' + kind + ' design ' +
      '(currentQuota=' + quota.currentQuota + ', package=' + (quota.packageName || 'none') + '). ' +
      'Please tell the user: there is no available GEN generation quota, so the design was ' +
      'NOT generated. A subscription dialog has been opened — after the user subscribes or ' +
      'upgrades (or confirms the quota is restored), call this tool again to retry.',
  }
}

/**
 * Host whitelist for the project-zip download — mirrors the web app's
 * `/api/sch_sub_gen/download_zip` proxy (`apps/web/.../download_zip/route.ts`):
 * only https/http URLs on `eda.cn` / `*.eda.cn` are allowed. The URL comes
 * from the design agent's STATE_SNAPSHOT, but a node-side guard keeps a
 * compromised/misbehaving agent from turning the plugin into an SSRF proxy.
 */
function isAllowedZipHost(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  return url.hostname === 'eda.cn' || url.hostname.endsWith('.eda.cn')
}

/**
 * Download the project zip from the agent-uploaded URL.
 *
 * `project_achieve_url` is the source of truth — the same eda.cn datastream
 * URL the web app streams for export/download. It carries the full KiCad
 * project (sheets AND the footprints that keep sch↔pcb in sync). A plain GET
 * suffices (the web app proxies it only because of browser CORS; node has no
 * such restriction). Returns null when the URL is absent, not on the eda.cn
 * whitelist, or the download fails — the caller then falls back to inline
 * sheets.
 */
async function fetchSchematicProjectZip(env: SchematicGenEnv, url: string): Promise<Buffer | null> {
  if (!url) return null
  let target: URL
  try {
    target = new URL(url)
  } catch {
    log.warn('schematic zip download skipped — malformed url', { url })
    return null
  }
  if (!isAllowedZipHost(target)) {
    log.warn('schematic zip download skipped — host not allowed', { host: target.hostname, url })
    return null
  }
  const fetchImpl = env.deps?.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('schematic-gen: zip download did not respond within ' + HTTP_TIMEOUT_MS + 'ms')),
    HTTP_TIMEOUT_MS,
  )
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/zip' } })
    if (!res || !res.ok) {
      log.warn('schematic zip download failed', { status: res && res.status, url })
      return null
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } catch (err) {
    log.warn('schematic zip download failed', { error: String((err as Error)?.message || err), url })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `generate_schematic_from_description` body — stream `schemagen`, then store
 * the agent-uploaded project ZIP as a `zip` preview artifact (single source of
 * truth: it carries the sheets AND the footprints that keep sch↔pcb in sync).
 * Sheets are kept inline only as a fallback when the zip is unavailable.
 */
export async function runGenerateSchematic(
  args: Record<string, unknown>,
  exec: ToolExecLike | undefined,
  env: SchematicGenEnv,
): Promise<Record<string, unknown>> {
  const account = await resolveAccount(env.auth)
  if (!account) return needsAuth('schematic')
  // GEN quota pre-check: fail-closed only when the quota API answers with
  // "no quota left"; a failed check (null) fails open so a flaky quota API
  // never blocks a paying user.
  const genQuota = await fetchGenQuota(account, env.deps?.fetchImpl)
  if (genQuota && genQuota.currentQuota <= 0) return needsSubscription('schematic', genQuota)
  const threadId = newRunId(env)
  const body = buildRunBody(
    agentIds.SCHEMATIC,
    typeof args.description === 'string' ? args.description : '',
    env.config,
    account,
    typeof args.user_language === 'string' ? args.user_language : undefined,
    threadId,
  )
  const prog = progressFor(env, exec, 'generate_schematic_from_description', 'schematic')
  let state: Record<string, unknown>
  let text: string
  try {
    const res = await consumeCopilotkit(env.config.copilotkitUrl, body, buildHeaders(env.config, account, threadId), {
      signal: exec?.signal,
      timeoutMs: env.timeoutMs,
      fetchImpl: env.deps?.fetchImpl,
      onTrace: prog.onTrace,
      onState: prog.onState,
      onUnauthorized: () => { env.auth.invalidate() },
    })
    state = res.state
    text = res.text
  } catch (err) {
    prog.failed(String((err as Error)?.message || err))
    throw err
  }
  const extracted = extractSchematic(state)
  if (extracted.error) {
    const message = 'schematic-gen: the schematic agent finished with an error: ' + extracted.error +
      (text ? ' — ' + text.slice(0, 300) : '')
    prog.failed(message)
    throw new Error(message)
  }
  if (extracted.schFiles.length === 0) {
    const message = 'schematic-gen: the schematic agent produced no .kicad_sch files.' +
      (text ? ' Assistant said: ' + text.slice(0, 300) : '')
    prog.failed(message)
    throw new Error(message)
  }

  const result: Record<string, unknown> = {
    status: 'generated',
    kind: 'schematic',
    design_name: extracted.outProject || '',
    kicadPro: extracted.kicadPro,
    project_achieve_url: extracted.project_achieve_url,
  }

  // The project ZIP is the single source of truth (sheets + footprints for
  // sch↔pcb sync). Store it as a `zip` preview artifact — the card renders the
  // zip's root sheet and downloads the zip itself.
  const zipBuf = await fetchSchematicProjectZip(env, extracted.project_achieve_url)
  if (zipBuf && zipBuf.length > 0) {
    result.zip_bytes = zipBuf.length
    try {
      const safeName = sanitizeZipBaseName(extracted.outProject || 'schematic')
      const created = await createPreviewArtifact(env, 'zip', safeName + '.zip', zipBuf.toString('base64'), 'base64')
      result.zipArtifact = await toArtifactEntry(env, created)
    } catch (storeErr) {
      result.note = 'Could not store the project zip as an artifact (' +
        String((storeErr as Error)?.message || storeErr) + ').'
      result.agentNote =
        'The project zip (sheets + footprints) is still available at project_achieve_url; ' +
        'the card falls back to rendering the inline sheets below.'
    }
  }

  if (!result.zipArtifact) {
    // Fallback (older agent without an uploaded zip, or zip fetch/store
    // failure): store each sheet as a preview artifact — the card can still
    // render and download the individual sheet.
    const materialized = await materializeSchematicArtifacts(env, extracted.schFiles)
    result.schFiles = materialized.schFiles
    if (materialized.schArtifacts) result.schArtifacts = materialized.schArtifacts
    if (materialized.note) {
      result.note = (result.note ? result.note + ' ' : '') + materialized.note
    }
    if (materialized.agentNote) result.agentNote = materialized.agentNote
  }
  prog.done()
  return result
}

/**
 * `generate_system_module_graph` body — stream `modular_circuit`, extract the
 * module graph, POST it to export-zip, return the KiCad project zip stored as
 * a `zip` preview artifact.
 */
export async function runGenerateSystem(
  args: Record<string, unknown>,
  exec: ToolExecLike | undefined,
  env: SchematicGenEnv,
): Promise<Record<string, unknown>> {
  const account = await resolveAccount(env.auth)
  if (!account) return needsAuth('system')
  // GEN quota pre-check (see runGenerateSchematic).
  const genQuota = await fetchGenQuota(account, env.deps?.fetchImpl)
  if (genQuota && genQuota.currentQuota <= 0) return needsSubscription('system', genQuota)
  const threadId = newRunId(env)
  const body = buildRunBody(
    agentIds.SYSTEM,
    typeof args.description === 'string' ? args.description : '',
    env.config,
    account,
    typeof args.user_language === 'string' ? args.user_language : undefined,
    threadId,
  )
  const prog = progressFor(env, exec, 'generate_system_module_graph', 'system')
  let state: Record<string, unknown>
  let text: string
  try {
    const res = await consumeCopilotkit(env.config.copilotkitUrl, body, buildHeaders(env.config, account, threadId), {
      signal: exec?.signal,
      timeoutMs: env.timeoutMs,
      fetchImpl: env.deps?.fetchImpl,
      onTrace: prog.onTrace,
      onState: prog.onState,
      onTodos: prog.onTodos,
      onNote: prog.onNote,
      // `modular_circuit` does NOT emit CUSTOM trace events — its stack
      // arrives as the standard AG-UI tool-call lifecycle. Without this the
      // system-design card reported no progress at all.
      toolCallTrace: true,
      onUnauthorized: () => { env.auth.invalidate() },
    })
    state = res.state
    text = res.text
  } catch (err) {
    prog.failed(String((err as Error)?.message || err))
    throw err
  }
  const moduleGraph = extractModuleGraph(state)
  if (!moduleGraph) {
    const errState = typeof state.error === 'string' && state.error ? state.error : ''
    const message = 'schematic-gen: the system design agent produced no module_graph.' +
      (errState ? ' Error: ' + errState : '') +
      (text ? ' Assistant said: ' + text.slice(0, 300) : '')
    prog.failed(message)
    throw new Error(message)
  }

  // The stage ladder already reports "export" (module_graph is filled) while
  // this POST runs, so no extra phase marker is needed here.
  const zipBuf = await exportModuleGraphZip(env.config.exportZipUrl, moduleGraph, env.config, account, {
    signal: exec?.signal,
    timeoutMs: env.timeoutMs,
    fetchImpl: env.deps?.fetchImpl,
  }).catch((err: unknown) => {
    prog.failed(String((err as Error)?.message || err))
    throw err
  })

  const designName = typeof state.design_name === 'string' && state.design_name
    ? state.design_name
    : 'circuit'
  const connectionCount = typeof state.connection_count === 'number'
    ? state.connection_count
    : (Array.isArray(moduleGraph.connections) ? moduleGraph.connections.length : 0)
  const moduleNames = Array.isArray(moduleGraph.modules)
    ? (moduleGraph.modules as Array<Record<string, unknown>>)
      .map((m) => (m && typeof m.name === 'string' ? m.name : ''))
      .filter((n) => n.length > 0)
    : []

  const result: Record<string, unknown> = {
    status: 'generated',
    kind: 'system',
    design_name: designName,
    module_count: moduleNames.length,
    connection_count: connectionCount,
    module_names: moduleNames,
    zip_bytes: zipBuf.length,
  }
  const notes: string[] = []

  // Store the project zip as a `zip` preview artifact (primary). Keeping the
  // zip OUT of the JSON keeps the result small — inlining base64 used to
  // truncate the tool result and fail the card.
  let zipArtifact: ArtifactEntry | null = null
  try {
    const safeName = sanitizeZipBaseName(designName)
    const created = await createPreviewArtifact(env, 'zip', safeName + '.zip', zipBuf.toString('base64'), 'base64')
    zipArtifact = await toArtifactEntry(env, created)
  } catch (storeErr) {
    notes.push('Could not store the project zip as an artifact (' +
      String((storeErr as Error)?.message || storeErr) + '); kept it in the result instead.')
  }

  if (zipArtifact) {
    result.zipArtifact = zipArtifact
  } else {
    // Fallback (artifact store unavailable): inline the zip when small,
    // otherwise write to a temp file and return the path.
    if (zipBuf.length <= MAX_INLINE_ZIP_BYTES) {
      result.zip = 'data:application/zip;base64,' + zipBuf.toString('base64')
    } else {
      const safeName = sanitizeZipBaseName(designName)
      const fileName = 'hq-eda-' + safeName + '-' + newRunId(env).slice(0, 8) + '.zip'
      const dir = (env.deps?.tmpDirImpl && env.deps.tmpDirImpl()) || tmpdir()
      const filePath = join(dir, fileName)
      try {
        await (env.deps?.writeFileImpl || writeFile)(filePath, zipBuf)
        result.zip_path = filePath
      } catch (err) {
        result.zip = 'data:application/zip;base64,' + zipBuf.toString('base64')
        notes.push('Could not write the zip to a temp file (' +
          String((err as Error)?.message || err) + '); returned inline instead.')
      }
    }
  }
  if (notes.length > 0) result.note = notes.join(' ')
  prog.done()
  return result
}

/** Agent-awareness note about the eda.cn login gate, appended to both tool
 *  descriptions: a `needs_auth` result surfaces a login HIT (embedded eda.cn
 *  iframe card) — wait for the user to log in, then retry. Never invent
 *  credentials or fake success. */
const AUTH_GATE_NOTE =
  'AUTH: This tool requires a Huaqiu EDA (eda.cn) account. If the result has ' +
  'status "needs_auth", the web client is showing a login card with an embedded ' +
  'eda.cn login iframe (the human-in-the-loop step). Ask the user to complete the ' +
  'login there or via the 华秋EDA login button in the sidebar (you may use ' +
  'ask_user_question to wait, offering a "retry now that I have logged in" ' +
  'option and a "cancel" option — phrase BOTH in the language the user is ' +
  'writing in), then call this tool again. Never invent credentials and never ' +
  'claim success when the result is needs_auth.'

/** Agent-awareness note about the GEN subscription quota gate, appended to
 *  both tool descriptions. A `needs_subscription` result means the account has
 *  no generation quota left: the web client auto-opens the subscription dialog
 *  once, but the model MUST inform the user EVERY time (this is the every-call
 *  notice) — never silently pretend the tool ran. */
const SUBSCRIPTION_GATE_NOTE =
  ' SUBSCRIPTION: Before every run this tool checks the account GEN generation ' +
  'quota against eda.cn. If the result has status "needs_subscription", the ' +
  'design was NOT generated: the account has no available GEN quota. Always ' +
  'tell the user (in their language) that there is no available GEN quota and ' +
  'the design was not generated; a subscription dialog has been opened — after ' +
  'the user subscribes or upgrades, call this tool again. Do not pretend the ' +
  'design was generated when the result is needs_subscription.'

// ── Tool definitions ─────────────────────────────────────────────────────────

function createSchematicTool(env: SchematicGenEnv) {
  return defineTool({
    name: 'generate_schematic_from_description',
    description:
      'Generate a KiCad schematic (.kicad_sch files) from a natural-language ' +
      'description of a circuit or sub-circuit — e.g. "design a 5V LM7805 linear ' +
      'regulator power supply with input and output filter capacitors". Calls the ' +
      'online HQ-EDA schematic generation agent and returns ' +
      'zipArtifact (the project zip — the single source of truth: it contains ' +
      'the .kicad_sch sheets AND the footprints that keep sch↔pcb in sync), ' +
      'plus kicadPro and project_achieve_url. ' +
      'Use this when the user asks to draw, generate or create a circuit ' +
      'schematic from a description (not from an image — for that use the ' +
      'symbol/footprint tools). ' +
      'IMPORTANT: The generated schematic renders automatically as a result card ' +
      'in the web client — an interactive canvas preview of the project (root ' +
      'sheet of the zip) and a download button that downloads the full project ' +
      'zip. ' +
      'Do NOT paste the schematic source, file URLs, or any fenced code block ' +
      'into your reply; just note in one line that the schematic was generated ' +
      'and how many sheets it has. ' + AUTH_GATE_NOTE + SUBSCRIPTION_GATE_NOTE,
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'The circuit design prompt, in natural language. Be specific about components, voltages and any required behaviour.',
      },
      user_language: {
        type: 'string',
        // The fallback is deliberately NOT spelled out here: it is deployment
        // config (`HQ_EDA_DEFAULT_LANGUAGE`), so quoting a literal default in
        // agent-facing copy would go stale the moment it is overridden.
        description: 'Optional language hint for the agent — pass the language the user is writing in (e.g. "简体中文" or "English"). Omit to use the deployment default.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return asJson(await runGenerateSchematic(args, exec, env))
    },
    timeoutMs: TOOL_TIMEOUT_MS.generate_schematic_from_description,
  })
}

function createSystemTool(env: SchematicGenEnv) {
  return defineTool({
    name: 'generate_system_module_graph',
    description:
      'Generate a hardware system design (module graph) from a natural-language ' +
      'description — e.g. "design a small smart alarm clock". Calls the online ' +
      'HQ-EDA system-design agent, which plans the modules, searches/selects ' +
      'parts, wires the connections, and produces a module graph; the graph is ' +
      'then exported to a KiCad project zip. Returns: a zipArtifact reference ' +
      '(preview-artifact id of the full project zip — the zip is never inlined ' +
      'into the conversation; a uri field is included when the cross-process ' +
      'placement channel is available) and a summary (design name, module count, ' +
      'connection count, module names). Use this when the user wants a whole ' +
      'system/module-level design, not a single schematic or symbol. ' +
      'IMPORTANT: The generated system design renders automatically as a result ' +
      'card in the web client — a canvas preview of the project root schematic ' +
      '(fetched from the zip artifact) and a Download button for the full ' +
      'project zip. Do NOT paste the schematic source, file URLs, or any fenced ' +
      'code block into your reply; just note in one line that the design was ' +
      'generated, its module count, and that the project zip is downloadable ' +
      'from the card. ' + AUTH_GATE_NOTE + SUBSCRIPTION_GATE_NOTE,
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'The system design prompt, in natural language. Describe the product or function you want, e.g. "an ESP32-C3 based smart fan".',
      },
      user_language: {
        type: 'string',
        // The fallback is deliberately NOT spelled out here: it is deployment
        // config (`HQ_EDA_DEFAULT_LANGUAGE`), so quoting a literal default in
        // agent-facing copy would go stale the moment it is overridden.
        description: 'Optional language hint for the agent — pass the language the user is writing in (e.g. "简体中文" or "English"). Omit to use the deployment default.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return asJson(await runGenerateSystem(args, exec, env))
    },
    timeoutMs: TOOL_TIMEOUT_MS.generate_system_module_graph,
  })
}

/** Build the two tool definitions against a runtime env. */
export function createSchematicGenTools(env: SchematicGenEnv) {
  return [
    createSchematicTool(env),
    createSystemTool(env),
  ]
}
