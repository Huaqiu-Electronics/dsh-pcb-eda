/**
 * Where a placed order page opens.
 *
 * The requirement is blunt: inside DSH, not in the OS browser. The fallback is
 * only for a Host whose client has no Browser tab, and the test pins that order
 * of preference so a future edit cannot quietly hand the page back to `open`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = { opened: [] as string[] }
vi.mock('../src/client/transport.js', () => ({
  openOrderUrl: async (url: string) => {
    calls.opened.push(url)
    return { launched: true, command: 'open' }
  },
}))

import { openOrderPage, setOrderPageOpener } from '../src/client/order-page.js'

const URL_ONE = 'https://www.hqpcb.com/mycenter/orders/pcb/quote?type=PCB&id=1&guid=a&tid=354'

describe('order page placement', () => {
  beforeEach(() => { calls.opened.length = 0 })

  it('uses the DSH tab opener when the client has one', () => {
    const seen: string[] = []
    setOrderPageOpener(url => {
      seen.push(url)
      return true
    })
    openOrderPage(URL_ONE)
    expect(seen).toEqual([URL_ONE])
    expect(calls.opened).toEqual([])
  })

  it('falls back to the host route when no tab can open', async () => {
    setOrderPageOpener(() => false)
    openOrderPage(URL_ONE)
    await vi.waitFor(() => { expect(calls.opened).toEqual([URL_ONE]) })
  })

  it('treats a throwing opener as "no tab", not as a lost order', async () => {
    setOrderPageOpener(() => { throw new Error('no browser tab type') })
    openOrderPage(URL_ONE)
    await vi.waitFor(() => { expect(calls.opened).toEqual([URL_ONE]) })
  })

  it('ignores an empty URL', () => {
    const seen: string[] = []
    setOrderPageOpener(url => { seen.push(url); return true })
    openOrderPage('')
    expect(seen).toEqual([])
    expect(calls.opened).toEqual([])
  })
})
