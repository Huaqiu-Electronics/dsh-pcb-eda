/**
 * Pure browser message parsing for auth.eda.cn postMessage envelopes.
 *
 * auth.eda.cn posts `JSON.stringify({ category: 1, data: { type, data } })`
 * to the parent window with `targetOrigin: '*'`.
 *
 * SECURITY NOTE (offline deployment): the DSH harness runs fully offline /
 * local (127.0.0.1), so there is no public attack surface of a malicious
 * website posting a forged token at us. The origin gate is therefore dropped
 * by design — webviews may even report an opaque origin ("null") for the
 * embedded auth.eda.cn iframe, which would otherwise reject legitimate login
 * messages. What remains is the ENVELOPE validation in `parseAuthMessage`
 * (category 1 + well-formed token/userId), which keeps unrelated window
 * messages from ever corrupting the credential cache.
 *
 * Envelope types (see `/Users/admin/code/eda-cn-login/lib/kicadTools.ts`):
 *   { category: 1, data: { type: 'update_access_token', data: { userId, token, expires_at, ... } } }
 *   { category: 1, data: { type: 'logout', data: null } }
 *   { category: 1, data: { type: 'close_dialog', data: null } }
 */

export const AUTH_ORIGIN = 'https://auth.eda.cn'

/** Standalone-DSH fallback for the「Go to profile」destination. Under HQ Edge the full URL is
 * resolved ONCE from `HQ_AI_ENV` (PROD: `https://www.eda.cn/account/profile`,
 * TEST: `http://www.fdatasheets.com/account`) and arrives via the node half's
 * `/config` route; this constant is used only when nothing supplies one.
 */
export const PROFILE_URL = 'https://www.eda.cn/account/profile'

// ── Subscription (quota + upgrade dialog) ────────────────────────────────────

/**
 * Subscription landing page — the same page `hq-eda-ai` serves at
 * `<origin>/subscription` (token taken from the URL query; see its
 * `UserInfoContext`). The preferred window size for BOTH surfaces (KiCad
 * native dialog via DialogService.OpenUrl and the standalone iframe dialog)
 * is 1400×740.
 *
 * This constant is the standalone-DSH fallback only. Under HQ Edge the origin
 * arrives from the node half's `/config` route, resolved ONCE from `HQ_AI_ENV`
 * (PROD: gen.eda.cn / TEST: gen.fdatasheets.com).
 */
export const DEFAULT_SUBSCRIPTION_ORIGIN = 'https://gen.eda.cn'
export const SUBSCRIPTION_PATH = '/subscription'
export const SUBSCRIPTION_PREFERRED_SIZE = { width: 1400, height: 740 } as const

/**
 * eda.cn subscription product codes.
 * - GEN (system/schematic design): `auto-design` — the SAME product code
 *   `hq-eda-ai` uses (`apps/web/src/lib/config/product-code.ts`), i.e. the
 *   subscription sold on `gen.eda.cn/subscription`.
 * - ERC: `erc` — the code `hq-edge`'s own quota proxy
 *   (`apps/server/src/routes/project.ts`) queries with.
 */
export const GEN_PRODUCT_CODE = 'auto-design'
export const ERC_PRODUCT_CODE = 'erc'

// ── AI usage (subscription balances) ────────────────────────────────────────

/**
 * Client-facing AI usage shape. Re-exported (type-only) from the single
 * authoritative contract in `../subscription-balances.ts`; the browser half
 * must not import node modules, and a type-only re-export adds no runtime
 * code to this bundle.
 *
 * WHY THE BROWSER NEVER CALLS THE UPSTREAM ENDPOINT DIRECTLY: the TEST endpoint
 * is served over plain `http`, which the WebView refuses twice over — App
 * Transport Security ("the resource could not be loaded because the App
 * Transport Security policy requires the use of a secure connection") and CORS
 * (the response carries no `Access-Control-Allow-Origin`). The node half has
 * neither restriction, so IT performs the fetch and this half reads a
 * same-origin route, exactly like the eda.cn profile on `/user-info`.
 */
export type { AiUsage } from '../subscription-balances.js'

/**
 * Build the subscription landing URL. Mirrors `buildProfileUrl`: the token is
 * always attached — the subscription page consumes it to establish the
 * session and hides it itself. `encodeURIComponent` is required (tokens are
 * base64-ish and may contain `+`, `/` or `=`).
 *
 * `origin` comes from the node half (HQ Edge → `HQ_AI_ENV`); omitted in
 * standalone DSH, which keeps the PROD fallback.
 */
export function buildSubscriptionUrl(options: { token: string; origin?: string }): string {
  const origin = (options.origin ?? DEFAULT_SUBSCRIPTION_ORIGIN).replace(/\/+$/, '')
  return `${origin}${SUBSCRIPTION_PATH}?token=${encodeURIComponent(options.token)}`
}

/** Normalized active-subscription quota view (whatever the backend sends). */
export interface SubscriptionQuota {
  hasSubscription: boolean
  packageName: string
  currentQuota: number
  totalQuota: number
}

const SUB_API_PREFIX = '/sub-api'
const SUB_API_SUCCESS_CODES = [200, 200000]

function unwrapSubApiPayload<T>(payload: unknown): T | null {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const p = payload as { code: number; result?: T; data?: T }
    if (!SUB_API_SUCCESS_CODES.includes(p.code)) return null
    if (p.result !== undefined) return p.result as T
    if (p.data !== undefined) return p.data as T
    return undefined as T
  }
  return payload as T
}

function quotaOf(subscription: Record<string, unknown> | null | undefined): SubscriptionQuota {
  if (!subscription || (typeof subscription === 'object' && Object.keys(subscription).length === 0)) {
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
 * Fetch the active subscription quota (`GET {baseUrl}/sub-api/subscriptions/
 * active?userId&productCode` with `x-token` + `X-User-Id` headers) — the same
 * API `hq-eda-ai`'s `getActiveSubscription` and `hq-edge`'s ERC quota proxy
 * call.
 *
 * `baseUrl` is the origin the node half derives from the resolved
 * subscription-balances endpoint (`HQ_AI_ENV`), so this call follows the
 * selected environment and DSH Auth never hardcodes a production host. No
 * configured origin → null (the UI shows「—」).
 *
 * Returns null when the fetch/unwrap fails (callers decide fail-open vs
 * fail-closed); a well-formed response always yields a `SubscriptionQuota`
 * (possibly with `hasSubscription: false`).
 */
export async function fetchSubscriptionQuota(options: {
  userId: string | number
  token: string
  productCode: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): Promise<SubscriptionQuota | null> {
  const { userId, token, productCode, baseUrl } = options
  if (!baseUrl) return null
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${baseUrl}${SUB_API_PREFIX}/subscriptions/active?${new URLSearchParams({
    userId: String(userId),
    productCode,
  }).toString()}`
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'x-token': token,
        'X-User-Id': String(userId),
      },
    })
    if (!res || !res.ok) return null
    const json = (await res.json()) as unknown
    return quotaOf(unwrapSubApiPayload<Record<string, unknown>>(json))
  } catch {
    return null
  }
}

/**
 * Build the「Go to profile」URL: the eda.cn account page WITH the access token
 * in the query, mirroring `hq-eda-ai`'s `UserMenu`
 * (`/account/profile?token=…&phone=…`).
 *
 * `profileUrl` comes from the node half (HQ Edge → `HQ_AI_ENV`); omitted in
 * standalone DSH, which keeps the {@link PROFILE_URL} PROD fallback. The
 * injected value is a FULL URL (path included), because PROD and TEST do not
 * share it (`/account/profile` vs `/account`); any existing query string on it
 * is preserved and `token`/`phone` are appended.
 */
export function buildProfileUrl(options: {
  token: string
  phone?: string | number
  profileUrl?: string
}): string {
  const phone = options.phone === undefined || options.phone === null ? '' : String(options.phone)
  const base = options.profileUrl?.length ? options.profileUrl : PROFILE_URL
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}token=${encodeURIComponent(options.token)}&phone=${encodeURIComponent(phone)}`
}

/**
 * Contract version of the auth.eda.cn embed, shared with the web app
 * (`hq-eda-ai` LoginDialog) so both send the same cache-busting `v=`.
 */
export const AUTH_IFRAME_VERSION = '20260409'

/** UI language of the auth.eda.cn embed. */
export type AuthLocale = 'zh' | 'en'

/** Color scheme of the auth.eda.cn embed (its own vocabulary: light | dark). */
export type AuthTheme = 'light' | 'dark'

/**
 * auth.eda.cn's own language ids, keyed by our locale id.
 *
 * The embed reads `?locale=`, NOT `lang`: `eda-cn-login/app/layout.tsx` reads
 * `urlParams.get('locale')` and `components/ui/LanguageContext.tsx`
 * (`getLangFromUrl`) only accepts the ids in `locales/index.ts` — `cn` and
 * `en` (`zh` / `zh_CN` are aliased to `cn` there, but we send the canonical
 * id outright).
 *
 * NOTE: `hq-eda-ai`'s `LoginDialog.tsx` sends `lang=zh`, which the embed
 * IGNORES, so its login card always falls back to whatever the browser asks
 * for. We send `locale` (what is actually read) and keep `lang` alongside it
 * for parity with the web app and forward compatibility.
 */
export const AUTH_LOCALE_ID: Record<AuthLocale, string> = { zh: 'cn', en: 'en' }

/**
 * Options for the auth.eda.cn overlay iframe opened by `auth.login()`.
 *
 * The embed has TWO rendering modes, and which one is right depends on the
 * surface that hosts the iframe:
 *
 * - **Transparent card mode** (default, no `fill`): the embedded page sets
 *   `html[data-iframe-mode="true"]` and the root paints
 *   `background: transparent` (see `eda-cn-login/app/page.tsx` — the wrapper
 *   only gets the `bg-transparent` class when `fill !== 'full'`). The host
 *   then paints a card around the iframe (e.g. the login dialog's backdrop
 *   + centered card) so Blink's white `BaseBackgroundColor()` canvas never
 *   shows. This is the right mode when the iframe sits inside a host-painted
 *   card with its own visual edge — e.g. the sidebar-triggered login dialog.
 *
 * - **Fill mode** (`fill: 'full'`): the embed's `DialogContent` becomes
 *   `w-full h-full max-w-none max-h-none left-0 top-0 rounded-none border-none`
 *   (see `eda-cn-login/components/LoginDialog.tsx` — `fillFull` branch at
 *   line 61) and the wrapper drops `bg-transparent` so the page paints its
 *   own `bg-background` edge-to-edge. This is the right mode when the iframe
 *   fills its host container (e.g. the toolview card) and there is no
 *   surrounding card to mask the embed's rounded corners or transparent
 *   20px grid strips.
 *
 * The `lang` and `theme` params follow the host UI in both modes.
 */
export interface LoginOptions {
  /** Ask auth.eda.cn to self-close on an outside click (default `true`). */
  closeOnOutsideClick?: boolean
  /** Embed UI language (default `zh`). */
  lang?: AuthLocale
  /** Embed color scheme (default `light`). */
  theme?: AuthTheme
  /**
   * Set to `'full'` to make the embed fill its iframe viewport edge-to-edge
   * (no rounded corners, no transparent grid strips, embed paints its own
   * `bg-background`). Omit for the transparent card mode described above.
   * `true` is accepted as a shorthand for `'full'`.
   */
  fill?: 'full' | 'transparent' | true
}

export interface AuthTokenPayload {
  id: string
  token: string
  nickname?: string
  /** User avatar URL (`headimage` in the auth.eda.cn payload). */
  avatar?: string
  /** Bound mobile number; forwarded to the eda.cn profile page as `phone=`. */
  phone?: string
  /** unix seconds; undefined = no expiry */
  expiresAt?: number
}

/**
 * Build the auth.eda.cn embed URL.
 *
 * The URL switches between two rendering modes based on `options.fill`:
 *  - `fill: 'full'` (or `true`) → `fill=full` is sent; the embed's
 *    `DialogContent` becomes `w-full h-full … rounded-none` and the wrapper
 *    drops `bg-transparent`, so the embed fills the iframe viewport with
 *    its own `bg-background`. Use this when the iframe is the surface (e.g.
 *    the toolview card).
 *  - any other value (including unset) → no `fill` is sent; the embed stays
 *    in transparent card mode. The host is responsible for painting a card
 *    around the iframe so Blink's white base canvas never reaches the user.
 */
export function buildLoginUrl(options: LoginOptions & { baseUrl?: string } = {}): string {
  const url = new URL(options.baseUrl ?? `${AUTH_ORIGIN}/`)
  url.searchParams.set('v', AUTH_IFRAME_VERSION)
  if (options.closeOnOutsideClick !== false) url.searchParams.set('clickOutsideToClose', 'true')
  if (options.fill === 'full' || options.fill === true) url.searchParams.set('fill', 'full')
  url.searchParams.set('transparent', 'true')
  const lang = options.lang ?? 'zh'
  // `locale` is the param auth.eda.cn reads; `lang` keeps parity with
  // hq-eda-ai's LoginDialog (see AUTH_LOCALE_ID).
  url.searchParams.set('locale', AUTH_LOCALE_ID[lang])
  url.searchParams.set('lang', lang)
  url.searchParams.set('theme', options.theme ?? 'light')
  return url.toString()
}

export type ParsedAuthMessage =
  | { kind: 'token'; info: AuthTokenPayload }
  | { kind: 'logout' }
  | { kind: 'close' }

/** Structural event (origin + data) so tests don't need a real MessageEvent. */
export interface AuthMessageEventLike {
  origin: string
  data: unknown
  /** The posting window; retained for completeness (origin is not gated). */
  source?: unknown
}

interface RawEnvelope {
  category?: unknown
  data?: { type?: unknown; data?: unknown }
}

/** Coerce an id field (string or number, as auth.eda.cn sends) to a string. */
function stringifyId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export function parseAuthMessage(raw: unknown): ParsedAuthMessage | null {
  let envelope: RawEnvelope | null = null
  if (typeof raw === 'string') {
    try {
      envelope = JSON.parse(raw) as RawEnvelope
    } catch {
      return null
    }
  } else if (raw !== null && typeof raw === 'object') {
    envelope = raw as RawEnvelope
  }
  if (!envelope || envelope.category !== 1) return null
  const data = envelope.data
  if (!data || typeof data !== 'object') return null

  switch (data.type) {
    case 'update_access_token': {
      const d = data.data
      if (!d || typeof d !== 'object') return null
      const record = d as Record<string, unknown>
      const token = typeof record.token === 'string' && record.token.length > 0 ? record.token : null
      // auth.eda.cn sends userId/id as NUMBERS (e.g. 6215935) — coerce to string.
      const id = stringifyId(record.userId) ?? stringifyId(record.id)
      if (!token || !id) return null
      const nickname = typeof record.nickname === 'string' && record.nickname.length > 0 ? record.nickname : undefined
      // auth.eda.cn sends the avatar as `headimage`; `avatar` accepted as alias.
      const avatar = typeof record.headimage === 'string' && record.headimage.length > 0
        ? record.headimage
        : typeof record.avatar === 'string' && record.avatar.length > 0 ? record.avatar : undefined
      // Phone may arrive as a string or a number (mirrors `stringifyId`).
      const phone = stringifyId(record.phone) ?? undefined
      const expiresAt = typeof record.expires_at === 'number' ? record.expires_at : undefined
      return {
        kind: 'token',
        info: {
          id,
          token,
          ...(nickname !== undefined ? { nickname } : {}),
          ...(avatar !== undefined ? { avatar } : {}),
          ...(phone !== undefined ? { phone } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
      }
    }
    case 'logout':
      return { kind: 'logout' }
    case 'close_dialog':
      return { kind: 'close' }
    default:
      return null
  }
}

/** Origin-agnostic envelope parsing. The ONLY entry point for window message events. */
export function handleAuthMessage(event: AuthMessageEventLike): ParsedAuthMessage | null {
  return parseAuthMessage(event.data)
}
