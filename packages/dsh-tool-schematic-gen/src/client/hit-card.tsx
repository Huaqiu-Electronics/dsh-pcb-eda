/**
 * Keyed `tool.call.toolview` HIT card for schematic generation (both
 * `generate_schematic_from_description` and `generate_system_module_graph`).
 *
 * Faithful React/TS port of the hq-edge `GenHit` card for schematics, adapted
 * to the published DSH slot contract (`ToolCallOwnerProps` + `sessionId`).
 * "Regenerate" sends a user message back to the agent through
 * `sessions.binding(sessionId).session.prompt(...)`; the node `ask()` stays
 * the single source of truth. The `needs_auth` phase renders an inline login
 * card (display + guidance; the auth plugin owns the credential handshake).
 *
 * Preview: a single `.kicad_sch` sheet renders via `renderSchematic`; a system
 * design zip renders via `renderProjectFromZip` (root sheet auto-selected).
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  projectToolCall, formatBytes, downloadFilenameFor,
  type SchResult, type ToolBlockLike,
} from './parse.js'
import { type Translate, useT } from './i18n.js'
import {
  resolveArtifactText, resolveArtifactBytes, renderSheetToCanvas,
  renderProjectZipToCanvas, sizeCanvasFor, downloadText, downloadBytes,
} from './ecad.js'
import { placeSupportOf, type HqEdgePlaceLike } from './place.js'
import { useLocale, useTheme } from './theme.js'
import { buildLoginUrl, loginIframeBackground } from './login-url.js'
import { LiveProgress } from './stack-frame.jsx'
import { bytesToBase64 } from './b64.js'

/** Login-state view used by the needs_auth card (from the auth plugin's shared localStorage). */
export interface AuthStateLike {
  authenticated: boolean
  nickname?: string
}

/**
 * Structural view of the `huaqiuAuth` CLIENT service (declared structurally,
 * never imported — each package must remain independently installable).
 * `login()` in HQ Edge host mode triggers the EDA login dialog through
 * hq-edge (`POST /api/v1/auth/login` → EDA `TriggerLoginDialog`) instead of
 * the auth.eda.cn iframe; `isHostMode()` tells the card which surface to show.
 * The subscription methods follow the same split: host mode opens the EDA
 * native dialog via DialogService.OpenUrl, standalone DSH opens an in-app
 * iframe at the preferred 1400×740 size.
 */
export interface AuthClientLike {
  auth?: {
    isAuthenticated(): boolean
    isHostMode?(): boolean
    login?(options?: { lang?: string; theme?: string }): Promise<void>
    onAuthStateChanged(listener: (info: { nickname?: string } | null) => void): () => void
    openSubscriptionDialog?(): Promise<void>
  }
}

export type PromptSender = (sessionId: string | undefined, message: string) => Promise<unknown>

const TOOL_SCHEMATIC = 'generate_schematic_from_description'
const TOOL_SYSTEM = 'generate_system_module_graph'

export interface GenHitProps {
  toolName: string
  block?: ToolBlockLike
  sessionId?: string
  /**
   * Tool call id from the `tool.call.toolview` slot. DSH guarantees it is
   * "stable across running and settled forms", and it is the SAME string the
   * node half receives as `ToolRunContext.callId` — which is exactly what the
   * progress store is keyed by. No callId means no live stack, but the card
   * still renders.
   */
  callId?: string
  inspect?: () => void
  authState?: AuthStateLike
  sendPrompt?: PromptSender
  /**
   * Lazy accessor for the `huaqiuAuth` client service (auth plugin browser
   * half). Absent/undefined in a broken install — the needs_auth card then
   * falls back to the embedded auth.eda.cn iframe. Lazy (not captured once)
   * so plugin load order resolves correctly at click time.
   */
  getAuth?: () => AuthClientLike | undefined
  /**
   * Lazy accessor for the host's `hqEdge` service (edge-bridge browser half).
   * Absent/undefined in standalone DSH — the Place button is then hidden.
   * Lazy (not captured once) so plugin load order and HQ Edge restarts both
   * resolve correctly at click time.
   */
  getHqEdge?: () => HqEdgePlaceLike | undefined
}

function kindOf(toolName: string): 'schematic' | 'system' {
  return toolName === TOOL_SYSTEM ? 'system' : 'schematic'
}

function kindTitleKey(kind: string | null): string {
  return kind === 'system' ? 'card.title.system' : 'card.title.schematic'
}

function kindLabel(kind: string | null, t: Translate): string {
  return kind === 'system' ? t('card.kind.system') : t('card.kind.schematic')
}

function StatusDot({ state }: { state: 'ongoing' | 'error' | 'done' }): ReactElement {
  const color = state === 'done' ? 'var(--dsw-alias-state-success-primary, #34a853)'
    : state === 'error' ? 'var(--dsw-alias-state-error-primary, #d93025)'
    : 'var(--dsw-alias-state-running-primary, #1a73e8)'
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, background: color }} />
}

function statusText(phase: string, t: Translate): string {
  if (phase === 'generating') return t('card.status.generating')
  if (phase === 'failed') return t('card.status.failed')
  return t('card.status.generated')
}

function header(kind: string | null, phase: string, t: Translate): ReactElement {
  const dot = phase === 'generating' ? 'ongoing' : phase === 'failed' ? 'error' : 'done'
  return (
    <div className="hq-sch__header">
      <span className="hq-sch__icon">⇶</span>
      <span className="hq-sch__title">{t(kindTitleKey(kind))}</span>
      <span className="hq-sch__status">
        <StatusDot state={dot} />
        <span>{statusText(phase, t)}</span>
      </span>
    </div>
  )
}

function summary(result: SchResult, t: Translate): ReactElement | null {
  const badges: ReactElement[] = []
  if (result.kind) badges.push(<span className="hq-sch__badge" key="kind">{kindLabel(result.kind, t)}</span>)
  if (result.designName) badges.push(<span className="hq-sch__badge hq-sch__badge--mono" key="design">{result.designName}</span>)
  if (result.kind === 'system') {
    if (result.moduleCount != null) badges.push(<span className="hq-sch__badge" key="mod">{t('card.meta.modules', { count: result.moduleCount })}</span>)
    if (result.connectionCount != null) badges.push(<span className="hq-sch__badge" key="conn">{t('card.meta.connections', { count: result.connectionCount })}</span>)
  } else if (result.fileCount != null) {
    badges.push(<span className="hq-sch__badge" key="files">{t('card.meta.sheets', { count: result.fileCount })}</span>)
  }
  const size = result.artifact?.size
  if (size != null) {
    const sizeText = formatBytes(size)
    if (sizeText) badges.push(<span className="hq-sch__badge" key="size">{sizeText}</span>)
  }
  if (badges.length === 0) return null
  return <div className="hq-sch__summary">{badges}</div>
}

// ── canvas preview ──────────────────────────────────────────────────────────

interface PreviewPayload {
  kind: 'schematic' | 'system'
  source: string | null
  bytes: Uint8Array | null
  srcKey: string
}

function PreviewStage({ payload, t }: { payload: PreviewPayload; t: Translate }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [view, setView] = useState<{ view: 'loading' | 'ready' | 'error'; message: string }>({ view: 'loading', message: '' })

  useEffect(() => {
    let cancelled = false
    let disposeViewer: (() => void) | null = null
    setView({ view: 'loading', message: '' })
    ;(async () => {
      try {
        const canvas = canvasRef.current
        if (!canvas) return
        await new Promise((resolve) => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve)
          else setTimeout(resolve, 16)
        })
        if (cancelled || canvas !== canvasRef.current) return
        sizeCanvasFor(canvas)
        if (payload.bytes) {
          // A bytes payload is the full project zip — render its root sheet.
          disposeViewer = await renderProjectZipToCanvas(payload.bytes, canvas)
        } else if (payload.source) {
          disposeViewer = await renderSheetToCanvas(payload.source, canvas)
        } else {
          throw new Error('no preview source')
        }
        if (cancelled || canvas !== canvasRef.current) return
        setView({ view: 'ready', message: '' })
      } catch (e) {
        if (!cancelled) {
          console.warn('[hq-schematic-gen] preview render failed', e)
          setView({ view: 'error', message: String((e as Error)?.message || e) })
        }
      }
    })()
    return () => {
      cancelled = true
      try { disposeViewer?.() } catch { /* ignore */ }
    }
  }, [payload.srcKey, payload.kind, payload.source, payload.bytes])

  const overlay =
    view.view === 'loading'
      ? <div className="hq-sch__stage-msg">{t('card.preview.loading')}</div>
      : view.view === 'error'
        ? <div className="hq-sch__stage-msg">{t('card.preview.renderError')}{view.message}</div>
        : null

  return (
    <div className="hq-sch__stage">
      <canvas ref={canvasRef} className="hq-sch__canvas" />
      {overlay}
    </div>
  )
}

// ── needs_auth login card ───────────────────────────────────────────────────

function LoginCard({ toolName, authState, t, getAuth }: { toolName: string; authState?: AuthStateLike; t: Translate; getAuth?: () => AuthClientLike | undefined }): ReactElement {
  const dark = useTheme()
  const locale = useLocale()
  const authClient = getAuth?.()?.auth
  // HQ Edge host mode: EDA owns the credential — login must ask EDA to open
  // its own TriggerLoginDialog (hq-edge POST /api/v1/auth/login), not the
  // auth.eda.cn iframe (a browser-pushed token is ignored by the STRICT host
  // resolver). Standalone DSH keeps the inline iframe.
  const hostMode = authClient?.isHostMode?.() ?? false

  // FILL mode (`fill=full`): this card IS the surface, so let the embed paint
  // it edge-to-edge with its own `bg-background`. Without it the embed's
  // `grid-rows-[20px_1fr_20px]` wrapper leaves two transparent strips above
  // and below the form, which read as white gaps in dark theme.
  const src = useMemo(
    () => buildLoginUrl({ lang: locale, theme: dark ? 'dark' : 'light' }),
    [locale, dark],
  )
  // Force a full remount on a theme/locale flip: Chrome keeps the old embed
  // loaded when only `src` changes (the embed is a Next.js page that reads
  // its URL params once on mount), silently ignoring the new `fill`/`theme`.
  const remountKey = `${locale}|${dark ? 'd' : 'l'}`

  const statusLine = (
    <p className="hq-sch__login-status" style={{ color: authState?.authenticated ? '#1677ff' : '#d4380d' }}>
      {authState?.authenticated
        ? t('card.auth.loggedIn', {
            nickname: authState.nickname ? t('card.nicknameSep', { nickname: authState.nickname }) : '',
          })
        : t('card.auth.loggedOut')}
    </p>
  )

  if (hostMode) {
    return (
      <div className="hq-sch">
        <div className="hq-sch__header">
          <span className="hq-sch__icon">⇶</span>
          <span className="hq-sch__title">{t('card.auth.title')}</span>
        </div>
        <div className="hq-sch__login">
          <p className="hq-sch__login-desc">{t('card.auth.descHost', { tool: toolName })}</p>
          {statusLine}
          <button
            type="button"
            className="hq-sch__login-btn"
            onClick={() => {
              void authClient?.login?.({ lang: locale, theme: dark ? 'dark' : 'light' })
                .catch(() => { /* login cancelled / dialog failed — card keeps showing the button */ })
            }}
          >
            {t('card.auth.loginBtn')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="hq-sch">
      <div className="hq-sch__header">
        <span className="hq-sch__icon">⇶</span>
        <span className="hq-sch__title">{t('card.auth.title')}</span>
      </div>
      <div className="hq-sch__login">
        <p className="hq-sch__login-desc">{t('card.auth.desc', { tool: toolName })}</p>
        {statusLine}
        <iframe
          key={remountKey}
          src={src}
          title={t('card.auth.title')}
          className="hq-sch__login-iframe"
          style={{ background: loginIframeBackground(dark) }}
          allow="clipboard-write"
        />
      </div>
    </div>
  )
}

// ── needs_subscription card ─────────────────────────────────────────────────

/**
 * LocalStorage flag: "the subscription dialog was already auto-opened once on
 * this client". User requirement: never-prompted → auto-open exactly ONCE;
 * already-prompted → never auto-open again (the button stays for manual
 * opens). A session-level flag would re-prompt after every reload, so this is
 * persistent (same spirit as `circuit_agent_subscription` in hq-eda-ai).
 */
const SUB_DIALOG_SHOWN_KEY = 'hq_subscription_dialog_shown'

function SubscriptionCard({
  result,
  t,
  getAuth,
}: {
  result: SchResult
  t: Translate
  getAuth?: () => AuthClientLike | undefined
}): ReactElement {
  const authClient = getAuth?.()?.auth
  const [opened, setOpened] = useState(false)

  // Auto-open ONCE (persistent flag), the very first time a needs_subscription
  // result lands on this client. Host mode → the EDA host's native dialog via
  // the auth service; standalone DSH → the in-app 1400×740 iframe.
  useEffect(() => {
    if (opened) return
    let shown = false
    try {
      shown = localStorage.getItem(SUB_DIALOG_SHOWN_KEY) === '1'
    } catch { /* storage unavailable — treat as never shown */ }
    if (shown) {
      setOpened(true)
      return
    }
    void authClient?.openSubscriptionDialog?.()
      .catch(() => { /* no dialog surface (broken install) — button still offered */ })
      .finally(() => {
        setOpened(true)
        try { localStorage.setItem(SUB_DIALOG_SHOWN_KEY, '1') } catch { /* best-effort */ }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authClient])

  const packageLabel = result.packageName ? t('card.subscription.package', { name: result.packageName }) : ''
  const quotaLabel = result.currentQuota != null
    ? t('card.subscription.quota', { count: result.currentQuota })
    : ''

  return (
    <div className="hq-sch">
      <div className="hq-sch__header">
        <span className="hq-sch__icon">⇶</span>
        <span className="hq-sch__title">{t('card.subscription.title')}</span>
      </div>
      <div className="hq-sch__login">
        <p className="hq-sch__login-desc">
          {t('card.subscription.desc')}
          {packageLabel || quotaLabel ? `（${[packageLabel, quotaLabel].filter(Boolean).join(' · ')}）` : ''}
        </p>
        <button
          type="button"
          className="hq-sch__login-btn"
          onClick={() => {
            void authClient?.openSubscriptionDialog?.()
              .catch(() => { /* dialog failed — card keeps showing the button */ })
          }}
        >
          {t('card.subscription.subscribe')}
        </button>
        <p className="hq-sch__login-status" style={{ color: '#8a94a6' }}>
          {t('card.subscription.afterSubscribe')}
        </p>
      </div>
    </div>
  )
}

// ── main card ──────────────────────────────────────────────────────────────

export const GenHit = memo(function GenHit(props: GenHitProps): ReactElement {
  const t = useT()
  const state = projectToolCall(props.block)
  const result = state.phase === 'completed' ? state.result : null
  const artifactKey = result?.artifact?.id ?? null

  // Resolve preview payload from the artifact (epoch-guarded).
  const [payload, setPayload] = useState<{
    phase: 'idle' | 'loading' | 'ready' | 'error' | 'missing'
    source: string | null
    bytes: Uint8Array | null
    filename: string | null
    error: string | null
  }>({ phase: 'idle', source: null, bytes: null, filename: null, error: null })

  useEffect(() => {
    if (state.phase !== 'completed' || !result || !artifactKey) return
    let cancelled = false
    setPayload({ phase: 'loading', source: null, bytes: null, filename: null, error: null })
    ;(async () => {
      try {
        // The artifact type decides the payload: a `zip` artifact is the full
        // KiCad project (sheets + footprints) → bytes for project rendering /
        // download; a `schematic` artifact is a single inline sheet → text.
        const artType = result?.artifact?.type ?? (result?.kind === 'system' ? 'zip' : 'schematic')
        if (artType === 'zip') {
          const art = await resolveArtifactBytes(artifactKey)
          if (cancelled) return
          setPayload({ phase: 'ready', source: null, bytes: art.bytes, filename: art.filename, error: null })
        } else {
          const art = await resolveArtifactText(artifactKey)
          if (cancelled) return
          setPayload({ phase: 'ready', source: art.text, bytes: null, filename: art.filename, error: null })
        }
      } catch (e) {
        if (!cancelled) {
          console.warn('[hq-schematic-gen] artifact resolve failed', e)
          setPayload({ phase: 'error', source: null, bytes: null, filename: null, error: String((e as Error)?.message || e) })
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactKey, state.phase])

  const [busy, setBusy] = useState<string | null>(null)
  // Outcome of the last Place attempt: 'ok' | 'error:<detail>'. Rendered as a
  // one-line status under the actions so the user knows the placement landed.
  const [placeStatus, setPlaceStatus] = useState<string | null>(null)
  // Outcome of the last "Open in EDA" attempt (host mode import via hq-edge).
  const [importStatus, setImportStatus] = useState<string | null>(null)

  function onDownload(): void {
    if (busy || payload.phase !== 'ready') return
    const kind = result?.kind ?? 'schematic'
    const filename = downloadFilenameFor(kind, result?.artifact ?? null, result?.designName ?? null)
    setBusy('download')
    try {
      // A bytes payload is the full project zip — download it as-is. A text
      // payload is a legacy inline sheet (no zip was stored) — download it as
      // plain text.
      if (payload.bytes) {
        downloadBytes(filename, payload.bytes)
      } else if (payload.source != null) {
        downloadText(filename, payload.source)
      }
    } finally {
      setBusy(null)
    }
  }

  /**
   * Open the generated project in the EDA editor. Host mode only: the browser
   * half posts the project zip (base64 in JSON — the edge-bridge proxy cannot
   * carry multipart) to hq-edge `POST /api/v1/import/kicad-b64`, which runs
   * the ImportDesign pipeline (extract → gRPC → EDA opens the design).
   */
  async function onOpenInEda(): Promise<void> {
    if (busy || payload.phase !== 'ready' || !payload.bytes) return
    const api = props.getHqEdge?.()?.api
    if (!api || typeof api.request !== 'function') return
    setBusy('open-in-eda')
    setImportStatus(null)
    try {
      const res = await api.request({
        method: 'POST',
        path: '/api/v1/import/kicad-b64',
        body: {
          zip_b64: bytesToBase64(payload.bytes),
          filename: payload.filename ?? 'design.zip',
          project_name: result?.designName ?? 'schematic',
          source_vendor: 'circuit_agent',
          source_format: 'kicad',
        },
      })
      const body = (res ?? {}) as {
        design_id?: string
        status?: string
        project_dir?: string
        project_name?: string
      }
      // hq-edge owns the final project directory — show the actual path the
      // design was opened from (falls back to the design id / status).
      setImportStatus(t('card.import.done', { id: body.project_dir ?? body.design_id ?? body.status ?? 'ok' }))
    } catch (e) {
      console.warn('[hq-schematic-gen] open-in-eda failed', e)
      setImportStatus(t('card.import.failed', { detail: String((e as Error)?.message || e) }))
    } finally {
      setBusy(null)
    }
  }

  function onRegenerate(): void {
    if (busy) return
    setBusy('regenerate')
    const kind = result?.kind ?? 'schematic'
    const prompt = kind === 'system' ? t('card.regeneratePrompt.system') : t('card.regeneratePrompt.schematic')
    const p = props.sendPrompt
      ? props.sendPrompt(props.sessionId, prompt)
      : Promise.reject(new Error('no prompt sender'))
    p.then(
      () => setBusy(null),
      (err) => { console.warn('[hq-schematic-gen] regenerate failed', err); setBusy(null) },
    )
  }

  /**
   * Place the generated design into the host EDA editor via HQ Edge.
   *
   * A system design sends ONE request (the project zip; HQ Edge derives the
   * root from the `*.kicad_pro` name — the same convention as the preview).
   * A multi-sheet schematic sends one request per sheet so every sheet lands
   * in the editor. Failures are collected and reported as a one-line status;
   * a partial success is explicitly surfaced, not swallowed.
   */
  function placeRequestsOf(): Array<{ artifactUri: string; filename: string | null }> {
    if (!result) return []
    // System kind: exactly one zip artifact (one request; HQ Edge derives the
    // root from the `*.kicad_pro` name inside the zip). Schematic kind: one
    // request per sheet. The wire shape is identical either way.
    return result.artifacts
      .filter((a) => a.uri)
      .map((a) => ({ artifactUri: a.uri!, filename: a.filename }))
  }

  async function onPlace(): Promise<void> {
    if (busy) return
    const support = placeSupportOf(props.getHqEdge, 'schematic')?.()
    if (!support) return
    const requests = placeRequestsOf()
    if (requests.length === 0) return
    setBusy('place')
    setPlaceStatus(null)
    let placed = 0
    const failures: string[] = []
    for (const req of requests) {
      try {
        await support.place({
          type: 'schematic',
          artifactUri: req.artifactUri,
          ...(req.filename ? { filename: req.filename } : {}),
        })
        placed++
      } catch (err) {
        const detail = String((err as Error)?.message || err)
        console.warn('[hq-schematic-gen] place failed', detail)
        failures.push(detail)
      }
    }
    setBusy(null)
    if (failures.length === 0) {
      setPlaceStatus(t('card.place.done', { count: placed }))
    } else if (placed > 0) {
      setPlaceStatus(t('card.place.partial', { placed, failed: failures.length }) + ' ' + failures[0])
    } else {
      setPlaceStatus(t('card.place.failed') + ' ' + failures[0])
    }
  }

  // needs_auth
  if (state.phase === 'needs_auth') {
    return <LoginCard toolName={props.toolName} authState={props.authState} t={t} getAuth={props.getAuth} />
  }

  // needs_subscription — no available GEN quota (auto-opens the subscription
  // dialog once; the subscribe button is always available).
  if (state.phase === 'needs_subscription') {
    return <SubscriptionCard result={state.result} t={t} getAuth={props.getAuth} />
  }

  const headerKind = result?.kind ?? kindOf(props.toolName)

  // generating — a run takes 10+ minutes, so show live progress rather than a
  // frozen label. `LiveProgress` owns its own polling and degrades to the
  // coarse stage ladder when the backend emits no trace events.
  if (state.phase === 'generating') {
    return (
      <div className="hq-sch">
        {header(headerKind, 'generating', t)}
        <LiveProgress callId={props.callId} kind={headerKind === 'system' ? 'system' : 'schematic'} t={t} />
      </div>
    )
  }

  // failed
  if (state.phase === 'failed') {
    return (
      <div className="hq-sch">
        {header(headerKind, 'failed', t)}
        <div className="hq-sch__error">{'message' in state ? state.message : t('card.error.toolFailed')}</div>
        <div className="hq-sch__actions">
          <button type="button" className="hq-sch__act" onClick={onRegenerate} disabled={busy === 'regenerate'}>
            ↻ {t('card.error.retry')}
          </button>
        </div>
      </div>
    )
  }

  // completed
  if (!result) {
    return <div className="hq-sch">{header(headerKind, 'failed', t)}</div>
  }

  let preview: ReactElement
  if (payload.phase === 'ready' && (payload.source != null || payload.bytes != null)) {
    const srcKey = artifactKey ?? 'preview'
    preview = (
      <PreviewStage
        payload={{ kind: result.kind === 'system' ? 'system' : 'schematic', source: payload.source, bytes: payload.bytes, srcKey }}
        t={t}
      />
    )
  } else if (payload.phase === 'loading') {
    preview = <div className="hq-sch__stage"><div className="hq-sch__stage-msg">{t('card.preview.loading')}</div></div>
  } else if (payload.phase === 'error') {
    preview = <div className="hq-sch__stage"><div className="hq-sch__stage-msg">{t('card.preview.resolveError')}{payload.error}</div></div>
  } else {
    preview = <div className="hq-sch__stage"><div className="hq-sch__stage-msg">{t('card.preview.missing')}</div></div>
  }

  const canDownload = payload.phase === 'ready' && (payload.source != null || payload.bytes != null)
  // Place is offered only when the host provides hqEdge, the current editor
  // accepts schematics (frontend matrix; HQ Edge re-enforces server-side) and
  // the node half resolved at least one artifact uri.
  const placeSupport = placeSupportOf(props.getHqEdge, 'schematic')
  const placeableCount = result.artifacts.filter((a) => a.uri).length
  const canPlace = !!placeSupport?.() && placeableCount > 0
  // Open in EDA (host mode): available when the edge-bridge proxy exists and a
  // project zip is present in the card (both system and schematic results
  // store the zip as the single source of truth).
  const canOpenInEda = payload.phase === 'ready' && payload.bytes != null &&
    !!props.getHqEdge?.()?.api?.request

  return (
    <div className="hq-sch">
      {header(result.kind, 'completed', t)}
      {summary(result, t)}
      {preview}
      {result.note ? <div className="hq-sch__note">{result.note}</div> : null}
      <div className="hq-sch__actions">
        <button type="button" className="hq-sch__act" onClick={onDownload} disabled={!canDownload || busy === 'download'}>
          ⭳ {busy === 'download' ? t('card.action.downloading') : t('card.action.download')}
        </button>
        {canOpenInEda
          ? (
            <button type="button" className="hq-sch__act" onClick={onOpenInEda} disabled={busy === 'open-in-eda'}>
              ⇱ {busy === 'open-in-eda' ? t('card.action.openingInEda') : t('card.action.openInEda')}
            </button>
          )
          : null}
        {canPlace
          ? (
            <button type="button" className="hq-sch__act" onClick={onPlace} disabled={busy === 'place'}>
              ⇥ {busy === 'place' ? t('card.action.placing') : t('card.action.place')}
            </button>
          )
          : null}
        <button type="button" className="hq-sch__act" onClick={onRegenerate} disabled={busy === 'regenerate'}>
          ↻ {busy === 'regenerate' ? t('card.action.regenerating') : t('card.action.regenerate')}
        </button>
        {typeof props.inspect === 'function'
          ? <button type="button" className="hq-sch__act" onClick={() => props.inspect?.()}>{t('card.action.inspect')}</button>
          : null}
      </div>
      {importStatus ? <div className="hq-sch__note">{importStatus}</div> : null}
      {placeStatus ? <div className="hq-sch__note">{placeStatus}</div> : null}
    </div>
  )
})
