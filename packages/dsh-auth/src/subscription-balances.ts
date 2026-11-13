/**
 * Single authoritative contract for the subscription-balances API
 * (`GET /sub-api/subscriptions/balances/current`).
 *
 * Both halves import these types (the browser half type-only), and the node
 * half's parser is the ONE place an upstream payload is turned into usage data.
 * There must be no second response shape, no second parser and no locally
 * derived percentage: `quotaRemainPercent` is the only source of truth.
 *
 * This module is intentionally dependency-free so the browser bundle can import
 * the types without pulling node modules in.
 */

/** One quota group in `result[]` (AI and non-AI groups share this shape). */
export interface SubscriptionBalanceGroup {
  id: number
  groupCode: string
  groupName: string
  quotaTotal: number | null
  quotaUsed: number | null
  quotaRemain: number | null
  /** Remaining percentage. `null` for groups that do not report one. */
  quotaRemainPercent: number | null
  /** `true` ONLY for the AI Points group — the discriminator. */
  aiPoints: boolean
  status: number
}

/** The upstream envelope. */
export interface SubscriptionBalancesResponse {
  code: number
  message: string
  result: SubscriptionBalanceGroup[]
}

/** Client-facing view: only the authoritative remaining percentage. */
export interface AiUsage {
  quotaRemainPercent: number | null
}

/** The only success code accepted from the subscription balances API. */
export const SUBSCRIPTION_BALANCES_SUCCESS_CODE = 200000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `null`/missing/non-numeric → `null` (never a coerced 0). */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseGroup(raw: unknown): SubscriptionBalanceGroup | null {
  const group = asRecord(raw)
  if (!group) return null
  // `aiPoints` is the ONLY AI-group discriminator. A non-boolean value makes
  // the payload unusable: guessing would risk showing a non-AI group.
  if (typeof group.aiPoints !== 'boolean') return null
  return {
    id: numberOf(group.id),
    groupCode: stringOf(group.groupCode),
    groupName: stringOf(group.groupName),
    quotaTotal: numberOrNull(group.quotaTotal),
    quotaUsed: numberOrNull(group.quotaUsed),
    quotaRemain: numberOrNull(group.quotaRemain),
    quotaRemainPercent: numberOrNull(group.quotaRemainPercent),
    aiPoints: group.aiPoints,
    status: numberOf(group.status),
  }
}

/**
 * Validate an upstream payload against the authoritative schema.
 * Returns `null` for a non-2xx-style envelope, a non-array `result`, or any
 * malformed group — callers degrade to "unavailable" rather than guessing.
 */
export function parseSubscriptionBalancesResponse(
  payload: unknown,
): SubscriptionBalancesResponse | null {
  const body = asRecord(payload)
  if (!body) return null
  if (body.code !== SUBSCRIPTION_BALANCES_SUCCESS_CODE) return null
  if (!Array.isArray(body.result)) return null
  const result = body.result.map(parseGroup)
  if (result.some((group) => group === null)) return null
  return {
    code: body.code,
    message: typeof body.message === 'string' ? body.message : '',
    result: result as SubscriptionBalanceGroup[],
  }
}

/**
 * Select the AI Points group and read its remaining percentage.
 *
 * No AI group → `null`; a missing/`null`/non-finite `quotaRemainPercent` →
 * `null` (unavailable). `0` is preserved as a valid exhausted balance.
 */
export function selectAiUsage(
  response: SubscriptionBalancesResponse | null,
): AiUsage | null {
  const group = response?.result.find((entry) => entry.aiPoints === true)
  if (!group) return null
  const percent = group.quotaRemainPercent
  if (percent === null || !Number.isFinite(percent)) return null
  return { quotaRemainPercent: percent }
}

/** Parse + select in one step — the single upstream→usage normalization. */
export function aiUsageFromPayload(payload: unknown): AiUsage | null {
  return selectAiUsage(parseSubscriptionBalancesResponse(payload))
}
