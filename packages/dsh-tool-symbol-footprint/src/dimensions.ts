/**
 * `@huaqiu/dsh-tool-symbol-footprint` — package dimensions & the human-in-the-
 * loop helpers.
 *
 * Port of the `hq-edge` plugin's dimension normalization / override parsing /
 * HIL prompting, kept dependency-free for unit testing.
 *
 * HIL note (kept from the original): the interactive dimension confirmation is
 * owned by the web client card (`needs_confirmation` result), so
 * `confirmDimensionsWithHuman` is retained as the degraded-path helper and the
 * direct-footprint accept/decline gate remains on the user-questions seam.
 *
 * @module @huaqiu/dsh-tool-symbol-footprint
 */
import {
  HITL_LABELS,
  hitlT,
  resolveHitlLocale,
  type HitlLocale,
  type HitlTranslate,
} from './hitl-i18n.js'

/** Normalized `footprint_dimensions` context shape. */
export interface ExtractedDimensions {
  fileName: string | null
  pkgType: string | null
  dimensions: Record<string, string | number | boolean>
}

export interface DimensionOverridesResult {
  overrides: Record<string, string | number | boolean>
  unknownKeys: string[]
  badValues: string[]
}

/**
 * Normalize the `footprint_dimensions` AGENT context into a stable shape
 * (`{ fileName, pkgType, dimensions }`). Only scalars are editable values;
 * nested structures are passed through untouched.
 */
export function normalizeDimensions(context: unknown): ExtractedDimensions {
  const body = (context && typeof context === 'object' ? context : {}) as {
    fileName?: unknown
    pkgType?: unknown
    dimensions?: unknown
  }
  const raw = body.dimensions && typeof body.dimensions === 'object' ? body.dimensions as Record<string, unknown> : {}
  const dimensions: Record<string, string | number | boolean> = {}
  for (const key of Object.keys(raw)) {
    const value = raw[key]
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      dimensions[key] = value
    }
  }
  return {
    fileName: typeof body.fileName === 'string' ? body.fileName : null,
    pkgType: typeof body.pkgType === 'string' ? body.pkgType : null,
    dimensions,
  }
}

/**
 * Parse a human's free-text correction into dimension overrides.
 *
 * Accepts `key=value` or `key: value` pairs separated by commas, semicolons or
 * newlines — e.g. `W=6.2, L = 5.0; pitch: 1.27`.
 *
 * Two deliberate refusals:
 *   - a key the extractor did not return is NOT applied; it is reported.
 *   - an invalid value for a typed slot is NOT applied; it is reported.
 */
export function parseDimensionOverrides(
  text: string,
  current: Record<string, string | number | boolean>,
): DimensionOverridesResult {
  const overrides: Record<string, string | number | boolean> = {}
  const unknownKeys: string[] = []
  const badValues: string[] = []
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { overrides, unknownKeys, badValues }
  }
  const base = current && typeof current === 'object' ? current : {}
  // Case-insensitive index so `w=6.2` matches an extracted `W`.
  const index = new Map<string, string>()
  for (const key of Object.keys(base)) index.set(key.toLowerCase(), key)

  for (const piece of text.split(/[,;\n\r]+/)) {
    const trimmed = piece.trim()
    if (trimmed.length === 0) continue
    const match = /^([^=:]+)\s*[=:]\s*(.+)$/.exec(trimmed)
    if (match === null) continue // prose the human added around the values
    const rawKey = match[1]!.trim()
    const rawValue = match[2]!.trim()
    const key = index.get(rawKey.toLowerCase())
    if (key === undefined) {
      unknownKeys.push(rawKey)
      continue
    }
    if (typeof base[key] === 'number') {
      const numeric = Number(rawValue)
      if (!Number.isFinite(numeric)) {
        badValues.push(rawKey + '=' + rawValue)
        continue
      }
      overrides[key] = numeric
      continue
    }
    if (typeof base[key] === 'boolean') {
      const normalized = rawValue.toLowerCase()
      if (normalized !== 'true' && normalized !== 'false') {
        badValues.push(rawKey + '=' + rawValue)
        continue
      }
      overrides[key] = normalized === 'true'
      continue
    }
    overrides[key] = rawValue
  }
  return { overrides, unknownKeys, badValues }
}

/**
 * Render dimensions as `key = value` lines for a confirmation prompt.
 *
 * @param locale - UI language for the empty-state line; see `hitl-i18n.ts`.
 */
export function renderDimensionsForHuman(
  dimensions: Record<string, string | number | boolean>,
  locale?: HitlLocale,
): string {
  const keys = Object.keys(dimensions || {})
  if (keys.length === 0) return hitlT(locale)('render.empty')
  return keys.map((key) => key + ' = ' + String(dimensions[key])).join('\n')
}

/**
 * Option labels of the confirmation question — also the answer vocabulary.
 *
 * These stay ENGLISH for backwards compatibility (they are part of the
 * module's public surface and of the answer check below). A localized run
 * renders `HIL_LABELS[locale]` instead; `matchesAny()` accepts either, so a
 * host that echoes back the English constant still resolves correctly.
 */
export const HIL_CONFIRM = 'Confirm'
export const HIL_EDIT = 'Edit values'
export const HIL_CANCEL = 'Cancel'
/** Option labels for the direct-footprint (service auto-generated) question. */
export const HIL_ACCEPT = 'Accept'
export const HIL_DECLINE = 'Decline'

/**
 * Localized answer vocabulary, keyed by locale.
 *
 * Re-exported from `hitl-i18n.js` (where it is derived from the copy packs)
 * so the HIL_* names stay together in this module's public surface. The `en`
 * row equals the `HIL_*` constants below — `HITL_LABELS` is the single source,
 * and a test asserts the two agree.
 */
export const HIL_LABELS = HITL_LABELS

/**
 * Does the human's selection include any of `candidates`?
 *
 * Trimmed and case-insensitive, and every locale's label for the same action
 * is passed in — so a host echoing the English constant, the localized label,
 * or a differently-cased version all resolve to the same verdict.
 */
function matchesAny(selected: string[], candidates: string[]): boolean {
  if (selected.length === 0) return false
  const wanted = new Set(candidates.map((c) => c.trim().toLowerCase()))
  for (const value of selected) {
    if (wanted.has(String(value).trim().toLowerCase())) return true
  }
  return false
}

/** Cancel / decline in every locale, plus the English constants. */
function cancelCandidates(t: HitlTranslate): string[] {
  return [HIL_LABELS.zh.cancel, HIL_LABELS.en.cancel, t('confirm.opt.cancel')]
}
function declineCandidates(t: HitlTranslate): string[] {
  return [HIL_LABELS.zh.decline, HIL_LABELS.en.decline, t('direct.opt.decline')]
}
function editCandidates(t: HitlTranslate): string[] {
  return [HIL_LABELS.zh.edit, HIL_LABELS.en.edit, t('confirm.opt.edit')]
}

/** Minimal structural shape of the `userQuestions.ask()` result we consume. */
export interface UserQuestionAnswer {
  answers?: Array<{ selected?: string[]; custom?: string }>
}

export interface UserQuestionsLike {
  ask(options: Record<string, unknown>): Promise<UserQuestionAnswer>
}

export interface ExecutionLike {
  agent?: unknown
  signal?: AbortSignal
  /**
   * UI language for the human-in-the-loop prompt copy. Accepts a locale id or
   * a BCP-47 tag (`zh-CN`, `en-US`); anything unresolved falls back to the
   * package default (zh) — see `hitl-i18n.ts`.
   */
  locale?: HitlLocale | string
}

export type DimensionConfirmResult =
  | { verdict: 'cancelled'; dimensions: Record<string, string | number | boolean>; edited: false; unknownKeys: string[]; badValues: string[] }
  | { verdict: 'confirmed'; dimensions: Record<string, string | number | boolean>; edited: boolean; unknownKeys: string[]; badValues: string[] }

/**
 * The human-in-the-loop step for extracted dimensions: show them and take back
 * a verdict plus, when the human edits, their corrected values.
 *
 * Kept from the original as the degraded-channel helper; the primary path is
 * the web-client dimension card (the tool returns `needs_confirmation`).
 */
export async function confirmDimensionsWithHuman(
  userQuestions: UserQuestionsLike,
  extracted: ExtractedDimensions,
  exec?: ExecutionLike,
): Promise<DimensionConfirmResult> {
  const locale = resolveHitlLocale(exec?.locale)
  const t = hitlT(locale)
  const labels = HIL_LABELS[locale]
  const pkg = extracted.pkgType ? extracted.pkgType.toUpperCase() : t('confirm.pkgFallback')
  const detail = t('confirm.detail', {
    pkg,
    dims: renderDimensionsForHuman(extracted.dimensions, locale),
    edit: labels.edit,
  })

  const askOptions: Record<string, unknown> = {
    questions: [{
      id: 'footprint-dimensions',
      header: t('header'),
      question: t('confirm.question', { pkg }),
      detail,
      options: [
        { label: labels.confirm, description: t('confirm.opt.confirm.desc') },
        { label: labels.edit, description: t('confirm.opt.edit.desc') },
        { label: labels.cancel, description: t('confirm.opt.cancel.desc') },
      ],
    }],
  }
  if (exec && exec.agent !== undefined) askOptions.agent = exec.agent
  if (exec && exec.signal !== undefined) askOptions.signal = exec.signal

  const answer = await userQuestions.ask(askOptions)
  const first = answer && Array.isArray(answer.answers) ? answer.answers[0] : undefined
  const selected = first && Array.isArray(first.selected) ? first.selected : []
  const custom = first && typeof first.custom === 'string' ? first.custom : ''

  if (matchesAny(selected, cancelCandidates(t))) {
    return { verdict: 'cancelled', dimensions: extracted.dimensions, edited: false, unknownKeys: [], badValues: [] }
  }

  // Free text always counts as an edit, whichever option was highlighted.
  let correction = custom
  if (correction.trim().length === 0 && matchesAny(selected, editCandidates(t))) {
    const followUpOptions: Record<string, unknown> = {
      questions: [{
        id: 'footprint-dimensions-edit',
        header: t('header'),
        question: t('confirm.edit.question'),
        detail: renderDimensionsForHuman(extracted.dimensions, locale),
      }],
    }
    if (exec && exec.agent !== undefined) followUpOptions.agent = exec.agent
    if (exec && exec.signal !== undefined) followUpOptions.signal = exec.signal
    const followUp = await userQuestions.ask(followUpOptions)
    const followFirst = followUp && Array.isArray(followUp.answers) ? followUp.answers[0] : undefined
    if (followFirst && typeof followFirst.custom === 'string') correction = followFirst.custom
    else if (followFirst && Array.isArray(followFirst.selected) && followFirst.selected.length > 0) {
      correction = followFirst.selected.join(', ')
    }
  }

  const parsed = parseDimensionOverrides(correction, extracted.dimensions)
  const applied = Object.keys(parsed.overrides)
  return {
    verdict: 'confirmed',
    dimensions: Object.assign({}, extracted.dimensions, parsed.overrides),
    edited: applied.length > 0,
    unknownKeys: parsed.unknownKeys,
    badValues: parsed.badValues,
  }
}

export type DirectFootprintDecision = { verdict: 'accepted' } | { verdict: 'declined' }

/**
 * The human-in-the-loop step for the case where the service recognised a
 * standard package and returned a `footprint_button` DIRECTLY from
 * `agent.footprint.dimensions.generate` — bypassing dimension extraction.
 */
export async function confirmDirectFootprintWithHuman(
  userQuestions: UserQuestionsLike,
  generated: { fileUrl?: string },
  exec?: ExecutionLike,
): Promise<DirectFootprintDecision> {
  const locale = resolveHitlLocale(exec?.locale)
  const t = hitlT(locale)
  const labels = HIL_LABELS[locale]
  const askOptions: Record<string, unknown> = {
    questions: [{
      id: 'footprint-direct',
      header: t('header'),
      question: t('direct.question'),
      detail: t('direct.detail', {
        file: generated.fileUrl || t('direct.unknown'),
        accept: labels.accept,
        decline: labels.decline,
      }),
      options: [
        { label: labels.accept, description: t('direct.opt.accept.desc') },
        { label: labels.decline, description: t('direct.opt.decline.desc') },
      ],
    }],
  }
  if (exec && exec.agent !== undefined) askOptions.agent = exec.agent
  if (exec && exec.signal !== undefined) askOptions.signal = exec.signal

  const answer = await userQuestions.ask(askOptions)
  const first = answer && Array.isArray(answer.answers) ? answer.answers[0] : undefined
  const selected = first && Array.isArray(first.selected) ? first.selected : []

  if (matchesAny(selected, declineCandidates(t))) {
    return { verdict: 'declined' }
  }
  return { verdict: 'accepted' }
}
