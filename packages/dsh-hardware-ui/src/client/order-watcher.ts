/**
 * Put an order page into the right panel as soon as an order tool finishes.
 *
 * The panel's own confirm button can open a tab directly, but an agent-driven
 * order ends inside a tool result, where the host has no client context. DSH's
 * established way to close that gap is a session-scoped slot: this watcher sits
 * in the session header, renders nothing, and reads the transcript the client
 * already has. When a `hardware_place_*_order` result carrying an `orderUrl`
 * appears, it calls the same opener the panel uses, so the page lands in a
 * Browser tab next to the board instead of in the OS browser.
 *
 * Why it does not open historical orders: the first snapshot a watcher sees is
 * the conversation that already existed when it mounted. Those URLs are left
 * alone — a reload or a session switch must not resurrect old order tabs — and
 * only URLs that appear afterwards are opened. `opened` then keeps one order
 * from opening twice when several sessions are mounted at once.
 *
 * @module
 */
import { useEffect, useRef } from 'react'
import { openOrderPage } from './order-page.js'

/** Transcript hooks the host injects into session-scoped slots. */
type UseNodes = <T>(selector: (snapshot: { nodes?: unknown[]; legacy?: { nodes?: unknown[] } } | undefined) => T) => T

interface WatcherProps {
  readonly useChat?: UseNodes
  readonly useSession?: UseNodes
}

interface Node {
  readonly kind?: string
  readonly call?: { readonly name?: string }
  readonly content?: unknown
  readonly children?: unknown
  readonly nodes?: unknown
  readonly subCalls?: unknown
}

/** Tools whose result carries an order page. */
const ORDER_TOOLS = new Set(['hardware_place_pcb_order', 'hardware_place_smt_order'])

const EMPTY: readonly unknown[] = []
const MAX_DEPTH = 100

/** Every order URL this transcript holds, oldest first. */
export function orderUrlsIn(nodes: readonly unknown[]): string[] {
  const urls: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    const node = value as Node
    if (node.kind === 'tool-result' && node.call?.name !== undefined && ORDER_TOOLS.has(node.call.name)) {
      const url = orderUrlOf(node)
      if (url !== undefined) urls.push(url)
    }
    for (const list of [node.children, node.nodes, node.subCalls]) {
      if (Array.isArray(list)) for (const child of list) visit(child, depth + 1)
    }
  }
  for (const node of nodes) visit(node, 0)
  return [...new Set(urls)]
}

/** The `orderUrl` field of a tool result, from whichever text block holds it. */
function orderUrlOf(node: Node): string | undefined {
  const blocks = Array.isArray(node.content) ? node.content : []
  for (const block of blocks) {
    const text = (block as { type?: string; text?: unknown }).type === 'text'
      ? (block as { text?: unknown }).text
      : undefined
    if (typeof text !== 'string' || !text.includes('orderUrl')) continue
    try {
      const value = JSON.parse(text) as { orderUrl?: unknown }
      if (typeof value.orderUrl === 'string' && value.orderUrl.startsWith('http')) return value.orderUrl
    } catch {
      // A tool result may carry other text blocks; only one of them is JSON.
    }
  }
  return undefined
}

/** Identity of one order, so two mounts cannot open the same page twice. */
function orderKey(url: string): string {
  try {
    return new URL(url).searchParams.get('id') ?? url
  } catch {
    return url
  }
}

const opened = new Set<string>()

/**
 * Render-nothing watcher: opens a Browser tab per newly placed order.
 * @param props - transcript hooks injected by the host.
 * @returns always `null`.
 */
export function OrderWatcher(props: WatcherProps): null {
  const chat = props.useChat === undefined ? EMPTY : props.useChat(snapshot => snapshot?.legacy?.nodes ?? EMPTY)
  const session = props.useSession === undefined ? EMPTY : props.useSession(snapshot => snapshot?.nodes ?? EMPTY)
  const nodes = chat.length > 0 ? chat : session
  const baselined = useRef(false)

  useEffect(() => {
    const urls = orderUrlsIn(nodes)
    if (!baselined.current) {
      baselined.current = true
      // Remember what was already on screen: these are history, not new orders.
      for (const url of urls) opened.add(orderKey(url))
      return
    }
    for (const url of urls) {
      const key = orderKey(url)
      if (opened.has(key)) continue
      opened.add(key)
      openOrderPage(url)
    }
  }, [nodes])

  return null
}
