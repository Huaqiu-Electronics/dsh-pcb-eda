// @vitest-environment jsdom
/**
 * Ordering is one click.
 *
 * There is no confirmation dialog any more: the card's button *is* the decision,
 * so these tests hold that clicking uploads exactly once, that the page outside
 * the panel opens on the URL the backend returned, and that a second card (or a
 * second render) cannot slip a second order in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const orderApi = vi.hoisted(() => ({
  loadOrderConfig: vi.fn(),
  prepareFabrication: vi.fn(),
  placeOrder: vi.fn(),
  openOrderPage: vi.fn(),
}))

vi.mock('../src/client/transport.js', () => ({
  loadOrderConfig: orderApi.loadOrderConfig,
  prepareFabrication: orderApi.prepareFabrication,
  placeOrder: orderApi.placeOrder,
  messageOf: (error: unknown): string => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('../src/client/order-page.js', () => ({ openOrderPage: orderApi.openOrderPage }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { OrderPanel, type OrderPanelProps } from '../src/client/order.js'
import { COPY } from '../src/client/copy.js'

const CONFIG = { configured: true, baseUrl: 'https://www.eda.cn', hasToken: true, provider: 'huaqiu' }

const PACKAGE = {
  boardPath: 'C:/w/a.kicad_pcb',
  revision: 'rev1',
  generatedAt: '2026-11-27T00:00:00Z',
  facts: { layers: 2, widthMm: 20, heightMm: 10, thicknessMm: 1.6, minTrackMm: 0.15, minViaDrillMm: 0.3, outerOz: 1 },
  archive: { zipName: 'a-fabrication.zip', zipBytes: 1024, files: [{ name: 'a-F_Cu.gbr', bytes: 512 }] },
  assembly: { positions: 12, bomLines: 7, positionsBytes: 900, bomBytes: 700 },
}

const PLACED = {
  kind: 'pcb' as const,
  orderUrl: 'https://www.hqpcb.com/quote?type=PCB&id=99',
  launched: false,
  status: 'ready' as const,
  message: 'order created',
  archive: PACKAGE.archive,
}

let root: Root | undefined

function props(overrides: Partial<OrderPanelProps> = {}): OrderPanelProps {
  return {
    boardPath: 'C:/w/a.kicad_pcb',
    boardTitle: 'a.kicad_pcb',
    schematicPath: 'C:/w/a.kicad_sch',
    workspaceRoot: 'C:/w',
    session: 's1',
    configured: true,
    ...overrides,
  }
}

async function mount(component: OrderPanelProps): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<OrderPanel {...component} />) })
  // Settle the config probe and the package preparation.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  const panel = container.querySelector<HTMLElement>('[data-hardware-order]')
  if (panel === null) throw new Error('the order panel did not render')
  return panel
}

beforeEach(() => {
  orderApi.loadOrderConfig.mockResolvedValue(CONFIG)
  orderApi.prepareFabrication.mockResolvedValue(PACKAGE)
  orderApi.placeOrder.mockResolvedValue(PLACED)
  orderApi.openOrderPage.mockImplementation(() => {})
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  document.body.replaceChildren()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('one-click upload', () => {
  it('uploads from the card itself, with no confirmation step in between', async () => {
    const panel = await mount(props())
    // Nothing to confirm before the click either.
    expect(panel.querySelector('[data-hardware-order-confirm]')).toBeNull()
    expect(panel.querySelector('[data-hardware-order-ack]')).toBeNull()
    expect(panel.querySelector('[data-hardware-order-hint]')?.textContent).toBe(COPY.order.uploadHint)

    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[data-hardware-order-action=pcb]')!.click()
      await Promise.resolve()
    })

    expect(orderApi.placeOrder).toHaveBeenCalledTimes(1)
    const [kind, body] = orderApi.placeOrder.mock.calls[0]!
    expect(kind).toBe('pcb')
    expect(body).toMatchObject({ path: 'C:/w/a.kicad_pcb', schematic: 'C:/w/a.kicad_sch', cwd: 'C:/w', session: 's1', quantity: 20 })
    // The upload is the request; there is no consent flag to send.
    expect(Object.keys(body)).not.toContain('confirm')
    // The backend's URL, shown where the user is working.
    expect(orderApi.openOrderPage).toHaveBeenCalledExactlyOnceWith(PLACED.orderUrl)
    expect(panel.querySelector('[data-hardware-order-url]')?.textContent).toBe(PLACED.orderUrl)
  })

  it('uploads PCBA with the assembly package and the chosen quantity', async () => {
    orderApi.placeOrder.mockResolvedValue({ ...PLACED, kind: 'smt' })
    const panel = await mount(props())
    await act(async () => {
      panel.querySelector<HTMLSelectElement>('[data-hardware-order-quantity]')!.value = '100'
      panel.querySelector<HTMLSelectElement>('[data-hardware-order-quantity]')!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[data-hardware-order-action=pcba]')!.click()
      await Promise.resolve()
    })
    expect(orderApi.placeOrder.mock.calls[0]?.[0]).toBe('smt')
    expect(orderApi.placeOrder.mock.calls[0]?.[1]).toMatchObject({ quantity: 100 })
  })

  it('does not create a second order when the card is pressed twice', async () => {
    let release!: () => void
    orderApi.placeOrder.mockImplementation(() => new Promise(resolve => { release = () => { resolve(PLACED) } }))
    const panel = await mount(props())
    const pcb = panel.querySelector<HTMLButtonElement>('[data-hardware-order-action=pcb]')!
    act(() => { pcb.click(); pcb.click() })
    expect(orderApi.placeOrder).toHaveBeenCalledTimes(1)
    // Both cards wait while one upload runs.
    expect(panel.querySelector<HTMLButtonElement>('[data-hardware-order-action=pcba]')!.disabled).toBe(true)
    await act(async () => { release() })
  })

  it('places the kind the Place Order view already chose, once, as soon as it can', async () => {
    orderApi.placeOrder.mockResolvedValue({ ...PLACED, kind: 'smt' })
    const panel = await mount(props({ focus: 'smt' }))
    expect(orderApi.placeOrder).toHaveBeenCalledTimes(1)
    expect(orderApi.placeOrder.mock.calls[0]?.[0]).toBe('smt')
    // The chosen card shows the order instead of asking again.
    expect(panel.querySelector('[data-hardware-order-result=smt]')).not.toBeNull()
  })
})

describe('blocked before the click', () => {
  it('needs a signed-in account: the button stays disabled and nothing uploads', async () => {
    orderApi.loadOrderConfig.mockResolvedValue({ ...CONFIG, hasToken: false })
    const panel = await mount(props())
    const pcb = panel.querySelector<HTMLButtonElement>('[data-hardware-order-action=pcb]')!
    expect(pcb.disabled).toBe(true)
    expect(panel.textContent).toContain(COPY.order.signInToOrder)
    act(() => { pcb.click() })
    expect(orderApi.placeOrder).not.toHaveBeenCalled()
  })

  it('needs the package: a failed preparation leaves both buttons disabled', async () => {
    orderApi.prepareFabrication.mockRejectedValue(new Error('kicad-cli exited 1'))
    const panel = await mount(props())
    expect(panel.querySelector('[role=status]')?.textContent).toBe('kicad-cli exited 1')
    expect(panel.querySelector<HTMLButtonElement>('[data-hardware-order-action=pcb]')!.disabled).toBe(true)
  })
})
