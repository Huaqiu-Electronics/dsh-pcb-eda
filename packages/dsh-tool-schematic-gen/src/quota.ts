/**
 * GEN subscription quota check (node half).
 *
 * Fetches the active GEN (`auto-design`) subscription quota DIRECTLY from
 * eda.cn (`GET https://www.eda.cn/sub-api/subscriptions/active?userId&productCode`)
 * with the account's token — the same API `hq-eda-ai`'s `getActiveSubscription`
 * and `hq-edge`'s ERC quota proxy call, so the pre-check never depends on an
 * hq-edge hop.
 *
 * SEMANTICS: `null` means the check could NOT be performed (network / backend
 * failure) — callers FAIL OPEN (a flaky quota API must never block a paying
 * user's generation). A well-formed response always yields a `GenQuota`;
 * `currentQuota <= 0` means "no quota left" and callers FAIL CLOSED.
 *
 * @module
 */
import { getLogger } from '@huaqiu/dsh-plugin-log'
import type { EdaAccount } from './config.js'

/** The GEN subscription product code — matches `hq-eda-ai`'s PRODUCT_CODE. */
export const GEN_PRODUCT_CODE = 'auto-design'

const SUB_API_BASE = 'https://www.eda.cn'
const SUB_API_PREFIX = '/sub-api'
const SUB_API_SUCCESS_CODES = [200, 200000]

const log = getLogger('dsh-schematic-gen')

/** Normalized active-subscription quota view. */
export interface GenQuota {
  hasSubscription: boolean
  packageName: string
  currentQuota: number
  totalQuota: number
}

interface ActiveSubscriptionPayload {
  code?: number
  result?: Record<string, unknown> | null
  data?: Record<string, unknown> | null
}

function quotaOf(subscription: Record<string, unknown> | null | undefined): GenQuota {
  if (!subscription || Object.keys(subscription).length === 0) {
    return { hasSubscription: false, packageName: '', currentQuota: 0, totalQuota: 0 }
  }
  const currentQuota = Number(subscription.currentQuota) || 0
  return {
    hasSubscription: currentQuota > 0,
    packageName: typeof subscription.packageName === 'string' ? subscription.packageName : '',
    currentQuota,
    totalQuota: Number(subscription.totalQuota) || 0,
  }
}

/**
 * Fetch the active GEN subscription quota for the resolved account.
 * Returns null when the check cannot be performed (fail-open); a valid
 * response always yields a `GenQuota` (possibly `hasSubscription: false`).
 */
export async function fetchGenQuota(account: EdaAccount, fetchImpl?: typeof fetch): Promise<GenQuota | null> {
  try {
    const url = `${SUB_API_BASE}${SUB_API_PREFIX}/subscriptions/active?${new URLSearchParams({
      userId: account.userId,
      productCode: GEN_PRODUCT_CODE,
    }).toString()}`
    const res = await (fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'x-token': account.userToken,
        'X-User-Id': account.userId,
      },
    })
    if (!res || !res.ok) {
      log.warn('gen quota check failed', { status: res?.status })
      return null
    }
    const payload = (await res.json()) as ActiveSubscriptionPayload
    if (!payload || !SUB_API_SUCCESS_CODES.includes(Number(payload.code))) {
      log.warn('gen quota check rejected', { code: payload?.code })
      return null
    }
    const result = payload.result ?? payload.data ?? null
    return quotaOf(result)
  } catch (err) {
    log.warn('gen quota check failed', { error: String((err as Error)?.message || err) })
    return null
  }
}
