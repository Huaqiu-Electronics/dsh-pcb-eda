/**
 * `@huaqiu/dsh-tool-schematic-gen` — browser half (the schematic/system HIT).
 *
 * Registers keyed `tool.call.toolview` entries for both
 * `generate_schematic_from_description` and `generate_system_module_graph`,
 * replacing the stock JSON fallback (and the auth plugin's generic row) with
 * the `GenHit` card: header → summary → ECAD canvas preview (single sheet for
 * the schematic tool, project zip root sheet for the system tool) → actions.
 *
 * The authoritative state comes from DSH itself: the frozen `ToolCallBlock` is
 * projected by the pure `projectToolCall()` into a single phase. Human answers
 * ("regenerate") are sent back to the agent through
 * `sessions.binding(sessionId).session.prompt`, so the node `ask()` stays the
 * single source of truth.
 *
 * ── Composer integration ────────────────────────────────────────────────────
 * This half also contributes a `Schematic Gen` sidebar toolbutton. Clicking it
 * inserts a genuine `@ Generate schematic` reference chip into the current
 * session's composer through the public session-input facade — no standalone
 * workspace, no DOM forgery. The chip's owner is the `@schematic-gen` trigger
 * source registered here, whose codec turns the chip into explicit
 * schematic-generation intent in the user message at submit time.
 */
import { createElement, useEffect, useState, type ComponentType } from 'react'
import { GenHit } from './hit-card.jsx'
import { injectStyles, removeStyles, disposeThemeObserver, installSchematicUncollapser } from './theme.js'
import { registerSchematicGenSource, schematicGenLabel } from './schematic-ref.js'
import { detectHostLocale } from '@huaqiu/dsh-sidebar-entry'
import {
  insertSchematicChip,
  type ChipInserterDeps,
  type ConversationLike,
  type SessionsLike,
} from './composer-chip.js'
import { mountSchematicGenSidebarEntry } from './sidebar-entry.js'
import type { AuthStateLike, PromptSender } from './hit-card.jsx'
import type { HqEdgePlaceLike } from './place.js'

export type { AuthStateLike, PromptSender }

const TOOLVIEW_KEYS = [
  'generate_schematic_from_description',
  'generate_system_module_graph',
] as const

/**
 * Client cordis inject: REAL service names only.
 *
 * `huaqiuAuth` is the client service provided by `@huaqiu/dsh-auth`. It is the
 * ONLY sanctioned source of login state — this plugin must not read the
 * credential cache itself (spec §10). Reading `localStorage` directly would
 * duplicate the storage key and the expiry rule, and would report the user as
 * permanently logged out whenever `@huaqiu/dsh-auth` runs in HQ Edge host mode
 * (where there is no browser-side credential cache at all).
 *
 * `conversation` and `inputTriggers` are the public DSH services behind the
 * composer-chip integration. They are listed here so DSH holds this plugin's
 * activation until they exist, but every read is still guarded: a standalone
 * DSH deployment that lacks one must not take the client half down.
 */
export const inject: string[] = [
  'slots', 'sessions', 'huaqiuAuth', 'conversation', 'inputTriggers',
]

/** Minimal structural client context (dsh-client-runtime provides these). */
export interface ClientContext {
  provide?(name: string, value: unknown): () => void
  slots?: {
    inject(key: string, callback: () => () => void): () => void
    register(spec: { name: string; key?: string; id?: string }, component: unknown): unknown
  }
  get<T = unknown>(name: string): T | undefined
  effect?(fn: () => (() => void) | void, label?: string): void
}

/**
 * Structural view of the `huaqiuAuth` CLIENT service (`@huaqiu/dsh-auth`).
 *
 * Declared structurally, never imported: each package must remain
 * independently installable. `nickname` is optional because the HQ Edge host
 * contract may not supply one.
 */
export interface HuaqiuAuthClientService {
  auth?: {
    isAuthenticated(): boolean
    getUserInfo(): Promise<{ nickname?: string } | null>
    onAuthStateChanged(listener: (info: { nickname?: string } | null) => void): () => void
  }
}

const LOGGED_OUT: AuthStateLike = { authenticated: false }

/**
 * Browser-console tag for the client half's lifecycle.
 *
 * One line at `apply()` time is what tells you WHICH bundle is live: the
 * pre-localization build emits nothing at all, so "no `client` line in the
 * console" means the materialized plugin is stale, not that the click handler
 * is broken.
 */
const CLIENT_TRACE = '[schematic-gen:client]'

function traceClient(event: string, payload?: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.debug(CLIENT_TRACE, event, payload ?? '')
  } catch {
    /* a non-console host must never break the composer */
  }
}

function stateOf(info: { nickname?: string } | null): AuthStateLike {
  if (!info) return LOGGED_OUT
  return {
    authenticated: true,
    ...(info.nickname ? { nickname: info.nickname } : {}),
  }
}

/**
 * Subscribe to the `huaqiuAuth` client service.
 *
 * Built as a hook rather than a plain read because the service resolves
 * credentials asynchronously (`getUserInfo()`), while the card renders
 * synchronously. The first paint uses the cheap synchronous
 * `isAuthenticated()` so the card never flashes "logged out"; the effect then
 * resolves the full payload once and follows every subsequent change.
 */
function createUseAuthState(auth: HuaqiuAuthClientService['auth'] | undefined): () => AuthStateLike {
  return function useAuthState(): AuthStateLike {
    const [state, setState] = useState<AuthStateLike>(() => ({
      authenticated: auth?.isAuthenticated() ?? false,
    }))

    useEffect(() => {
      if (!auth) {
        setState(LOGGED_OUT)
        return
      }
      let alive = true
      void auth.getUserInfo()
        .then((info) => { if (alive) setState(stateOf(info)) })
        .catch(() => { if (alive) setState(LOGGED_OUT) })
      const off = auth.onAuthStateChanged((info) => {
        if (alive) setState(stateOf(info))
      })
      return () => {
        alive = false
        off()
      }
    }, [])

    return state
  }
}

/**
 * Build the lazy service accessors the composer inserter needs.
 *
 * Nothing is captured once: `conversation` and `sessions` may materialize
 * after this plugin (and the user may switch sessions between clicks), so the
 * click always reads the live services.
 */
export function createChipInserterDeps(ctx: ClientContext): ChipInserterDeps {
  return {
    getConversation: () => ctx.get('conversation') as never,
    getSessions: () => ctx.get('sessions') as never,
  }
}

export function apply(ctx: ClientContext): () => void {
  const disposers: Array<() => void> = []

  traceClient('apply', {
    // Resolved at load: the chip labels this build can render, and the host
    // language it currently sees. A mismatch between the two is the bug.
    zhLabel: schematicGenLabel('zh'),
    enLabel: schematicGenLabel('en'),
    hostLang: detectHostLocale() ?? null,
    htmlLang: document.documentElement?.getAttribute('lang') ?? null,
  })

  const authService = ctx.get<HuaqiuAuthClientService | undefined>('huaqiuAuth')
  const useAuthState = createUseAuthState(authService?.auth)

  // Lazy `hqEdge` accessor for the Place action. NOT captured once: the
  // edge-bridge plugin may load after this one, and a click should see the
  // service as soon as it exists. Undefined in standalone DSH (no edge-bridge)
  // — the card then simply hides Place.
  const getHqEdge = () => ctx.get<HqEdgePlaceLike | undefined>('hqEdge')

  const sendPrompt: PromptSender = (sessionId, message) => {
    const sessions = ctx.get<{ binding(id: string): { session: { prompt(content: Array<{ type: 'text'; text: string }>, mode: 'queue'): Promise<unknown> } } | undefined }>('sessions')
    if (!sessions || typeof sessions.binding !== 'function' || !sessionId) {
      return Promise.reject(new Error('no session conversation channel'))
    }
    const binding = sessions.binding(sessionId)
    const session = binding?.session
    if (!session || typeof session.prompt !== 'function') {
      return Promise.reject(new Error('no session conversation channel'))
    }
    return session.prompt([{ type: 'text', text: message }], 'queue')
  }

  // ── Composer integration ────────────────────────────────────────────────
  // 1. The trigger source. MANDATORY: DSH's submit plane rejects a chip whose
  //    owner has no codec, which would block the user's send outright. It also
  //    makes the chip reachable by typing `@`.
  disposers.push(registerSchematicGenSource(ctx.get('inputTriggers')))

  // 2. The sidebar toolbutton. Clicking it inserts the chip; it never opens a
  //    workspace. A missing session or a busy composer is reported through the
  //    composer's own notice channel rather than thrown.
  const chipDeps = createChipInserterDeps(ctx)
  disposers.push(mountSchematicGenSidebarEntry({
    onToggle: () => {
      // Traced here (not only inside the inserter) so a click that never
      // reaches the composer is distinguishable from one that reached it and
      // was refused — the two look identical from the UI.
      traceClient('sidebar-click')
      const result = insertSchematicChip(chipDeps)
      traceClient('sidebar-click:result', result)
      // 'already-present' is the idempotent case, not a failure: a second
      // click on a draft that already carries the chip is a no-op.
      if (result.ok || result.reason === 'already-present') return
      notifyComposer(ctx, result.reason)
    },
    position: 'after',
  }))

  const slots = ctx.slots
  if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    const GenHitView: ComponentType<{
      toolName?: string
      block?: unknown
      sessionId?: string
      /**
       * Published as part of `ToolCallOwnerProps` and stable across the
       * running and settled forms. Forwarded so the card can correlate with
       * the node half's progress store.
       */
      callId?: string
      inspect?: () => void
    }> = (props) =>
      createElement(GenHit, {
        ...props,
        toolName: props.toolName ?? '',
        block: props.block as never,
        sessionId: props.sessionId,
        callId: props.callId,
        sendPrompt,
        authState: useAuthState(),
        getHqEdge,
        getAuth: () => authService,
      })

    for (const toolName of TOOLVIEW_KEYS) {
      disposers.push(slots.inject('tool.call.toolview', () => slots.register(
        { name: 'tool.call.toolview', key: toolName },
        GenHitView,
      ) as () => void))
    }
  }

  injectStyles()
  const uncollapseDispose = installSchematicUncollapser()

  const cleanup = (): void => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
    disposers.length = 0
    uncollapseDispose()
    removeStyles()
    disposeThemeObserver()
  }
  if (ctx.effect) ctx.effect(() => cleanup, 'schematic-gen: HIT dispose')
  return cleanup
}

/**
 * Surface why a chip insertion did not happen, through the composer's own
 * notice channel when it is available.
 *
 * Best-effort by design: a failure to insert is never worth taking the plugin
 * down, and there is no sanctioned surface for a sidebar-owned transient
 * message beyond this notice store.
 */
function notifyComposer(ctx: ClientContext, reason: string): void {
  try {
    const sessions = ctx.get<SessionsLike>('sessions')
    const conversation = ctx.get<ConversationLike>('conversation')
    if (sessions === undefined) return
    const sessionId = sessions.list?.getSnapshot().current
    if (sessionId === undefined || sessionId === null || sessionId === '') return
    if (conversation?.input === undefined) return
    const actx = sessions.scope?.(sessionId) ?? sessions.binding?.(sessionId)?.ctx
    if (actx === undefined || actx === null) return
    const input = conversation.input.for(actx) as { notify?: (level: 'info' | 'error', text: string) => void } | undefined
    input?.notify?.('info', noticeFor(reason))
  } catch {
    // Notice delivery is strictly optional.
  }
}

/** Human-readable notice text for one insertion failure reason. */
function noticeFor(reason: string): string {
  switch (reason) {
    case 'no-session': return 'Open a conversation first, then click Schematic Gen again.'
    case 'busy': return 'The composer is busy — try again once the current message settles.'
    case 'conflict': return 'The composer changed while inserting — click Schematic Gen again.'
    default: return 'Schematic Gen is unavailable in this session.'
  }
}
