/**
 * `sidebar.footer.action` entry: the Huaqiu EDA account trigger at the bottom
 * of the DSH sidebar (beside Settings).
 *
 * - Not logged in: shows the HQ icon and opens the login dialog through
 *   `auth.login({ lang, theme })` — a real modal (backdrop + centered card +
 *   auth.eda.cn iframe) that is ALWAYS TRANSPARENT in the embed itself
 *   (`fill=full` is never sent, see `lib.ts#buildLoginUrl`), and the card
 *   surface masks Blink's white base canvas so the login card floats over
 *   the dimmed app in both light and dark themes. `lang`/`theme` follow the
 *   host UI. Click on the backdrop, the × button, or Escape closes it, and
 *   auth.eda.cn's own `close_dialog` postMessage closes it as well.
 * - Logged in: the trigger becomes the user's AVATAR (`headimage` from the
 *   auth.eda.cn payload, HQ icon while it is missing/fails to load) and a click
 *   opens a context menu with「Go to profile」(the eda.cn account page, with
 *   the access token) and「Log out」— the same shape as `hq-eda-ai`'s
 *   `UserMenu`, portalled to `document.body` with fixed positioning so the
 *   sidebar's `overflow: hidden` can never clip it.
 *
 * THEMING: colors prefer DSH's `--dsw-alias-*` tokens (so a custom host theme
 * is honored) and fall back to an explicit light/dark pair chosen from
 * `useIsDark()`; the two paths cannot disagree, because ui-layout's presenter
 * writes `body[data-ds-dark-theme]` from the very snapshot that installs those
 * tokens.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { getAuth, getAuthState, getHqEdge, setProfile, subscribeAuth } from '../auth-state.js'
import { buildProfileUrl, ERC_PRODUCT_CODE, GEN_PRODUCT_CODE, type SubscriptionQuota } from '../lib.js'
import { useIsDark, useLocale } from '../ui-env.js'
import { useT } from '../i18n.js'
import { HQ_ICON } from './hq-icon.jsx'

export interface SidebarFooterActionOwnerProps {
  wide?: boolean
}

const AVATAR_SIZE = 26
const ICON_SIZE = 22

/** One color scheme's menu colors (DSH token first, explicit fallback second). */
interface Palette {
  surface: string
  border: string
  text: string
  muted: string
  hover: string
  danger: string
  dangerHover: string
  avatarBg: string
  shadow: string
  /** Profile-header card background (prototype `bg-white/[0.03]`). */
  card: string
  /** 1px hairline used on cards inside the popup. */
  cardBorder: string
  /** Quota metric card background (prototype `bg-black/20`). */
  metric: string
  metricHover: string
  /** Huaqiu brand red (#e62e2d). */
  primary: string
  primaryHover: string
  /** Badge tint: primary at ~10% (prototype `bg-hq-primary/10`). */
  primarySoft: string
  /** Progress-bar track (prototype `dark:bg-gray-800`). */
  track: string
  /** GEN / ERC progress gradients (prototype blue→indigo, purple→pink). */
  genGradient: string
  ercGradient: string
  /** "Online" dot green. */
  online: string
}

const LIGHT_PALETTE: Palette = {
  surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
  border: 'var(--dsw-alias-border-l1, #e4e7ec)',
  text: 'var(--dsw-alias-label-primary, #3a4356)',
  muted: 'var(--dsw-alias-label-secondary, #8a94a6)',
  hover: 'var(--dsw-alias-interactive-bg-hover, #f5f7fa)',
  danger: 'var(--dsw-alias-state-error-primary, #d4380d)',
  dangerHover: 'rgba(216, 56, 13, 0.08)',
  avatarBg: 'var(--dsw-alias-bg-layer-2, #eef2f7)',
  shadow: '0 20px 40px -15px rgba(0, 0, 0, 0.12), 0 0 1px 1px rgba(0, 0, 0, 0.05)',
  card: '#f7f8fa',
  cardBorder: '#e8ebf0',
  metric: '#f7f8fa',
  metricHover: '#eef1f5',
  primary: '#e62e2d',
  primaryHover: '#cc2423',
  primarySoft: 'rgba(230, 46, 45, 0.08)',
  track: '#e4e7ec',
  genGradient: 'linear-gradient(90deg, #3b82f6, #6366f1)',
  ercGradient: 'linear-gradient(90deg, #a855f7, #ec4899)',
  online: '#10b981',
}

const DARK_PALETTE: Palette = {
  surface: 'var(--dsw-alias-bg-overlay, #1e1b24)',
  border: 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.10))',
  text: 'var(--dsw-alias-label-primary, #e6eaf0)',
  muted: 'var(--dsw-alias-label-secondary, #8b95a5)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))',
  danger: 'var(--dsw-alias-state-error-primary, #ff7875)',
  dangerHover: 'rgba(255, 120, 117, 0.14)',
  avatarBg: 'var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.10))',
  shadow: '0 20px 40px -15px rgba(0, 0, 0, 0.7), 0 0 1px 1px rgba(255, 255, 255, 0.1)',
  card: 'rgba(255, 255, 255, 0.03)',
  cardBorder: 'rgba(255, 255, 255, 0.08)',
  metric: 'rgba(0, 0, 0, 0.20)',
  metricHover: 'rgba(0, 0, 0, 0.30)',
  primary: '#e62e2d',
  primaryHover: '#cc2423',
  primarySoft: 'rgba(230, 46, 45, 0.10)',
  track: 'rgba(255, 255, 255, 0.10)',
  genGradient: 'linear-gradient(90deg, #3b82f6, #6366f1)',
  ercGradient: 'linear-gradient(90deg, #a855f7, #ec4899)',
  online: '#10b981',
}

const TRIGGER_BASE: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
}

const MENU_BASE: CSSProperties = {
  position: 'fixed',
  zIndex: 2147483000,
  width: 320,
  padding: 12,
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 16,
  fontFamily: 'inherit',
  fontSize: 13,
}

const MENU_HEADER_BASE: CSSProperties = {
  padding: '6px 10px 8px',
  fontSize: 12,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const MENU_ITEM_BASE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 10px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  font: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
}

/**
 * One menu row. Hover is tracked in state: the client bundle ships no CSS
 * file, so inline styles cannot express `:hover`. `trailing` renders a
 * chevron on the right (prototype nav rows), `danger` switches to the danger
 * color scheme (prototype logout).
 */
function MenuItem({
  label,
  icon,
  trailing,
  danger,
  palette,
  onSelect,
}: {
  label: string
  icon: React.JSX.Element
  trailing?: React.JSX.Element
  danger?: boolean
  palette: Palette
  onSelect: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      role="menuitem"
      style={{
        ...MENU_ITEM_BASE,
        justifyContent: 'space-between',
        color: danger ? palette.danger : palette.text,
        background: hovered ? (danger ? palette.dangerHover : palette.hover) : 'transparent',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </span>
      {trailing ? (
        <span
          style={{
            display: 'flex',
            flex: '0 0 auto',
            color: hovered ? (danger ? palette.danger : palette.text) : palette.muted,
          }}
        >
          {trailing}
        </span>
      ) : null}
    </button>
  )
}

function UserIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: '0 0 auto' }}
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function LogoutIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: '0 0 auto' }}
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </svg>
  )
}

/** GEN metric icon (lucide `cpu`, blue like the prototype). */
function CpuIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#3b82f6"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: '0 0 auto' }}
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </svg>
  )
}

/** ERC metric icon (lucide `waves`, purple like the prototype). */
function WaveIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#a855f7"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: '0 0 auto' }}
    >
      <path d="M2 12c1.5-3 3-3 4.5 0s3 3 4.5 0 3-3 4.5 0 3 3 4.5 0" />
      <path d="M2 17c1.5-3 3-3 4.5 0s3 3 4.5 0 3-3 4.5 0 3 3 4.5 0" />
    </svg>
  )
}

/** Upgrade-button crown (solid amber like the prototype). */
function CrownIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="#fcd34d"
      aria-hidden
      style={{ flex: '0 0 auto' }}
    >
      <path d="M2 18h20l-1.5-9-5.5 4L12 5.5 9 13l-5.5-4L2 18z" />
    </svg>
  )
}

/** Trailing chevron for nav rows (lucide `chevron-right`). */
function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flex: '0 0 auto' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

/** Quota metric card: icon + label, mono count and a gradient progress bar. */
function QuotaMetric({
  label,
  icon,
  quota,
  gradient,
  palette,
}: {
  label: string
  icon: React.JSX.Element
  quota: SubscriptionQuota | null
  gradient: string
  palette: Palette
}): React.JSX.Element {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  const used = quota?.currentQuota
  const total = quota?.totalQuota
  const percent = quota?.hasSubscription && typeof total === 'number' && total > 0
    ? Math.max(0, Math.min(100, Math.round(((used ?? 0) / total) * 100)))
    : 0
  const value = quota
    ? (quota.hasSubscription
        ? (typeof total === 'number'
            ? t('subscription.quotaCount', { used: used ?? 0, total })
            : String(used ?? 0))
        : t('subscription.unsubscribed'))
    : '—'
  return (
    <div
      role="presentation"
      style={{
        background: hovered ? palette.metricHover : palette.metric,
        borderRadius: 12,
        border: `1px solid ${palette.cardBorder}`,
        padding: 10,
        boxSizing: 'border-box',
        transition: 'background 0.15s ease',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, color: palette.text, minWidth: 0 }}>
          {icon}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        </span>
        <span
          style={{
            fontWeight: 700,
            color: quota?.hasSubscription ? palette.text : palette.danger,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
          title={value}
        >
          {value}
        </span>
      </div>
      <div style={{ width: '100%', height: 6, borderRadius: 999, background: palette.track, overflow: 'hidden' }}>
        <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: gradient }} />
      </div>
    </div>
  )
}

/**
 * Profile header card (prototype): name + plan badge + phone line on the
 * left, an "online" pill on the right. No redundant avatar — the trigger
 * already shows it.
 */
function ProfileHeaderCard({
  displayName,
  packageName,
  phone,
  palette,
}: {
  displayName: string
  packageName: string | null
  phone: string | null
  palette: Palette
}): React.JSX.Element {
  const t = useT()
  return (
    <div
      role="presentation"
      style={{
        padding: 10,
        borderRadius: 12,
        background: palette.card,
        border: `1px solid ${palette.cardBorder}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 12,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: palette.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayName}
          </span>
          {packageName ? (
            <span
              style={{
                fontSize: 10,
                background: palette.primarySoft,
                color: palette.primary,
                padding: '2px 6px',
                borderRadius: 4,
                fontWeight: 500,
                border: `1px solid ${palette.primarySoft}`,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {packageName}
            </span>
          ) : null}
        </div>
        {phone ? (
          <p
            style={{
              margin: 0,
              marginTop: 2,
              fontSize: 12,
              color: palette.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {phone}
          </p>
        ) : null}
      </div>
      <span
        style={{
          fontSize: 10,
          background: 'rgba(16, 185, 129, 0.10)',
          color: palette.online,
          padding: '2px 8px',
          borderRadius: 999,
          fontWeight: 500,
          border: '1px solid rgba(16, 185, 129, 0.20)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          flexShrink: 0,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 6, background: palette.online }} />
        {t('subscription.online')}
      </span>
    </div>
  )
}

/** Full-width red-gradient upgrade button (prototype CTA). */
function UpgradeButton({
  subscribing,
  palette,
  onClick,
}: {
  subscribing: boolean
  palette: Palette
  onClick: () => void
}): React.JSX.Element {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      style={{
        width: '100%',
        marginTop: 10,
        padding: '9px 12px',
        borderRadius: 12,
        border: 'none',
        background: subscribing
          ? `linear-gradient(90deg, ${palette.primary}, #e11d48)`
          : hovered
            ? `linear-gradient(90deg, ${palette.primaryHover}, #be123c)`
            : `linear-gradient(90deg, ${palette.primary}, #e11d48)`,
        color: '#ffffff',
        fontSize: 12,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        cursor: subscribing ? 'default' : 'pointer',
        opacity: subscribing ? 0.72 : 1,
        boxShadow: '0 8px 20px rgba(230, 46, 45, 0.22)',
        transition: 'background 0.15s ease, opacity 0.15s ease',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <CrownIcon />
      {subscribing ? t('subscription.subscribing') : t('subscription.upgrade')}
    </button>
  )
}

export const HuaqiuAuthSidebarAction = memo(function HuaqiuAuthSidebarAction({ wide }: SidebarFooterActionOwnerProps): React.JSX.Element | null {
  const authState = useSyncExternalStore(subscribeAuth, getAuthState)
  const auth = getAuth()
  const dark = useIsDark()
  const locale = useLocale()
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null)
  const [avatarBroken, setAvatarBroken] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [quota, setQuota] = useState<{ gen: SubscriptionQuota | null; erc: SubscriptionQuota | null } | null>(null)
  const [subscribing, setSubscribing] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE
  const authenticated = authState.authenticated
  const showLabel = wide !== false

  // Hide the trigger only when an HQ Edge host that ALREADY exposes its own
  // login surface is present: hq-eda has a native login button + status badge,
  // so this entrypoint would be redundant there. Every other configuration
  // (standalone DSH, kicad/generic hosts) has no login entrypoint of its own,
  // so the sidebar trigger is the only way in and must render.
  const hostMode = auth?.isHostMode?.() ?? false
  const targetHost = hostMode ? (getHqEdge()?.context?.getTargetHost?.() ?? '') : ''
  if (hostMode && targetHost === 'hq-eda') return null

  // Host sessions (kicad/generic) carry only {token, userId} — no nickname,
  // no avatar. Fetch the rich eda.cn profile (name + photo) so the trigger
  // renders the real account instead of a bare HQ icon. Standalone DSH already
  // has both from the auth.eda.cn payload, so this is host-only.
  const profile = authState.profile
  useEffect(() => {
    if (!hostMode || targetHost === 'hq-eda') return
    if (!authenticated) {
      setProfile(null)
      return
    }
    let cancelled = false
    auth?.getUserProfile?.()
      .then((info) => {
        if (cancelled) return
        setProfile(info)
      })
      .catch(() => { /* UI degrades to the HQ icon */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostMode, targetHost, authenticated])

  const displayName = profile?.nickname ?? authState.nickname
  const displayAvatar = profile?.headimage ?? authState.avatar
  const avatar = authenticated && !avatarBroken ? displayAvatar : undefined

  // A new avatar URL is a fresh chance to render it.
  useEffect(() => {
    setAvatarBroken(false)
  }, [displayAvatar])

  // Logging out (from anywhere: menu, another tab surface, node invalidation)
  // must never leave an orphan menu pointing at a signed-out account.
  useEffect(() => {
    if (!authenticated) setMenuOpen(false)
  }, [authenticated])

  // Live quota: EVERY time the menu opens (and every time the auth state
  // flips to authenticated) re-fetch the active subscription for GEN and ERC
  // DIRECTLY from eda.cn — the sidebar must never show a stale count.
  useEffect(() => {
    if (!menuOpen || !authenticated) {
      if (!menuOpen) setQuota(null)
      return
    }
    let cancelled = false
    void Promise.all([
      auth?.getSubscriptionQuota?.(GEN_PRODUCT_CODE).catch(() => null) ?? Promise.resolve(null),
      auth?.getSubscriptionQuota?.(ERC_PRODUCT_CODE).catch(() => null) ?? Promise.resolve(null),
    ]).then(([gen, erc]) => {
      if (!cancelled) setQuota({ gen, erc })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, authenticated])

  // Anchor the portalled menu to the trigger before paint: the sidebar footer
  // sits at the bottom edge, so the menu grows UPWARD from the trigger's top.
  // Width is FIXED (320, prototype `w-80`) — the sidebar footer is narrow, so
  // the popup intentionally overhangs it instead of collapsing to its width.
  useLayoutEffect(() => {
    if (!menuOpen || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setMenuStyle({
      ...MENU_BASE,
      background: palette.surface,
      borderColor: palette.border,
      color: palette.text,
      boxShadow: palette.shadow,
      left: Math.max(8, Math.round(rect.left)),
      bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8)),
    })
  }, [menuOpen, avatar, palette])

  // Close on: outside click, Escape, resize or scroll (the anchor moved).
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    const dismiss = (): void => setMenuOpen(false)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [menuOpen])

  if (!auth) return null

  /**
   *「Go to profile」always carries the token, so eda.cn can establish the
   * session in the opened tab (it hides the token itself — see
   * `lib.ts#buildProfileUrl`). The snapshot normally has it; fall back to the
   * client so a stale snapshot can never open an unauthenticated tab.
   */
  const openProfile = (): void => {
    setMenuOpen(false)
    void (async () => {
      const info = authState.token
        ? { token: authState.token, phone: authState.phone }
        : await auth.getUserInfo()
            .then((i) => (i ? { token: i.token, phone: i.phone } : null))
            .catch(() => null)
      if (!info?.token) return
      window.open(buildProfileUrl(info), '_blank', 'noopener,noreferrer')
    })()
  }

  const label = authenticated
    ? (displayName ?? t('sidebar.account'))
    : t('sidebar.login')

  const title = authenticated ? t('sidebar.accountTitle') : t('sidebar.loginTitle')
  const triggerBackground = menuOpen || hovered ? palette.hover : 'transparent'

  /**
   * Open the subscription page. Host mode → the EDA host's native dialog
   * (DialogService.OpenUrl, preferred size 1400×740); standalone DSH → the
   * in-app iframe dialog at the same preferred size. No credential → no-op.
   */
  const openSubscription = (): void => {
    if (subscribing) return
    setSubscribing(true)
    void auth.openSubscriptionDialog()
      .catch(() => { /* host without dialog service — menu stays usable */ })
      .finally(() => setSubscribing(false))
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          if (!authenticated) {
            // Always-transparent embed in the host's language and color scheme;
            // `closeOnOutsideClick` defaults to true. The login dialog owns
            // the DOM (backdrop + card + iframe) and closes itself on
            // backdrop click, Escape, the × button, or the embed's
            // `close_dialog` postMessage.
            void auth.login({ lang: locale, theme: dark ? 'dark' : 'light' })
            return
          }
          setMenuOpen((open) => !open)
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...TRIGGER_BASE,
          color: palette.text,
          padding: wide ? '8px 12px' : '8px 6px',
          background: triggerBackground,
        }}
        title={title}
      >
        {avatar ? (
          <span
            style={{
              flex: '0 0 auto',
              width: AVATAR_SIZE,
              height: AVATAR_SIZE,
              borderRadius: '50%',
              overflow: 'hidden',
              background: palette.avatarBg,
              display: 'block',
            }}
          >
            <img
              src={avatar}
              alt=""
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              onError={() => setAvatarBroken(true)}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </span>
        ) : (
          <HQ_ICON size={ICON_SIZE} />
        )}
        {showLabel ? (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        ) : null}
      </button>

      {menuOpen && menuStyle
        ? createPortal(
            <div ref={menuRef} role="menu" style={menuStyle}>
              <ProfileHeaderCard
                displayName={displayName ?? t('sidebar.account')}
                packageName={quota?.gen?.packageName ?? quota?.erc?.packageName ?? null}
                phone={authState.phone ?? null}
                palette={palette}
              />
              <div
                role="presentation"
                style={{
                  ...MENU_HEADER_BASE,
                  paddingTop: 0,
                  paddingBottom: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                  color: palette.muted,
                }}
              >
                {t('subscription.quotaHeader')}
              </div>
              <div role="presentation" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <QuotaMetric
                  label={t('subscription.gen')}
                  icon={<CpuIcon />}
                  quota={quota?.gen ?? null}
                  gradient={palette.genGradient}
                  palette={palette}
                />
                <QuotaMetric
                  label={t('subscription.erc')}
                  icon={<WaveIcon />}
                  quota={quota?.erc ?? null}
                  gradient={palette.ercGradient}
                  palette={palette}
                />
              </div>
              <UpgradeButton
                subscribing={subscribing}
                palette={palette}
                onClick={() => {
                  if (subscribing) return
                  openSubscription()
                }}
              />
              <div
                role="presentation"
                style={{
                  height: 1,
                  margin: '12px 2px',
                  background: palette.border,
                }}
              />
              <div role="presentation" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <MenuItem
                  label={t('menu.profile')}
                  icon={<UserIcon />}
                  trailing={<ChevronRightIcon />}
                  palette={palette}
                  onSelect={openProfile}
                />
              </div>
              <div
                role="presentation"
                style={{
                  height: 1,
                  margin: '12px 2px',
                  background: palette.border,
                }}
              />
              <MenuItem
                label={t('menu.logout')}
                icon={<LogoutIcon />}
                danger
                palette={palette}
                onSelect={() => {
                  setMenuOpen(false)
                  // Host mode: a rejected logout request must leave the UI
                  // authenticated — `auth.logout()` only REQUESTS the logout,
                  // the state comes from the host. Swallow the rejection so it
                  // never becomes an unhandled promise error.
                  void auth.logout().catch(() => { /* host refused — stay authenticated */ })
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  )
})
