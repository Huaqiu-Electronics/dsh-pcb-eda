// @vitest-environment jsdom
/**
 * Regression guard: the workspace popup opened by our sidebar tool buttons
 * closes on Escape (in addition to backdrop-click).
 *
 * Drives the real `installWorkspace` path — mounts the two sidebar rows, opens
 * the footprint workspace by clicking the injected row, then dispatches a
 * window `keydown` Escape and asserts the overlay unmounts. The app module is
 * stubbed so no history fetch fires in jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { installWorkspace } from '../src/client/workspace.jsx'

// React 18 `act()` environment flag — silences the
// "not configured to support act()" warnings in jsdom.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@huaqiu/component-gen-app', () => ({
  ComponentGenApp: () => <div className="cga-stub" />,
  createHttpPorts: () => ({}),
  injectAppStyles: () => {},
  removeAppStyles: () => {},
  translateFor: () => (key: string) => key,
  translate: (lang?: string, key?: string) => key ?? '',
  defaultT: (key: string) => key,
}))

/** Minimal dsh sidebar shell so the injected rows can anchor after New Session. */
function mountShell(): void {
  const column = document.createElement('div')
  column.setAttribute('data-pane', 'sidebar')
  const root = document.createElement('div')
  const logoRow = document.createElement('div')
  logoRow.className = 'logoRow'
  const newBtn = document.createElement('button')
  newBtn.className = 'newSession'
  newBtn.textContent = '新会话'
  logoRow.appendChild(newBtn)
  root.appendChild(logoRow)
  column.appendChild(root)
  document.body.appendChild(column)
}

let root: Root | undefined
let workspaceDispose: (() => void) | undefined

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  workspaceDispose?.()
  workspaceDispose = undefined
  if (root) {
    act(() => { root!.unmount() })
    root = undefined
  }
  document.body.innerHTML = ''
})

it('closes the workspace popup on Escape', () => {
  mountShell()

  // installWorkspace registers the overlay through the (fake) slots and mounts
  // the two sidebar rows.
  const registrations = new Map<string, unknown>()
  const ctx = {
    slots: {
      // The runtime invokes the inject callback immediately to register the slot.
      inject: (_key: string, callback: () => () => void): (() => void) => callback(),
      register: (spec: { name: string }, component: unknown): unknown => {
        registrations.set(spec.name, component)
        return () => {}
      },
    },
  }
  workspaceDispose = installWorkspace(ctx as never, undefined)

  const Overlay = registrations.get('shell.overlay') as (() => ReactElement) | undefined
  expect(Overlay).toBeTruthy()

  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(Overlay ? <Overlay /> : null) })

  // Closed initially.
  expect(container.querySelector('.cga-stub')).toBeNull()

  // Open the footprint workspace by clicking the injected sidebar row.
  const foot = document.querySelector<HTMLButtonElement>('[data-hqcg-footprint-entry]')!
  expect(foot).toBeTruthy()
  act(() => { foot.click() })
  expect(container.querySelector('.cga-stub')).not.toBeNull()

  // Escape closes the popup.
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(container.querySelector('.cga-stub')).toBeNull()

  // A non-Escape key does not close it — reopen then verify.
  act(() => { foot.click() })
  expect(container.querySelector('.cga-stub')).not.toBeNull()
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  })
  expect(container.querySelector('.cga-stub')).not.toBeNull()
})

it('tracks click_generate_symbol whenever its sidebar entry is clicked', () => {
  mountShell()
  const track = vi.fn()
  const ctx = {
    get: (name: string): unknown => name === 'huaqiuAnalytics' ? { track } : undefined,
  }
  workspaceDispose = installWorkspace(ctx as never, undefined)

  const symbol = document.querySelector<HTMLButtonElement>('[data-hqcg-symbol-entry]')!
  const footprint = document.querySelector<HTMLButtonElement>('[data-hqcg-footprint-entry]')!

  symbol.click()
  expect(track).toHaveBeenCalledTimes(1)
  expect(track).toHaveBeenLastCalledWith('click_generate_symbol')

  // The analytics contract counts sidebar-entry clicks, including a toggle.
  symbol.click()
  expect(track).toHaveBeenCalledTimes(2)
  expect(track).toHaveBeenLastCalledWith('click_generate_symbol')

  // Navigating away and clicking Symbol continues to emit the same event.
  footprint.click()
  track.mockClear()
  symbol.click()
  expect(track).toHaveBeenCalledOnce()
  expect(track).toHaveBeenLastCalledWith('click_generate_symbol')
})

it('tracks click_generate_footprint whenever its sidebar entry is clicked', () => {
  mountShell()
  const track = vi.fn()
  const ctx = {
    get: (name: string): unknown => name === 'huaqiuAnalytics' ? { track } : undefined,
  }
  workspaceDispose = installWorkspace(ctx as never, undefined)

  const footprint = document.querySelector<HTMLButtonElement>('[data-hqcg-footprint-entry]')!
  const symbol = document.querySelector<HTMLButtonElement>('[data-hqcg-symbol-entry]')!

  footprint.click()
  expect(track).toHaveBeenCalledTimes(1)
  expect(track).toHaveBeenLastCalledWith('click_generate_footprint')

  // The analytics contract counts sidebar-entry clicks, including a toggle.
  footprint.click()
  expect(track).toHaveBeenCalledTimes(2)
  expect(track).toHaveBeenLastCalledWith('click_generate_footprint')

  // Navigating away and clicking Footprint continues to emit the same event.
  symbol.click()
  track.mockClear()
  footprint.click()
  expect(track).toHaveBeenCalledOnce()
  expect(track).toHaveBeenLastCalledWith('click_generate_footprint')
})

it('tracks sidebar clicks when analytics becomes available after workspace installation', () => {
  mountShell()
  const track = vi.fn()
  let analytics: { track: typeof track } | undefined
  const ctx = {
    get: (name: string): unknown => name === 'huaqiuAnalytics' ? analytics : undefined,
  }
  workspaceDispose = installWorkspace(ctx as never, undefined)
  analytics = { track }

  document.querySelector<HTMLButtonElement>('[data-hqcg-symbol-entry]')!.click()
  document.querySelector<HTMLButtonElement>('[data-hqcg-footprint-entry]')!.click()

  expect(track).toHaveBeenCalledWith('click_generate_symbol')
  expect(track).toHaveBeenCalledWith('click_generate_footprint')
})
