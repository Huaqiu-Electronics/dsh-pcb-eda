/**
 * `@huaqiu/dsh-tool-schematic-gen` — programmatic composer chip insertion.
 *
 * The public path is `ctx.conversation.input.for(actx).insertReference(ref,
 * span)` — a verb on DSH's frozen `SessionInput` face, reached through two
 * public services (`conversation`, `sessions`). No DOM forgery, no new public
 * API, no DSH source change.
 *
 * Two coordinate systems are in play and mixing them silently misplaces the
 * chip:
 *
 * - `InputState.draft` and `Occurrence.offset|length` are CLIPBOARD
 *   coordinates — a chip occupies its whole `clipboardText`.
 * - `TokenSpan` is DETECT coordinates — a chip is exactly one `U+FFFC`.
 *
 * `insertReference` is span-CAS'd (`span.draftRev !== this.rev → false`) and
 * refuses busy phases, so every call reads a fresh snapshot and retries once.
 *
 * @module
 */
import {
  SCHEMATIC_GEN_REF, SCHEMATIC_GEN_SOURCE,
  schematicGenInsert,
  type ReferenceInsertLike,
} from './schematic-ref.js'

/** Browser-console tag for the insertion path (see schematic-ref.ts). */
const TRACE = '[schematic-gen:chip]'

/** Emit one trace line. Never throws. */
function trace(event: string, payload?: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.debug(TRACE, event, payload ?? '')
  } catch {
    /* a non-console host must never break the composer */
  }
}

/** Why an insertion attempt did not produce a chip. */
export type InsertFailure =
  /** No current session — nothing was touched. */
  | 'no-session'
  /** `conversation` / `sessions` unavailable (standalone DSH, early boot). */
  | 'unavailable'
  /** The composer is adjudicating or submitting; inserting would race the send. */
  | 'busy'
  /** Two fresh snapshots both lost the revision CAS. */
  | 'conflict'
  /** The draft already carries our chip. */
  | 'already-present'

/** Outcome of one insertion attempt. */
export type InsertResult = { readonly ok: true } | { readonly ok: false; readonly reason: InsertFailure }

/** Structural view of one chip occurrence in the live draft (clipboard coords). */
export interface OccurrenceLike {
  readonly source?: string
  readonly ref?: string
  readonly offset?: number
  readonly length?: number
}

/** Structural view of `InputState` (the published composer snapshot). */
export interface InputStateLike {
  /** Clipboard-text projection of the draft. */
  readonly draft?: string
  /** Monotonic editor revision the span CAS compares against. */
  readonly draftRev?: number
  readonly phase?: string
  readonly occurrences?: readonly OccurrenceLike[]
}

/** Structural view of DSH's per-session input facade (`SessionInput`). */
export interface SessionInputLike {
  readonly state?: { getSnapshot(): InputStateLike }
  insertReference?(ref: ReferenceInsertLike, span: { readonly start: number; readonly end: number; readonly draftRev: number }): boolean
}

/** Structural view of `ctx.conversation` (only the face we use). */
export interface ConversationLike {
  readonly input?: {
    for(actx: unknown): SessionInputLike | undefined
  }
}

/** Structural view of `ctx.sessions` (only the face we use). */
export interface SessionsLike {
  readonly list?: { getSnapshot(): { readonly current?: string | undefined } }
  /** Resolve an Agent-scoped context view (use-and-discard). */
  scope?(id: string): unknown
  binding?(id: string): { readonly ctx?: unknown } | undefined
}

/** The services the inserter needs, resolved lazily on every call. */
export interface ChipInserterDeps {
  getConversation(): ConversationLike | undefined
  getSessions(): SessionsLike | undefined
}

/**
 * Translate a clipboard-projected draft length into DETECT coordinates.
 *
 * Every existing chip shrinks from `length` clipboard characters to one detect
 * character, so the detect length is the clipboard length minus the sum of
 * `length - 1` over all occurrences. A draft with no chips is unchanged.
 *
 * @param state - the fresh input snapshot.
 * @returns the detect-coordinate length of the whole draft.
 */
export function detectLengthOf(state: InputStateLike): number {
  const draft = typeof state.draft === 'string' ? state.draft : ''
  const occurrences = Array.isArray(state.occurrences) ? state.occurrences : []
  let shrink = 0
  for (const occurrence of occurrences) {
    const length = typeof occurrence.length === 'number' ? occurrence.length : 0
    // Guard against a malformed snapshot: a shorter-than-one chip would
    // otherwise inflate the result and push the chip past the document end.
    if (length > 1) shrink += length - 1
  }
  return Math.max(0, draft.length - shrink)
}

/** Whether the draft already carries our chip. */
export function hasSchematicChip(state: InputStateLike): boolean {
  const occurrences = Array.isArray(state.occurrences) ? state.occurrences : []
  return occurrences.some(o => o.source === SCHEMATIC_GEN_SOURCE && o.ref === SCHEMATIC_GEN_REF)
}

/** Phases in which `insertReference` refuses to edit. */
const BUSY_PHASES: readonly string[] = ['adjudicating', 'submitting']

/**
 * Insert the `Generate schematic` chip at the end of the current draft.
 *
 * Never throws and never partially edits: every failure leaves the draft
 * exactly as it was.
 *
 * @param deps - lazy service accessors (resolved per call, never captured).
 * @param insert - the reference to insert (defaults to the schematic-gen one,
 *                 whose label is resolved against the host language at call
 *                 time — so the chip matches the UI language, not a frozen
 *                 English literal).
 * @returns whether a chip landed, and why not when it did not.
 */
export function insertSchematicChip(
  deps: ChipInserterDeps,
  insert: ReferenceInsertLike = schematicGenInsert(),
): InsertResult {
  const sessions = deps.getSessions()
  const conversation = deps.getConversation()
  if (sessions === undefined || conversation === undefined || conversation.input === undefined) {
    trace('unavailable', { hasSessions: sessions !== undefined, hasConversation: conversation !== undefined })
    return { ok: false, reason: 'unavailable' }
  }

  let sessionId: string | undefined
  try {
    sessionId = sessions.list?.getSnapshot().current
  } catch {
    sessionId = undefined
  }
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    return { ok: false, reason: 'no-session' }
  }

  // `scope()` is the documented "resolve an Agent-scoped context view"; the
  // binding's own ctx is the fallback for hosts that prune scopes eagerly.
  let actx: unknown
  try {
    actx = sessions.scope?.(sessionId) ?? sessions.binding?.(sessionId)?.ctx
  } catch {
    actx = undefined
  }
  if (actx === undefined || actx === null) return { ok: false, reason: 'no-session' }

  let input: SessionInputLike | undefined
  try {
    input = conversation.input.for(actx)
  } catch {
    input = undefined
  }
  if (input === undefined || typeof input.insertReference !== 'function') {
    return { ok: false, reason: 'unavailable' }
  }

  // Two attempts: a fresh snapshot each time, so a revision bump between read
  // and write costs one retry and never a misplaced chip.
  trace('inserting', { label: insert.label, clipboardText: insert.clipboardText })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = input.state?.getSnapshot() ?? {}
    if (hasSchematicChip(state)) {
      trace('already-present')
      return { ok: false, reason: 'already-present' }
    }

    const phase = state.phase ?? 'plain'
    if (BUSY_PHASES.includes(phase)) {
      trace('busy', { phase })
      return { ok: false, reason: 'busy' }
    }

    const draftRev = typeof state.draftRev === 'number' ? state.draftRev : 0
    const end = detectLengthOf(state)
    let applied = false
    try {
      applied = input.insertReference(insert, { start: end, end, draftRev })
    } catch (err) {
      trace('insertReference threw', err instanceof Error ? err.message : err)
      applied = false
    }
    if (applied) {
      trace('inserted', { label: insert.label, span: { start: end, end, draftRev } })
      return { ok: true }
    }
    trace('cas-miss', { attempt })
  }

  trace('conflict')
  return { ok: false, reason: 'conflict' }
}
