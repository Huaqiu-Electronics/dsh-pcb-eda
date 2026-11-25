/**
 * Launch onboarding wizard for the EMBEDDED (HQ Edge / EDA host) deployment.
 *
 * WHY THIS EXISTS
 *
 * When `dsh` is launched by hq-edge inside an EDA host, the operator may still
 * be signed out. Nothing in that surface tells them that signing in unlocks
 * the built-in Huaqiu AI, so a first launch silently runs on whatever custom
 * provider the operator configured — or on nothing at all. This wizard runs
 * once at launch, and only in host mode.
 *
 * WHERE IT MUST NOT APPEAR
 *
 * Standalone DSH desktop already has an obvious account entrypoint (the
 * settings/account section). Showing a second, competing modal there is noise,
 * so the entry is registered only when `auth.isHostMode()` is true; the
 * component also re-checks that flag and renders nothing otherwise.
 *
 * NO PERSISTENCE — AND WHY
 *
 * Every `dsh` launch binds a NEW loopback port, so the browser origin (`http://
 * 127.0.0.1:<port>`) changes on every start. Anything persisted in
 * `localStorage` / `sessionStorage` is therefore invisible to the next launch
 * and would only pretend to be remembered. The "don't show again" choice is
 * consequently held in COMPONENT STATE for the life of this page: it suppresses
 * re-opening after a mid-session logout, and it is gone when the app exits.
 * Do not "fix" this by adding storage.
 *
 * LOGIN AND REGISTRATION ARE THE SAME HOST DIALOG
 *
 * In host mode `auth.login()` never opens the auth.eda.cn iframe: it POSTs to
 * the node half, which asks the EDA host to open its native login dialog and
 * answers when that dialog closes. The host's dialog already covers both
 * signing in and creating an account, so the footer's「Create account」must
 * call exactly the same trigger — do not add a second flow here.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { JSX } from 'react'
import { getAuth, getAuthState, subscribeAuth } from '../auth-state.js'
import { useT } from '../i18n.js'
import { HostLoginDismissedError } from '../transport.js'
import { useIsDark } from '../ui-env.js'

const BRAND_RED = '#e03131'

/** Every painted value for one color scheme (the client bundle ships no CSS). */
interface WizardPalette {
  overlay: string
  surface: string
  card: string
  footer: string
  border: string
  text: string
  muted: string
  accentSoft: string
  accentBorder: string
  iconColor: string
  shadow: string
  closeHover: string
}

/** Light scheme stays DSH-token-first so a custom host theme still wins. */
export const LIGHT_WIZARD_PALETTE: WizardPalette = {
  overlay: 'rgba(15, 20, 28, 0.46)',
  surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
  card: 'var(--dsw-alias-bg-layer-2, #f7f8fa)',
  footer: 'var(--dsw-alias-bg-layer-2, #f4f6f9)',
  border: 'var(--dsw-alias-border-l1, #e4e7ec)',
  text: 'var(--dsw-alias-label-primary, #1f2733)',
  muted: 'var(--dsw-alias-label-secondary, #5b6472)',
  accentSoft: 'rgba(224, 49, 49, 0.08)',
  accentBorder: 'rgba(224, 49, 49, 0.22)',
  iconColor: BRAND_RED,
  shadow: '0 24px 60px rgba(15, 20, 28, 0.24)',
  closeHover: 'var(--dsw-alias-interactive-bg-hover, #f1f4f8)',
}

/** Dark scheme follows the onboarding prototype's explicit deep-neutral scale. */
export const DARK_WIZARD_PALETTE: WizardPalette = {
  overlay: 'rgba(0, 0, 0, 0.70)',
  surface: '#212121',
  card: '#191919',
  footer: '#1b1b1b',
  border: '#343434',
  text: '#f3f3f3',
  muted: '#9e9e9e',
  accentSoft: '#2a2020',
  accentBorder: '#492929',
  iconColor: '#ff6b6b',
  shadow: '0 24px 60px rgba(0, 0, 0, 0.75)',
  closeHover: '#2e2e2e',
}

export function wizardPalette(dark: boolean): WizardPalette {
  return dark ? DARK_WIZARD_PALETTE : LIGHT_WIZARD_PALETTE
}

/** The boxed「H!」mark from the onboarding prototype. */
function WizardBrandMark({ color }: { color: string }): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2.5" width="31" height="31" rx="8" stroke={color} strokeWidth="3.2" fill="none" />
      <rect x="9.5" y="10" width="3.4" height="16" rx="1.5" fill={color} />
      <rect x="11" y="16.3" width="9" height="3.4" rx="1" fill={color} />
      <rect x="17.5" y="10" width="3.4" height="16" rx="1.5" fill={color} />
      <rect x="23.5" y="10" width="3.2" height="10.5" rx="1.5" fill={color} />
      <circle cx="25.1" cy="24.2" r="1.8" fill={color} />
    </svg>
  )
}

function SparkleGlyph({ color }: { color: string }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M7 0.6 8.5 4.4 12.4 5.9 8.5 7.4 7 11.2 5.5 7.4 1.6 5.9 5.5 4.4Z" fill={color} />
      <circle cx="11.8" cy="11.8" r="1.3" fill={color} />
    </svg>
  )
}

function LayersGlyph({ color }: { color: string }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M7 1 13 4 7 7 1 4Z" fill={color} />
      <path d="M2.4 6.9 7 9.2 11.6 6.9 13 7.6 7 10.6 1 7.6Z" fill={color} opacity="0.75" />
      <path d="M2.4 9.6 7 11.9 11.6 9.6 13 10.3 7 13.3 1 10.3Z" fill={color} opacity="0.5" />
    </svg>
  )
}

function BoltGlyph({ color }: { color: string }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M8.2 0.4 2.6 7.6h3.1L5.2 13.6 11.4 5.9H8.1Z" fill={color} />
    </svg>
  )
}

/** One feature row of the highlight card. */
function FeatureRow({ icon, title, desc, palette }: {
  icon: JSX.Element
  title: string
  desc: string
  palette: WizardPalette
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: palette.accentSoft,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        marginTop: 1,
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 550, color: palette.text, lineHeight: 1.35 }}>{title}</div>
        <div style={{ fontSize: 12, color: palette.muted, lineHeight: 1.45, marginTop: 2 }}>{desc}</div>
      </div>
    </div>
  )
}

export interface HuaqiuOnboardingWizardProps {
  /** `shell.overlay` passes runtime bindings; this wizard needs none. */
  [key: string]: unknown
}

/**
 * `shell.overlay` entry: the embedded-host launch wizard.
 *
 * Visible only when ALL of the following hold:
 *   - the plugin runs under an HQ Edge host (`auth.isHostMode()`),
 *   - the host session has been resolved (`auth-state` resolved snapshot),
 *   - the operator is not signed in,
 *   - the operator has not dismissed this wizard for the current page.
 */
export function HuaqiuOnboardingWizard(_props: HuaqiuOnboardingWizardProps): JSX.Element | null {
  const t = useT()
  const dark = useIsDark()
  const authState = useSyncExternalStore(subscribeAuth, getAuthState, getAuthState)
  // Session-only preferences — see the file header: storage cannot survive a
  // new port, so this must never be written anywhere.
  const [dismissed, setDismissed] = useState(false)
  const [suppressForSession, setSuppressForSession] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const wasAuthenticated = useRef(false)

  const hostMode = getAuth()?.isHostMode() ?? false
  const visible = hostMode && authState.resolved && !authState.authenticated && !dismissed

  // Re-open after a mid-session sign-out, unless the operator ticked
  //「don't show again」. That is the ONLY thing the checkbox controls: the
  // next launch starts from a fresh port and therefore a fresh choice.
  useEffect(() => {
    if (authState.authenticated) {
      wasAuthenticated.current = true
      setDismissed(true)
      return
    }
    if (wasAuthenticated.current) {
      wasAuthenticated.current = false
      if (!suppressForSession) {
        setError(null)
        setDismissed(false)
      }
    }
  }, [authState.authenticated, suppressForSession])

  useEffect(() => {
    if (visible) primaryRef.current?.focus()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setDismissed(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [visible])

  const dismiss = useCallback((): void => {
    if (dontShowAgain) setSuppressForSession(true)
    setDismissed(true)
  }, [dontShowAgain])

  const login = useCallback(async (): Promise<void> => {
    if (busy) return
    const auth = getAuth()
    if (!auth) return
    setBusy(true)
    setError(null)
    try {
      // Host mode: the EDA host's own dialog — it covers both sign-in and
      // account creation, so「Create account」calls this same trigger.
      await auth.login()
    } catch (error) {
      // Dismissing the host dialog (401) is the operator's choice, not a
      // failure: leave the wizard usable and show no error banner for it.
      if (!(error instanceof HostLoginDismissedError)) setError(t('onboarding.error'))
    } finally {
      setBusy(false)
    }
  }, [busy, t])

  if (!visible) return null

  const palette = wizardPalette(dark)
  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 30,
    background: palette.overlay,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    boxSizing: 'border-box',
  }
  const cardStyle: CSSProperties = {
    width: '100%',
    maxWidth: 460,
    maxHeight: '92vh',
    overflowY: 'auto',
    background: palette.surface,
    color: palette.text,
    border: `1px solid ${palette.border}`,
    borderRadius: 16,
    boxShadow: palette.shadow,
    fontFamily: 'inherit',
  }

  return (
    <div style={overlayStyle} data-hq-onboarding-wizard="" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hq-onboarding-title"
        data-hq-onboarding-card=""
        style={cardStyle}
      >
        <div style={{ height: 3, background: `linear-gradient(90deg, ${BRAND_RED}, #ff5b5b, #9b1c1c)` }} />
        <div style={{ padding: '20px 24px 16px', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 0 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: palette.accentSoft,
              border: `1px solid ${palette.accentBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
            }}><WizardBrandMark color={palette.iconColor} /></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: palette.iconColor,
                  background: palette.accentSoft,
                  border: `1px solid ${palette.accentBorder}`,
                  padding: '2px 7px',
                  borderRadius: 999,
                }}>{t('onboarding.badge')}</span>
                <span style={{ fontSize: 11, color: palette.muted }}>{t('onboarding.hostLabel')}</span>
              </div>
              <div
                id="hq-onboarding-title"
                style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, marginTop: 6, color: palette.text }}
              >{t('onboarding.title')}</div>
            </div>
          </div>
          <button
            type="button"
            aria-label={t('dialog.close')}
            title={t('dialog.close')}
            onClick={dismiss}
            style={{
              width: 28,
              height: 28,
              flex: '0 0 auto',
              border: 0,
              borderRadius: 8,
              background: 'transparent',
              color: palette.muted,
              fontSize: 20,
              lineHeight: 1,
              cursor: 'pointer',
              padding: 0,
            }}
          >×</button>
        </div>

        <div style={{ padding: '0 24px 20px' }}>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: palette.muted }}>{t('onboarding.desc')}</p>

          <div style={{
            marginTop: 16,
            padding: 14,
            borderRadius: 12,
            background: palette.card,
            border: `1px solid ${palette.border}`,
            display: 'grid',
            gap: 12,
          }}>
            <FeatureRow
              icon={<SparkleGlyph color={palette.iconColor} />}
              title={t('onboarding.featureModelsTitle')}
              desc={t('onboarding.featureModelsDesc')}
              palette={palette}
            />
            <FeatureRow
              icon={<LayersGlyph color={palette.iconColor} />}
              title={t('onboarding.featurePartsTitle')}
              desc={t('onboarding.featurePartsDesc')}
              palette={palette}
            />
            <FeatureRow
              icon={<BoltGlyph color={palette.iconColor} />}
              title={t('onboarding.featureFlowTitle')}
              desc={t('onboarding.featureFlowDesc')}
              palette={palette}
            />
          </div>

          {error !== null && (
            <div role="alert" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--dsw-alias-state-error-primary, #d4380d)' }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 20, display: 'grid', gap: 8 }}>
            <button
              ref={primaryRef}
              type="button"
              data-hq-onboarding-login=""
              onClick={() => { void login() }}
              disabled={busy}
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 12,
                border: 0,
                background: BRAND_RED,
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.7 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >{busy ? t('onboarding.loginBusy') : t('onboarding.login')}</button>
            <button
              type="button"
              data-hq-onboarding-skip=""
              onClick={dismiss}
              style={{
                width: '100%',
                padding: '8px 14px',
                borderRadius: 12,
                border: 0,
                background: 'transparent',
                color: palette.muted,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >{t('onboarding.skip')}</button>
          </div>
        </div>

        <div style={{
          padding: '12px 24px',
          background: palette.footer,
          borderTop: `1px solid ${palette.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12.5,
            color: palette.muted,
            cursor: 'pointer',
            userSelect: 'none',
          }}>
            <input
              type="checkbox"
              data-hq-onboarding-dont-show=""
              checked={dontShowAgain}
              onChange={(event) => { setDontShowAgain(event.target.checked) }}
              style={{ width: 14, height: 14, accentColor: BRAND_RED, margin: 0 }}
            />
            <span>{t('onboarding.dontShow')}</span>
          </label>
          <button
            type="button"
            data-hq-onboarding-create=""
            onClick={() => { void login() }}
            disabled={busy}
            style={{
              border: 0,
              background: 'transparent',
              padding: 0,
              color: palette.muted,
              fontSize: 12,
              cursor: busy ? 'default' : 'pointer',
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >{t('onboarding.createAccount')}</button>
        </div>
      </div>
    </div>
  )
}
