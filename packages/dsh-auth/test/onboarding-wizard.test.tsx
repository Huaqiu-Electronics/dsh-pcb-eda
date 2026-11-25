// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HuaqiuOnboardingWizard } from '../src/client/ui/onboarding-wizard.jsx'
import { disposeAuth, registerAuth } from '../src/client/auth-state.js'
import { HostLoginDismissedError } from '../src/client/transport.js'
import { disposeUiEnv, syncUiEnv } from '../src/client/ui-env.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listener = (info: { token?: string; id?: string; nickname?: string } | null) => void

interface StubOptions {
  hostMode?: boolean
  /** The node half's stored「never show again」preference for this PC. */
  suppressed?: boolean
  /** Payload the initial `getUserInfo()` resolves; null = signed out. */
  initial?: { token?: string; id?: string; nickname?: string } | null
  /** Leave the initial credential read pending (models a slow host). */
  pending?: boolean
}

function stubAuth(options: StubOptions = {}) {
  let listener: Listener | null = null
  const login = vi.fn(async () => {})
  const suppressOnboarding = vi.fn(async () => {})
  const auth = {
    isHostMode: () => options.hostMode ?? true,
    isAuthenticated: () => false,
    getUserInfo: vi.fn(() => options.pending
      ? new Promise<null>(() => { /* never settles */ })
      : Promise.resolve(options.initial ?? null)),
    onAuthStateChanged: (cb: Listener) => {
      listener = cb
      return () => { listener = null }
    },
    login,
    isOnboardingSuppressed: vi.fn(async () => options.suppressed ?? false),
    suppressOnboarding,
    logout: vi.fn(async () => {}),
    getAccessToken: vi.fn(async () => null),
    getUserProfile: vi.fn(async () => null),
    getSubscriptionQuota: vi.fn(async () => null),
    getProfileUrl: () => null,
    getAiTokenUsage: vi.fn(async () => null),
    openSubscriptionDialog: vi.fn(async () => ({ status: 'signed-out' })),
  }
  return {
    auth: auth as never,
    login,
    suppressOnboarding,
    emit: (info: { token?: string; id?: string; nickname?: string } | null): void => {
      act(() => { listener?.(info) })
    },
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

function renderWizard(): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(<HuaqiuOnboardingWizard />) })
  mounted.push({ root, container })
  return container
}

/** Let the initial `getUserInfo()` microtask land, then re-render. */
async function flush(): Promise<void> {
  // Two rounds: the auth snapshot and the per-PC preference settle separately.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

function card(): HTMLElement | null {
  return document.querySelector('[data-hq-onboarding-card]')
}

function button(attr: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[${attr}]`)
  if (!el) throw new Error(`${attr} not rendered`)
  return el
}

function checkbox(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('[data-hq-onboarding-dont-show]')
  if (!el) throw new Error('checkbox not rendered')
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.setAttribute('lang', 'zh-CN')
  document.body.removeAttribute('data-ds-dark-theme')
  syncUiEnv()
  vi.spyOn(Storage.prototype, 'setItem')
  vi.spyOn(Storage.prototype, 'removeItem')
})

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => { root.unmount() })
    container.remove()
  }
  disposeAuth()
  disposeUiEnv()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('HuaqiuOnboardingWizard', () => {
  it('waits for the host session before deciding (no flash before resolution)', async () => {
    const stub = stubAuth({ pending: true })
    registerAuth(stub.auth)
    renderWizard()
    await flush()
    expect(card()).toBeNull()
  })

  it('pops the wizard for a signed-out operator in the embedded host', async () => {
    const stub = stubAuth({ initial: null })
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    expect(card()).not.toBeNull()
    // Chinese copy follows the host UI language.
    expect(card()?.textContent).toContain('解锁开箱即用的 AI 能力')
    expect(card()?.getAttribute('role')).toBe('dialog')
  })

  it('stays hidden when the host session is already authenticated', async () => {
    const stub = stubAuth({ initial: { token: 'tok', id: 'u1', nickname: 'Engineer' } })
    registerAuth(stub.auth)
    renderWizard()
    await flush()
    expect(card()).toBeNull()
  })

  it('stays hidden when this PC previously opted out', async () => {
    const stub = stubAuth({ initial: null, suppressed: true })
    registerAuth(stub.auth)
    renderWizard()
    await flush()
    expect(card()).toBeNull()
  })

  it('never renders in standalone DSH desktop (no host)', async () => {
    const stub = stubAuth({ hostMode: false, initial: null })
    registerAuth(stub.auth)
    renderWizard()
    await flush()
    expect(card()).toBeNull()
  })

  it('routes both login and create-account through the host login dialog', async () => {
    const stub = stubAuth({ initial: null })
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    await act(async () => { button('data-hq-onboarding-login').click() })
    expect(stub.login).toHaveBeenCalledTimes(1)

    await act(async () => { button('data-hq-onboarding-create').click() })
    expect(stub.login).toHaveBeenCalledTimes(2)
  })

  it('treats a dismissed host dialog as a normal outcome', async () => {
    const stub = stubAuth({ initial: null })
    stub.login.mockRejectedValueOnce(new HostLoginDismissedError())
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    await act(async () => { button('data-hq-onboarding-login').click() })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(card()).not.toBeNull()
  })

  it('shows an error when the host dialog cannot be opened', async () => {
    const stub = stubAuth({ initial: null })
    stub.login.mockRejectedValueOnce(new Error('hqEdge.openUrl is unavailable'))
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    await act(async () => { button('data-hq-onboarding-login').click() })
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('dismisses for this launch without writing any storage', async () => {
    const stub = stubAuth({ initial: null })
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    act(() => { button('data-hq-onboarding-skip').click() })
    expect(card()).toBeNull()
    // Skipping without ticking the box is not an opt-out: nothing may be
    // written, in the browser or on the node half.
    expect(stub.suppressOnboarding).not.toHaveBeenCalled()
    expect(Storage.prototype.setItem).not.toHaveBeenCalled()
    expect(Storage.prototype.removeItem).not.toHaveBeenCalled()
  })

  it('re-opens after a mid-session sign-out when the checkbox is unchecked', async () => {
    const stub = stubAuth({ initial: null })
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    act(() => { button('data-hq-onboarding-skip').click() })
    expect(card()).toBeNull()

    stub.emit({ token: 'tok', id: 'u1' })
    expect(card()).toBeNull()
    stub.emit(null)
    expect(card()).not.toBeNull()
  })

  it('ticking the box then signing in also opts out (no resurrection on sign-out)', async () => {
    const stub = stubAuth({ initial: null })
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    act(() => { checkbox().click() })
    await act(async () => { button('data-hq-onboarding-login').click() })
    stub.emit({ token: 'tok', id: 'u1' })
    expect(card()).toBeNull()
    stub.emit(null)
    expect(card()).toBeNull()
    expect(stub.suppressOnboarding).toHaveBeenCalledTimes(1)
  })

  it('the「don\'t show this anymore」choice is persisted for this PC', async () => {
    const stub = stubAuth({ initial: null })
    registerAuth(stub.auth)
    renderWizard()
    await flush()

    act(() => { checkbox().click() })
    expect(checkbox().checked).toBe(true)
    act(() => { button('data-hq-onboarding-skip').click() })
    expect(card()).toBeNull()

    stub.emit({ token: 'tok', id: 'u1' })
    stub.emit(null)
    expect(card()).toBeNull()
    // The opt-out went to the node half (one value per PC), never to browser
    // storage — a new loopback port would have made it unreadable anyway.
    expect(stub.suppressOnboarding).toHaveBeenCalledTimes(1)
    expect(Storage.prototype.setItem).not.toHaveBeenCalled()
  })
})
