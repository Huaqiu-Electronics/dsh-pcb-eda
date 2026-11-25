/**
 * Open a placed order's page where the user already is.
 *
 * DSH has a `browser` tab kind (`sidebarRight.openTab('browser', { params: { url } })`),
 * so an order page belongs in the right panel beside the board it was made from.
 * Handing it to the OS browser instead splits the user's attention across two
 * windows and loses the page as soon as the browser is closed.
 *
 * The opener is registered by `apply` because only that scope holds the client
 * context; everything that produces an order URL — the panel's confirm button
 * and the tool-result watcher — goes through this one function, so there is a
 * single place that decides where a page opens. The host route is kept as a
 * last resort for a Host whose client has no Browser tab (the page still opens,
 * just outside DSH), and `window.open` covers a client with no sidebar at all.
 *
 * @module
 */
import { openOrderUrl } from './transport.js'

/** One way to put a URL in front of the user; `true` means it succeeded. */
export type OrderPageOpener = (url: string) => boolean

let opener: OrderPageOpener | undefined

/** Install the client's own opener. Called once, from `apply`. */
export function setOrderPageOpener(next: OrderPageOpener): void {
  opener = next
}

/**
 * Show one order page: in a DSH Browser tab when the client has one.
 * @param url - the order page URL returned by the host.
 */
export function openOrderPage(url: string): void {
  if (url === '') return
  try {
    if (opener?.(url) === true) return
  } catch {
    // A tab that will not open is not a reason to lose the page.
  }
  void openOrderUrl(url).catch(() => {
    window.open(url, '_blank', 'noopener')
  })
}
