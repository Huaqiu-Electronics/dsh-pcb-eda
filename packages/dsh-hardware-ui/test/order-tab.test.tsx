// @vitest-environment jsdom
/**
 * The order tab body.
 *
 * Two guarantees: the page is framed with enough sandbox for a real checkout,
 * and the user's access token never becomes text on screen — the header shows
 * the order id only.
 */
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { OrderTabBody } from '../src/client/order-tab.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const URL_WITH_TOKEN =
  'https://www.hqpcb.com/mycenter/orders/pcb/quote?type=PCB&id=4684707&guid=9a8e&tid=354&token=SECRET-TOKEN'

async function render(url: string | undefined): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(OrderTabBody, url === undefined ? {} : { url }))
  })
  return host
}

describe('OrderTabBody', () => {
  it('frames the order page with a checkout-capable sandbox', async () => {
    const host = await render(URL_WITH_TOKEN)
    const frame = host.querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe(URL_WITH_TOKEN)
    const sandbox = frame?.getAttribute('sandbox') ?? ''
    for (const flag of ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-downloads', 'allow-modals']) {
      expect(sandbox).toContain(flag)
    }
    // The token must not travel in a referrer.
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('never renders the access token as text, only the order id', async () => {
    const host = await render(URL_WITH_TOKEN)
    expect(host.textContent).toContain('4684707')
    // The href and iframe src must carry the token for the page to authenticate;
    // nothing the user reads may.
    expect(host.textContent).not.toContain('SECRET-TOKEN')
  })

  it('reads the URL from navigation params, which is how openTab passes it', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const useTabInfo = (): { tab: { id: string; navigation: { params: { url: string } } } } => ({
      tab: { id: 't1', navigation: { params: { url: URL_WITH_TOKEN } } },
    })
    await act(async () => {
      root.render(createElement(OrderTabBody, { useTabInfo }))
    })
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe(URL_WITH_TOKEN)
  })

  it('says so instead of framing nothing when no order is known', async () => {
    const host = await render(undefined)
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).not.toBe('')
  })
})
