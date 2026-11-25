// @vitest-environment jsdom
/**
 * The tool-result watcher that turns an agent-placed order into a Browser tab.
 *
 * Two behaviours matter. It must find the page URL inside a real transcript
 * shape (nested nodes, JSON in one text block), and it must not resurrect a
 * historical order every time the page mounts — only URLs that appear after the
 * watcher has seen the conversation it inherited are opened.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const opened: string[] = []
vi.mock('../src/client/order-page.js', () => ({
  openOrderPage: (url: string) => { opened.push(url) },
  setOrderPageOpener: () => {},
}))

import { OrderWatcher, orderUrlsIn } from '../src/client/order-watcher.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PCB_URL = 'https://www.hqpcb.com/mycenter/orders/pcb/quote?type=PCB&id=42&guid=ab&tid=354'
const SMT_URL = 'https://www.hqpcb.com/mycenter/orders/smt/quote?id=99&source=bom'

function result(name: string, payload: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'tool-result',
    call: { name },
    callId: `call-${name}-${String(Math.random())}`,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...extra,
  }
}

describe('orderUrlsIn', () => {
  it('finds both order tools, including nested results', () => {
    const nodes = [
      { kind: 'assistant', children: [result('hardware_place_pcb_order', { ok: true, orderUrl: PCB_URL })] },
      result('hardware_place_smt_order', { ok: true, orderUrl: SMT_URL }),
    ]
    expect(orderUrlsIn(nodes)).toEqual([PCB_URL, SMT_URL])
  })

  it('ignores other tools and non-order results', () => {
    const nodes = [
      result('hardware_fabricate', { ok: true, orderUrl: PCB_URL }),
      result('hardware_place_pcb_order', { ok: false, error: { code: 'package-invalid' } }),
      { kind: 'tool-result', call: { name: 'hardware_place_pcb_order' }, content: [{ type: 'text', text: 'not json' }] },
    ]
    expect(orderUrlsIn(nodes)).toEqual([])
  })

  it('opens one tab per order even when the URL is repeated', () => {
    const nodes = [
      result('hardware_place_pcb_order', { orderUrl: PCB_URL }),
      result('hardware_place_pcb_order', { orderUrl: PCB_URL }),
    ]
    expect(orderUrlsIn(nodes)).toEqual([PCB_URL])
  })
})

describe('OrderWatcher', () => {
  it('opens a tab for a newly placed order and never for the inherited history', async () => {
    opened.length = 0
    let nodes: unknown[] = [result('hardware_place_pcb_order', { orderUrl: PCB_URL })]
    const useChat = ((selector: (snapshot: unknown) => unknown): unknown =>
      selector({ legacy: { nodes } })) as never

    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(OrderWatcher, { useChat }))
    })
    // The order that already existed when the panel mounted stays where it was.
    expect(opened).toEqual([])

    nodes = [...nodes, result('hardware_place_smt_order', { orderUrl: SMT_URL })]
    await act(async () => {
      root.render(createElement(OrderWatcher, { useChat }))
    })
    expect(opened).toEqual([SMT_URL])

    // Re-rendering the same transcript must not re-open the same page.
    await act(async () => {
      root.render(createElement(OrderWatcher, { useChat }))
    })
    expect(opened).toEqual([SMT_URL])

    await act(async () => { root.unmount() })
  })
})
