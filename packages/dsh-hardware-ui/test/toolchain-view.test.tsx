// @vitest-environment jsdom
/**
 * The settings card's post-save state, and where the toast layer sits.
 *
 * Two things the user asked for are DOM facts, not controller facts: after a
 * successful "Validate and save" the card shows a success badge instead of the
 * resolved executable path, and the toast stack paints above the dimming
 * overlay. A controller test cannot see either, because both only exist in what
 * the card renders.
 */
import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import { ToolchainCard, ToolchainToastHost } from '../src/client/toolchain-view.js'
import type { ToolchainController } from '../src/client/toolchain.js'
import type { ToolchainId, ToolchainSnapshot } from '../src/client/toolchain.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const EXE = 'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe'

const controller = {
  subscribe: () => () => {},
  save: () => {},
  getSnapshot: () => base,
  setDraft: () => {},
  openPicker: () => {},
  install: () => {},
  cancel: () => {},
  discover: () => {},
} as unknown as ToolchainController

function snapshot(patch: Partial<ToolchainSnapshot> = {}): ToolchainSnapshot {
  return {
    status: {
      kicad: {
        id: 'kicad',
        state: 'configured',
        label: 'KiCad',
        installPath: 'C:\\Program Files\\KiCad\\10.0',
        cliPath: EXE,
        version: '10.0.7',
        discovery: { state: 'done' },
      },
      official: {},
    },
    jobs: {},
    drafts: { kicad: 'C:\\Program Files\\KiCad\\10.0' },
    checks: { kicad: { state: 'valid', installPath: 'C:\\Program Files\\KiCad\\10.0', version: '10.0.7' } },
    confirmed: {},
    saving: null,
    toasts: [],
    ...patch,
  } as unknown as ToolchainSnapshot
}

const base = snapshot()

const withToast = snapshot({ toasts: [{ id: 1, text: 'Saved', tone: 'ok' }] } as Partial<ToolchainSnapshot>)
const toastController = {
  ...(controller as unknown as Record<string, unknown>),
  dismiss: () => {},
  getSnapshot: () => withToast,
} as unknown as ToolchainController

let host: HTMLDivElement | undefined

function mount(node: ReturnType<typeof createElement>): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => { root.render(node) })
  return host
}

function card(over: Partial<ToolchainSnapshot>, id: ToolchainId = 'kicad', variant: 'wizard' | 'settings' = 'settings'): HTMLDivElement {
  return mount(createElement(ToolchainCard, {
    tool: id,
    controller,
    snapshot: snapshot(over),
    variant,
  }))
}

describe('settings card after a save', () => {
  it('shows a success badge with the version and never the resolved executable path', () => {
    const el = card({ confirmed: { kicad: { at: 1, version: '10.0.7' } } })
    const badge = el.querySelector('[data-hardware-toolchain-confirmed="kicad"]')
    expect(badge).not.toBeNull()
    expect(badge!.textContent).toMatch(/Saved v10\.0\.7|已保存 v10\.0\.7/)
    expect(badge!.getAttribute('role')).toBe('status')
    expect(el.textContent).not.toContain(EXE)
    expect(el.textContent).not.toContain('C:\\Program Files\\KiCad')
  })

  it('drops back to no verdict once the confirmation expires, still without printing the path', () => {
    const el = card({ confirmed: {} })
    expect(el.querySelector('[data-hardware-toolchain-confirmed="kicad"]')).toBeNull()
    // Configured and in sync: the card stays quiet rather than restating "Not saved".
    expect(el.textContent).not.toContain('Not saved')
    expect(el.textContent).not.toContain(EXE)
  })

  it('reports the check state on the card root for walkthroughs', () => {
    expect(card({}).querySelector('[data-hardware-toolchain-card="kicad"]')!.getAttribute('data-hardware-toolchain-check')).toBe('valid')
    expect(card({ checks: { kicad: { state: 'invalid', error: 'No kicad-cli here' } }, drafts: { kicad: 'D:\\nope', solidcraft: '' } })
      .querySelector('[data-hardware-toolchain-card="kicad"]')!.getAttribute('data-hardware-toolchain-check')).toBe('invalid')
  })
})

describe('wizard badge says Ready once a tool is usable', () => {
  const pillOf = (el: HTMLDivElement): string =>
    el.querySelector('[data-hardware-toolchain-pill="kicad"]')?.textContent ?? ''

  it('reads Ready with the version when the Host already has the tool configured', () => {
    expect(pillOf(card({}, 'kicad', 'wizard'))).toMatch(/Ready \(v10\.0\.7\)|就绪（v10\.0\.7）/)
  })

  it('reads Ready for a path the Host just validated, even before it is saved', () => {
    expect(pillOf(card({
      status: { kicad: { id: 'kicad', state: 'missing', label: 'KiCad', discovery: { state: 'done' } } } as unknown as ToolchainSnapshot['status'],
    }, 'kicad', 'wizard'))).toMatch(/Ready|就绪/)
  })

  it('still says Ready when the Host is mid-flight but the saved root carries a version', () => {
    expect(pillOf(card({
      status: { kicad: { id: 'kicad', state: 'validating', label: 'KiCad', installPath: 'C:\\Program Files\\KiCad\\10.0', version: '10.0.7', discovery: { state: 'done' } } } as unknown as ToolchainSnapshot['status'],
      checks: {},
    }, 'kicad', 'wizard'))).toMatch(/Ready|就绪/)
  })

  it('still says Not configured when nothing is usable', () => {
    expect(pillOf(card({
      status: { kicad: { id: 'kicad', state: 'missing', label: 'KiCad', discovery: { state: 'done' } } } as unknown as ToolchainSnapshot['status'],
      checks: {},
      drafts: { kicad: '', solidcraft: '' },
    }, 'kicad', 'wizard'))).toMatch(/Not configured|未配置/)
  })
})

describe('executable picker scrim', () => {
  it('leaves the veil to the theme and keeps it lighter than the page scrim', () => {
    const el = card({
      picker: {
        tool: 'kicad',
        candidates: [{ path: 'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe', valid: true, version: '10.0.7' }],
        chosen: 'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe',
        nativePending: false,
      },
    } as unknown as Partial<ToolchainSnapshot>)
    const dialog = el.querySelector('[data-hardware-toolchain-picker="kicad"]') as HTMLElement | null
    expect(dialog).not.toBeNull()
    // Light and dark need different dimming, so the mask is a theme token rather
    // than a fixed alpha; the theme is what decides, the fallback only covers a
    // page without the token set.
    const background = dialog!.style.background
    expect(background).toContain('--dsw-alias-bg-mask-1')
    const alpha = Number(/rgba\(0,\s*0,\s*0,\s*([0-9.]+)\)/.exec(background)?.[1] ?? '0')
    expect(alpha).toBeLessThan(0.48)
  })
})

describe('toast layer', () => {
  it('paints above the dimming overlay', () => {
    const el = mount(createElement(ToolchainToastHost, { controller: toastController }))
    const hostEl = el.querySelector('[data-hardware-toolchain-toasts]') as HTMLElement | null
    expect(hostEl).not.toBeNull()
    expect(Number(hostEl!.style.zIndex)).toBeGreaterThan(2100)
  })
})
