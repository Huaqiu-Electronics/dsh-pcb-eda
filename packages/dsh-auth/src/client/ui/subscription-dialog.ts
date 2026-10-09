/**
 * The subscription dialog — a real modal (backdrop + centered card + iframe)
 * for `gen.eda.cn/subscription`, mirroring the login dialog's DOM pattern
 * (`ui/login-dialog.ts`): a fixed full-viewport semi-transparent backdrop +
 * centered host-surface card + the subscription iframe.
 *
 * WHY A CARD AND NOT A FULL-VIEWPORT IFRAME
 *
 * Same reason as the login dialog: the iframe element sits on top of the
 * host page, and Blink paints a WHITE base canvas behind any transparent
 * region of the embedded doc. Putting the iframe inside a host-painted card
 * masks that white in both light and dark themes (the card surface shows
 * through wherever the embedded doc is transparent).
 *
 * SIZING: the subscription page prefers 1400×740 (`SUBSCRIPTION_PREFERRED_SIZE`,
 * shared with the host-side native dialog via DialogService.OpenUrl). The card
 * clamps to the viewport (`min(96vw, width)` × `min(92vh, height)`) so it can
 * never overflow a small host window; the iframe fills the card.
 *
 * Close paths: backdrop click, the × button, and Escape. Unlike the login
 * embed there is no postMessage close contract to honor — the page is
 * `gen.eda.cn/subscription`, not `auth.eda.cn`.
 */
import { SUBSCRIPTION_PREFERRED_SIZE } from '../lib.js'
import { translate } from '../i18n.js'
import { getCurrentLocale, getCurrentSurfaceColor, subscribeUiEnv, syncUiEnv } from '../ui-env.js'

/** Aria / data attribute names — stable so tests and CSS can target them. */
export const SUB_DIALOG_OVERLAY_ATTR = 'data-hq-sub-dialog'
export const SUB_DIALOG_CARD_ATTR = 'data-hq-sub-dialog-card'
export const SUB_DIALOG_IFRAME_ATTR = 'data-hq-sub-dialog-iframe'
export const SUB_DIALOG_CLOSE_ATTR = 'data-hq-sub-dialog-close'

let container: HTMLDivElement | null = null
let unsubscribe: (() => void) | null = null

/**
 * Open the subscription dialog. Idempotent: a second call while open is a
 * no-op. `size` overrides the default 1400×740 preferred size (clamped to the
 * viewport).
 */
export function openSubscriptionDialog(
  url: string,
  options: { size?: { width?: number; height?: number } } = {},
  onClose?: () => void,
): void {
  if (container) return
  syncUiEnv()
  const locale = getCurrentLocale()

  const width = Math.max(320, options.size?.width ?? SUBSCRIPTION_PREFERRED_SIZE.width)
  const height = Math.max(240, options.size?.height ?? SUBSCRIPTION_PREFERRED_SIZE.height)

  const root = document.createElement('div')
  root.setAttribute(SUB_DIALOG_OVERLAY_ATTR, '')
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'width:100vw',
    'height:100vh',
    'border:0',
    'z-index:2147483646',
    'background:rgba(0, 0, 0, 0.55)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'box-sizing:border-box',
  ].join(';')

  const card = document.createElement('div')
  card.setAttribute(SUB_DIALOG_CARD_ATTR, '')
  const applyCardColors = (): void => {
    card.style.cssText = [
      `width:min(96vw, ${width}px)`,
      `height:min(92vh, ${height}px)`,
      'border-radius:12px',
      'box-shadow:0 24px 48px rgba(0, 0, 0, 0.32)',
      'position:relative',
      'box-sizing:border-box',
      `background:${getCurrentSurfaceColor()}`,
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
    ].join(';')
  }
  applyCardColors()

  const closeButton = document.createElement('button')
  closeButton.setAttribute(SUB_DIALOG_CLOSE_ATTR, '')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', translate(locale, 'dialog.close'))
  closeButton.title = translate(locale, 'dialog.close')
  closeButton.textContent = '×'
  closeButton.style.cssText = [
    'position:absolute',
    'top:6px',
    'right:10px',
    'width:28px',
    'height:28px',
    'border:0',
    'background:transparent',
    'color:var(--dsw-alias-label-secondary, #5b6472)',
    'font-size:22px',
    'line-height:1',
    'cursor:pointer',
    'border-radius:6px',
    'padding:0',
    'z-index:1',
  ].join(';')
  closeButton.addEventListener('click', closeSubscriptionDialog)

  const iframe = document.createElement('iframe')
  iframe.setAttribute(SUB_DIALOG_IFRAME_ATTR, '')
  iframe.src = url
  iframe.title = translate(locale, 'subscription.dialogTitle')
  iframe.allow = 'clipboard-write'
  iframe.style.cssText = [
    'width:100%',
    'height:100%',
    'border:0',
    'border-radius:8px',
    `background:${getCurrentSurfaceColor()}`,
    'display:block',
    'flex:1 1 auto',
  ].join(';')

  card.appendChild(closeButton)
  card.appendChild(iframe)
  root.appendChild(card)
  document.body.appendChild(root)

  root.addEventListener('mousedown', backdropMouseDown)
  card.addEventListener('mousedown', stopPropagation)
  document.addEventListener('keydown', onKeyDown)

  // Track theme/locale flips so the card surface + iframe background follow
  // the host while the dialog is open.
  unsubscribe = subscribeUiEnv(() => {
    if (!container) return
    applyCardColors()
    iframe.style.background = getCurrentSurfaceColor()
    closeButton.title = translate(getCurrentLocale(), 'dialog.close')
    closeButton.setAttribute('aria-label', closeButton.title)
  })

  container = root
  onCloseCallback = onClose ?? null
}

/** Programmatic close (used by the auth client / tests). */
export function closeSubscriptionDialog(): void {
  if (!container) return
  container.remove()
  container = null
  document.removeEventListener('keydown', onKeyDown)
  unsubscribe?.()
  unsubscribe = null
  const cb = onCloseCallback
  onCloseCallback = null
  cb?.()
}

/** True while the subscription dialog is mounted. */
export function isSubscriptionDialogOpen(): boolean {
  return container !== null
}

let onCloseCallback: (() => void) | null = null

function backdropMouseDown(event: MouseEvent): void {
  if (event.target === container) closeSubscriptionDialog()
}

function stopPropagation(event: MouseEvent): void {
  event.stopPropagation()
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    closeSubscriptionDialog()
  }
}
