// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  HuaqiuTurnErrorSubscribeAction,
  isHuaqiuQuotaFailure,
  type TurnErrorCtaNode,
} from '../src/client/ui/turn-error-cta.jsx'
import { disposeAuth, registerAuth } from '../src/client/auth-state.js'
import type { SubscriptionDialogOutcome } from '../src/client/client.js'
import { DARK_ATTRIBUTE, disposeUiEnv, syncUiEnv } from '../src/client/ui-env.js'

// React 19 wants the act environment flag set before any render.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface StubOptions {
  authenticated?: boolean
  open?: () => Promise<SubscriptionDialogOutcome>
  login?: () => Promise<void>
}

function stubAuth({ authenticated = true, open, login }: StubOptions = {}) {
  let current: { token: string } | null = authenticated ? { token: 'tok-1' } : null
  const listeners = new Set<(info: { token: string } | null) => void>()
  return {
    isAuthenticated: () => current !== null,
    isHostMode: () => false,
    getAccessToken: async () => current?.token ?? null,
    getUserInfo: async () => current,
    getUserProfile: async () => null,
    login: vi.fn(login ?? (async () => undefined)),
    logout: vi.fn(async () => {
      current = null
      for (const listener of listeners) listener(null)
    }),
    getSubscriptionQuota: async () => null,
    getAiTokenUsage: async () => null,
    openSubscriptionDialog: vi.fn(open ?? (async (): Promise<SubscriptionDialogOutcome> => ({ status: 'opened' }))),
    onAuthStateChanged: (listener: (info: { token: string } | null) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

async function render(node: TurnErrorCtaNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<HuaqiuTurnErrorSubscribeAction node={node} />)
  })
  mounted.push({ root, container })
  return container
}

function button(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('button')
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Flush one microtask turn so the clicked handler's promise chain settles. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

const quotaNode: TurnErrorCtaNode = {
  code: 'PI_AI_ERROR',
  message: '402: {"message":"用户额度不足","code":"insufficient_user_quota"}',
  provider: 'huaqiu',
  providerErrorCode: 'insufficient_user_quota',
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.documentElement.setAttribute('lang', 'zh-CN')
  syncUiEnv()
})

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.innerHTML = ''
  disposeAuth()
  disposeUiEnv()
})

describe('isHuaqiuQuotaFailure', () => {
  it('accepts the gateway signature on the provider-neutral quota codes', () => {
    expect(isHuaqiuQuotaFailure(quotaNode)).toBe(true)
    // Provider attribution may be absent on older harness versions; the
    // extracted signature still identifies the failure.
    expect(isHuaqiuQuotaFailure({ ...quotaNode, provider: undefined })).toBe(true)
    expect(isHuaqiuQuotaFailure({ code: 'QUOTA', message: '', providerErrorCode: 'insufficient_user_quota' })).toBe(true)
  })

  it('accepts a routed huaqiu QUOTA classification without the payload code', () => {
    expect(isHuaqiuQuotaFailure({ code: 'QUOTA', message: '', provider: 'huaqiu' })).toBe(true)
  })

  it('rejects unrelated codes, providers, and quota signatures', () => {
    expect(isHuaqiuQuotaFailure(null)).toBe(false)
    expect(isHuaqiuQuotaFailure(undefined)).toBe(false)
    expect(isHuaqiuQuotaFailure({ code: 'AUTH', message: '', provider: 'huaqiu' })).toBe(false)
    expect(isHuaqiuQuotaFailure({ code: 'RATE_LIMIT', message: '', provider: 'huaqiu', providerErrorCode: 'insufficient_user_quota' })).toBe(false)
    expect(isHuaqiuQuotaFailure({ code: 'QUOTA', message: '', provider: 'openai' })).toBe(false)
    expect(isHuaqiuQuotaFailure({ code: 'PI_AI_ERROR', message: '', providerErrorCode: 'insufficient_quota' })).toBe(false)
    // Provider attribution alone is never enough for a generic terminal error.
    expect(isHuaqiuQuotaFailure({ code: 'PI_AI_ERROR', message: '', provider: 'huaqiu' })).toBe(false)
  })

  it('never infers the signature from message text', () => {
    expect(isHuaqiuQuotaFailure({
      code: 'PI_AI_ERROR',
      message: 'quota exhausted: {"code":"insufficient_user_quota"}',
      provider: 'huaqiu',
    })).toBe(false)
  })
})

describe('HuaqiuTurnErrorSubscribeAction', () => {
  it('renders nothing for a non-matching failure', async () => {
    registerAuth(stubAuth() as never)
    const container = await render({ code: 'PI_AI_ERROR', message: 'boom' })
    expect(button(container)).toBeNull()
  })

  it('renders English copy and follows a host locale switch', async () => {
    registerAuth(stubAuth() as never)
    const container = await render(quotaNode)
    expect(button(container)?.textContent).toBe('升级获取更多 AI 额度')
    document.documentElement.setAttribute('lang', 'en')
    await act(async () => {
      syncUiEnv()
    })
    expect(button(container)?.textContent).toBe('Upgrade for more AI tokens')
  })

  it('opens the subscription dialog for an authenticated user', async () => {
    const auth = stubAuth()
    registerAuth(auth as never)
    const container = await render(quotaNode)
    const cta = button(container)
    expect(cta?.textContent).toBe('升级获取更多 AI 额度')
    click(cta!)
    await flush()
    expect(auth.openSubscriptionDialog).toHaveBeenCalledTimes(1)
    expect(auth.login).not.toHaveBeenCalled()
    // Opened successfully → no fallback copy.
    expect(container.textContent).not.toContain('无法打开订阅页面')
  })

  it('offers login instead of the dialog when signed out', async () => {
    const auth = stubAuth({ authenticated: false })
    registerAuth(auth as never)
    const container = await render(quotaNode)
    const cta = button(container)
    expect(cta?.textContent).toBe('登录后升级')
    click(cta!)
    await flush()
    expect(auth.login).toHaveBeenCalledWith({ lang: 'zh', theme: 'light' })
    expect(auth.openSubscriptionDialog).not.toHaveBeenCalled()
  })

  it('shows the host-dialog fallback copy when the host has no dialog service', async () => {
    const auth = stubAuth({ open: async () => ({ status: 'host-unavailable' }) })
    registerAuth(auth as never)
    const container = await render(quotaNode)
    click(button(container)!)
    await flush()
    expect(container.textContent).toContain('宿主未提供对话框服务')
  })

  it('shows retry copy when the dialog call rejects', async () => {
    const auth = stubAuth({ open: async () => { throw new Error('transport down') } })
    registerAuth(auth as never)
    const container = await render(quotaNode)
    click(button(container)!)
    await flush()
    expect(container.textContent).toContain('无法打开订阅页面')
  })

  it('leaves an already-open dialog alone', async () => {
    const auth = stubAuth({ open: async () => ({ status: 'already-open' }) })
    registerAuth(auth as never)
    const container = await render(quotaNode)
    click(button(container)!)
    await flush()
    expect(container.textContent).not.toContain('无法打开订阅页面')
    expect(container.textContent).not.toContain('宿主未提供对话框服务')
  })
})
