/**
 * `@huaqiu/dsh-tool-symbol-footprint` — Component Gen workspace (browser half).
 *
 * Two sidebar entry rows (封装生成 / Symbol 生成), injected between the shell's
 * New Session button and the workspace browser (task-board style), + one
 * `shell.overlay` that draws the `@huaqiu/component-gen-app` workspace. A
 * single shared `{ open, page }` state drives both rows and the overlay, and
 * the app is the single HIL driver — generation runs through the plugin's own
 * webServer routes (`/api/v1/huaqiu/component-gen/*`) with no agent tool
 * involved.
 *
 * Copy follows the host UI language: the sidebar rows translate through the
 * app's copy pack (`app.footprintTitle` / `app.symbolTitle` / tooltips) and
 * re-apply whenever `<html lang>` changes (`dsh-client-locale` rewrites the
 * attribute), so both dsh web and the HQ Edge host stay in sync without a
 * `locale` service dependency.
 *
 * Auth is the `huaqiuAuth` CLIENT service (structural, never imported): the
 * same sanctioned source the GenHit card uses. The ports adapter only
 * consumes its public surface.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  ComponentGenApp, createHttpPorts, injectAppStyles, translateFor,
  type ComponentGenAuthPort, type ComponentGenPage, type ComponentGenPorts,
} from '@huaqiu/component-gen-app'
import {
  FOOTPRINT_ENTRY_SELECTOR, FOOTPRINT_ICON, SYMBOL_ENTRY_SELECTOR, SYMBOL_ICON,
  mountComponentGenSidebarEntries,
} from './sidebar-entry.js'
import type { HuaqiuAuthClientService } from './index.js'
import { placeSupportOf, type HqEdgePlaceLike } from './place.js'

/** Shared workspace state for the two sidebar actions + the overlay. */
interface WorkspaceState {
  open: boolean
  page: ComponentGenPage
}
const listeners = new Set<() => void>()
const state: WorkspaceState = { open: false, page: 'footprint' }

function announce(): void {
  for (const fn of [...listeners]) {
    try { fn() } catch { /* one bad subscriber must not strand the rest */ }
  }
}

/** Subscribe to workspace state changes (active bridge for sidebar entries). */
export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function setOpen(open: boolean): void {
  if (state.open === open) return
  state.open = open
  announce()
}

function openPage(page: ComponentGenPage): void {
  state.page = page
  state.open = true
  announce()
}

/** Toggle: close when already open on this page, otherwise open it. */
function togglePage(page: ComponentGenPage): void {
  if (state.open && state.page === page) setOpen(false)
  else openPage(page)
}

function useWorkspaceState(): WorkspaceState {
  const [, force] = useState(0)
  useEffect(() => {
    const listener = (): void => force((n) => n + 1)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return { open: state.open, page: state.page }
}

/** Host UI language from `<html lang>` (same heuristic as the GenHit theme). */
function detectLocale(): string | undefined {
  if (typeof document !== 'undefined') {
    const tag = document.documentElement?.getAttribute('lang')
    if (tag) {
      const primary = tag.toLowerCase().split('-')[0]
      if (primary === 'zh' || primary === 'en') return primary
    }
  }
  return undefined
}

/** Latest resolved UI language (zh/en/undefined) driving the sidebar copy. */
let currentLang: string | undefined = detectLocale()

let localeObserver: MutationObserver | null = null
/**
 * Watch `<html lang>` — `dsh-client-locale` rewrites it on every language
 * change (dsh web) and HQ Edge mirrors it too. On change, re-resolve the
 * language and announce so the sidebar rows re-apply their localized labels
 * and the open overlay re-renders with the new language.
 */
function startLocaleObserver(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || !document.documentElement) {
    return () => {}
  }
  if (localeObserver === null) {
    localeObserver = new MutationObserver(() => {
      const next = detectLocale()
      if (next !== currentLang) {
        currentLang = next
        announce()
      }
    })
    localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  }
  return () => {
    if (localeObserver !== null) {
      localeObserver.disconnect()
      localeObserver = null
    }
  }
}

/**
 * Build the workspace ports: component-gen HTTP + dsh-auth client auth.
 *
 * When the host provides `hqEdge` (edge-bridge browser half, HQ Edge-hosted
 * DSH only), a Place port is attached so generated symbols/footprints can be
 * sent straight into the editor. Editor compatibility is resolved lazily at
 * every call via the shared frontend matrix — standalone DSH (no `hqEdge`
 * service) simply gets no Place capability.
 */
export function createWorkspacePorts(
  auth: HuaqiuAuthClientService['auth'] | undefined,
  getHqEdge?: () => HqEdgePlaceLike | undefined,
  track?: ComponentGenPorts['track'],
): ComponentGenPorts {
  const authPort: ComponentGenAuthPort = {
    isAuthenticated: async () => auth?.isAuthenticated() ?? false,
    getUserInfo: async () => {
      try { return (await auth?.getUserInfo()) ?? null } catch { return null }
    },
    login: async () => {
      try { await auth?.login?.() } catch { /* dsh-auth owns the dialog */ }
    },
    onAuthStateChanged: (cb) => {
      if (!auth?.onAuthStateChanged) return () => {}
      return auth.onAuthStateChanged((info) => cb(!!info))
    },
  }
  const place = getHqEdge
    ? {
        canPlace: (type: 'symbol' | 'footprint'): boolean =>
          placeSupportOf(getHqEdge, type)?.() != null,
        placeArtifact: async (request: { type: 'symbol' | 'footprint'; artifactUri: string; filename?: string }) => {
          const support = placeSupportOf(getHqEdge, request.type)?.()
          if (!support) throw new Error('placement unavailable in the current editor')
          return support.place(request)
        },
      }
    : undefined
  const ports = createHttpPorts({
    base: '/api/v1/huaqiu/component-gen',
    artifactsBase: '/api/v1/huaqiu/artifacts',
    auth: authPort,
    ...(place ? { place } : {}),
  })
  return track ? { ...ports, track } : ports
}

/** Full-viewport overlay panel hosting the app. */
function WorkspaceOverlay({ ports }: { ports: ComponentGenPorts }): JSX.Element {
  const { open, page } = useWorkspaceState()
  const lang = detectLocale()
  const close = useCallback(() => setOpen(false), [])
  // Esc closes the workspace popup, matching the backdrop-click close. Active
  // only while the overlay is open; removed on close/unmount.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])
  if (!open) return <></>
  // Chrome follows dsh's Modal primitive (which the settings dialog shares):
  // mask-1 + mask-blur overlay, layer-2 surface with elevation-prominent,
  // r24 panel, l2 scrollbar rebinding.
  const panelStyle = {
    position: 'relative' as const,
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    width: 'min(880px, 100%)',
    height: 'min(860px, 100%)',
    overflow: 'hidden',
    borderRadius: '24px',
    background: 'var(--dsw-alias-bg-layer-2)',
    boxShadow: 'var(--dsw-elevation-prominent)',
    '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
    '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
  } as CSSProperties
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(8px, 2.5vh, 28px)',
        boxSizing: 'border-box',
        pointerEvents: 'auto',
      }}
    >
      <div
        aria-hidden="true"
        onClick={(e) => { if (e.target === e.currentTarget) close() }}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--dsw-alias-bg-mask-1)',
          backdropFilter: 'var(--dsw-mask-blur)',
        }}
      />
      <div style={panelStyle}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px' }}>
          <ComponentGenApp ports={ports} page={page} lang={lang} onClose={close} />
        </div>
      </div>
    </div>
  )
}

/**
 * Register the workspace UI. Call from the client `apply()`; returns a
 * disposer. `auth` is the `huaqiuAuth` client service (may be absent).
 * `getHqEdge` lazily resolves the `hqEdge` service (absent in standalone DSH
 * — Place then stays hidden).
 */
export function installWorkspace(
  ctx: {
    slots?: { inject(key: string, callback: () => () => void): () => void; register(spec: { name: string; key?: string; id?: string; order?: number }, component: unknown): unknown }
    get?(name: string): unknown
  },
  auth: HuaqiuAuthClientService['auth'] | undefined,
): () => void {
  const disposers: Array<() => void> = []
  const getHqEdge = (): HqEdgePlaceLike | undefined =>
    (typeof ctx.get === 'function' ? ctx.get('hqEdge') : undefined) as HqEdgePlaceLike | undefined
  const getAnalytics = () => typeof ctx.get === 'function' ? ctx.get('huaqiuAnalytics') as { track?(event: string, properties?: Record<string, unknown>): void } | undefined : undefined
  const ports = createWorkspacePorts(auth, getHqEdge, (event, properties) => getAnalytics()?.track?.(event, properties))
  disposers.push(startLocaleObserver())

  // Two task-board-style sidebar rows (between New Session and the workspace
  // browser). Ordered deterministically: footprint first, symbol second.
  // Labels/tooltips are functions so the shared refresh subscription re-applies
  // them whenever the UI language changes.
  disposers.push(mountComponentGenSidebarEntries([
    {
      selector: FOOTPRINT_ENTRY_SELECTOR,
      attribute: 'data-hqcg-footprint-entry',
      icon: FOOTPRINT_ICON,
      label: () => translateFor(currentLang)('app.footprintTitle'),
      tooltip: () => translateFor(currentLang)('app.footprintTooltip'),
      position: 'before',
      onToggle: () => {
        togglePage('footprint')
        // 神策埋点：点击封装生成
        getAnalytics()?.track?.('click_generate_footprint')
      },
      isOpen: () => state.open && state.page === 'footprint',
    },
    {
      selector: SYMBOL_ENTRY_SELECTOR,
      attribute: 'data-hqcg-symbol-entry',
      icon: SYMBOL_ICON,
      label: () => translateFor(currentLang)('app.symbolTitle'),
      tooltip: () => translateFor(currentLang)('app.symbolTooltip'),
      position: 'after',
      onToggle: () => {
        togglePage('symbol')
        // 神策埋点：点击符号生成
        getAnalytics()?.track?.('click_generate_symbol')
      },
      isOpen: () => state.open && state.page === 'symbol',
    },
  ], subscribeWorkspace))

  const slots = ctx.slots
  if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    const Overlay = (): JSX.Element => <WorkspaceOverlay ports={ports} />
    disposers.push(slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'huaqiu-component-gen' }, Overlay) as () => void))
  }

  injectAppStyles()

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
    disposers.length = 0
  }
}
