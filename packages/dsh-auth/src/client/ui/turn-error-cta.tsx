/**
 * `conversation.chat.turn-error.action` entry: a subscription button inside
 * the Chat terminal-failure card.
 *
 * The huaqiu gateway reports an exhausted token balance as a provider error
 * whose own payload code is `insufficient_user_quota`. The harness keeps that
 * code on the durable failure as `providerErrorCode` and attributes the
 * failure to the routed `provider`; this entry gates on those structured
 * fields only, so a wording change or an unrelated error simply renders no
 * button. Clicking it opens the subscription dialog owned by this package's
 * auth client (`openSubscriptionDialog`), which is the same path the sidebar
 * upgrade entry uses.
 *
 * Fallbacks stay inside the card: no host dialog service → the existing
 * "host provides no dialog service" copy; transport failure → retry copy; no
 * credential → the auth client's login surface. The entry never throws, so a
 * missing or older slot harness degrades to the shipped card.
 */
import { memo, useCallback, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getAuth, getAuthState, subscribeAuth } from '../auth-state.js'
import { useT } from '../i18n.js'
import { useIsDark, useLocale } from '../ui-env.js'

/** Structural view of the durable turn-error node this entry receives. */
export interface TurnErrorCtaNode {
  readonly code?: string
  readonly message: string
  readonly provider?: string
  readonly providerErrorCode?: string
}

/** Gateway provider whose balance signature this entry understands. */
const QUOTA_PROVIDER = 'huaqiu'
/** The gateway's own code for a token balance that can be topped up. */
const HUAQIU_QUOTA_SIGNATURE = 'insufficient_user_quota'

/**
 * Whether a durable failure is the huaqiu gateway's exhausted token balance.
 *
 * Two structured shapes qualify:
 * - the adapter extracted the gateway's own `insufficient_user_quota` code, or
 * - the routed provider is huaqiu and the harness classified the failure as
 *   `QUOTA` (covers classifier fixes that stop carrying the payload code).
 *
 * Never gate on `message`: unrelated failures can quote provider text, and a
 * payload/wording change must degrade to "no button", not to a false positive.
 * @param node - durable turn-error node, possibly absent at runtime boundaries.
 * @returns true only for the huaqiu token-quota signature.
 */
export function isHuaqiuQuotaFailure(node: TurnErrorCtaNode | null | undefined): boolean {
  if (node === null || node === undefined) return false
  if (node.code !== 'PI_AI_ERROR' && node.code !== 'QUOTA') return false
  if (node.providerErrorCode === HUAQIU_QUOTA_SIGNATURE) return true
  return node.provider === QUOTA_PROVIDER && node.code === 'QUOTA'
}

const ctaStyle: CSSProperties = {
  display: 'block',
  width: 'fit-content',
  marginTop: 4,
  padding: '1px 10px',
  border: '1px solid var(--dsw-alias-brand-primary, #e62e2d)',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--dsw-alias-brand-primary, #e62e2d)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
}

const noticeStyle: CSSProperties = {
  display: 'block',
  marginTop: 2,
  color: 'var(--dsw-alias-state-error-primary, #d4380d)',
  fontSize: 12,
  lineHeight: '18px',
}

const stopStyle: CSSProperties = { borderRadius: 999, opacity: 0.6, cursor: 'default' }

/** Turn-error recovery affordance for the huaqiu token quota. */
export const HuaqiuTurnErrorSubscribeAction = memo(function HuaqiuTurnErrorSubscribeAction(
  { node }: { node: TurnErrorCtaNode },
) {
  const auth = getAuth()
  const authState = useSyncExternalStore(subscribeAuth, getAuthState, getAuthState)
  const locale = useLocale()
  const dark = useIsDark()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [notice, setNotice] = useState<{ readonly key: string; readonly text: string } | null>(null)

  // A projection may hand a fresh node object to the same mounted instance;
  // scope the notice to the failure it describes so a later turn never inherits
  // stale copy.
  const nodeKey = node.message
  const visibleNotice = notice !== null && notice.key === nodeKey ? notice.text : null

  const open = useCallback(() => {
    if (busy) return
    const fail = (): void => {
      setNotice({ key: nodeKey, text: t('turnError.aiQuotaOpenFailed') })
    }
    if (!auth) {
      fail()
      return
    }
    // Host mode's login blocks until its dialog completes, so it is never
    // awaited here; `busy` belongs to the subscription request only.
    const requestLogin = (): void => {
      try {
        void auth.login({ lang: locale, theme: dark ? 'dark' : 'light' }).catch(fail)
      } catch {
        fail()
      }
    }
    if (!authState.authenticated) {
      requestLogin()
      return
    }
    setNotice(null)
    setBusy(true)
    void auth.openSubscriptionDialog()
      .then((outcome) => {
        if (outcome.status === 'host-unavailable') {
          setNotice({ key: nodeKey, text: t('subscription.hostUnavailable') })
        } else if (outcome.status === 'signed-out') {
          requestLogin()
        }
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }, [auth, authState.authenticated, busy, dark, locale, nodeKey, t])

  if (!isHuaqiuQuotaFailure(node)) return null

  const label = busy
    ? t('subscription.subscribing')
    : authState.authenticated
      ? t('turnError.aiQuotaCta')
      : t('turnError.aiQuotaSignIn')

  return (
    <>
      <button
        type="button"
        style={{
          ...ctaStyle,
          ...(hovered && !busy ? { background: 'var(--dsw-alias-interactive-bg-hover, rgba(230, 46, 45, 0.08))' } : {}),
          ...(busy ? stopStyle : {}),
        }}
        disabled={busy}
        aria-busy={busy}
        onClick={open}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {label}
      </button>
      {visibleNotice === null ? null : <span style={noticeStyle} aria-live="polite">{visibleNotice}</span>}
    </>
  )
})
