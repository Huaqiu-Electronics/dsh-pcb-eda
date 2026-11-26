/**
 * The order page as a DSH tab.
 *
 * The page is a real hqpcb order form that must be finished in a browser; the
 * question is only *which* browser. A separate window loses the page as soon as
 * it is closed and leaves the user without the board they were looking at, so
 * this plugin contributes its own tab type and frames the page inside the panel.
 *
 * Why a tab of our own instead of DSH's `browser` kind: that kind belongs to
 * `@deepseek-ai/dsh-client-ui-sidebar-browser`, which this deployment does not
 * load (it is not in the profile's client batch). `openTab('browser', …)` would
 * target a kind nobody registered — the call would be a silent no-op — while our
 * own kind always exists wherever this plugin is active. The page sends no
 * `X-Frame-Options` and no `frame-ancestors`, so framing it is allowed.
 *
 * The token in the URL is the user's Huaqiu login. It is never rendered: the
 * header shows the order id instead, and the iframe is given
 * `referrerPolicy="no-referrer"` so the query cannot leak to a third party.
 *
 * @module
 */
import { createElement, type CSSProperties, type ReactNode } from 'react'
import { COPY, HARDWARE_UI_NS } from './copy.js'
import { C, MONO } from './theme.js'

/** Tab kind `openTab` names for an order page. */
export const ORDER_TAB_KIND = 'hardware-order'
/** Implementation identity of the order tab body. */
export const ORDER_TAB_ID = '@huaqiu/dsh-hardware-ui/order'

/** The slice of tab info this body reads. */
interface TabInfo {
  readonly tab: {
    readonly id: string
    readonly navigation: {
      readonly params?: Readonly<Record<string, unknown>>
      readonly revision?: number
    }
  }
}

export interface OrderTabProps {
  /** Standard kit hook supplied by the pane tab seat. */
  readonly useTabInfo?: () => TabInfo
  /** Direct URL, used by tests and by a tab seeded without navigation params. */
  readonly url?: string
}

const BAR: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 34,
  borderBottom: `1px solid ${C.borderSoft}`, background: C.base, flex: '0 0 auto',
}
const LABEL: CSSProperties = { fontSize: 11.5, fontWeight: 600, color: C.text }
const ADDRESS: CSSProperties = {
  flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 10.5, color: C.text3,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const LINK: CSSProperties = {
  fontSize: 10.5, color: C.accent, textDecoration: 'none', flex: '0 0 auto',
}

/** The order id, which is the only part of the URL that is safe to show. */
function orderLabel(url: string): string {
  try {
    const id = new URL(url).searchParams.get('id')
    return id === null ? COPY.order.tabTitle : COPY.order.tabOrder(id)
  } catch {
    return COPY.order.tabTitle
  }
}

/**
 * One order page: a slim header plus the page itself.
 * @param props - tab info from the seat, or a direct URL.
 * @returns the framed order page.
 */
export function OrderTabBody(props: OrderTabProps): ReactNode {
  const params = props.useTabInfo?.().tab.navigation.params
  const fromParams = typeof params?.url === 'string' ? params.url : undefined
  const url = fromParams ?? props.url
  if (url === undefined || url === '') {
    return createElement('div', { style: { padding: 16, color: C.text3, fontSize: 12 } }, COPY.order.tabMissing)
  }
  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    createElement(
      'div',
      { style: BAR },
      createElement('span', { style: LABEL }, COPY.order.tabTitle),
      createElement('span', { style: ADDRESS, title: COPY.order.tabAddressHint }, orderLabel(url)),
      createElement('a', {
        href: url, target: '_blank', rel: 'noreferrer', style: LINK,
      }, COPY.order.openInSystemBrowser),
    ),
    createElement('iframe', {
      src: url,
      title: COPY.order.tabTitle,
      // A payment page needs scripts, forms, popups and downloads; the framed
      // origin is hqpcb.com and this app is localhost, so same-origin access
      // stays impossible across the boundary.
      sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-downloads allow-modals',
      referrerPolicy: 'no-referrer',
      style: { flex: '1 1 auto', width: '100%', border: 0, background: '#fff' },
    }),
  )
}

/** Registration face for the order tab body. */
export function orderTabRegistration(): {
  readonly name: string
  readonly key: string
  readonly locale: string
  readonly inject: () => Record<string, never>
} {
  return { name: 'sidebar.right.pane.tab', key: ORDER_TAB_ID, locale: HARDWARE_UI_NS, inject: () => ({}) }
}
