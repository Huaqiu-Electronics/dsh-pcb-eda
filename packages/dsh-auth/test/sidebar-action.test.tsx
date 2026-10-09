// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HuaqiuAuthSidebarAction } from '../src/client/ui/sidebar-action.jsx'
import { disposeAuth, getAuthState, registerAuth, registerHqEdgeGetter } from '../src/client/auth-state.js'
import { buildProfileUrl } from '../src/client/lib.js'
import { DARK_ATTRIBUTE, disposeUiEnv, syncUiEnv } from '../src/client/ui-env.js'

// React 19 wants the act environment flag set before any render.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface StubInfo {
  id: string
  token: string
  nickname?: string
  avatar?: string
  phone?: string
}

function stubAuth(initial: StubInfo | null, hostMode = false, profile: { nickname?: string; headimage?: string } | null = null) {
  let current = initial
  const listeners = new Set<(info: StubInfo | null) => void>()
  let profileOverride = profile
  return {
    isAuthenticated: () => current !== null,
    isHostMode: () => hostMode,
    getUserProfile: vi.fn(async () => profileOverride),
    getAccessToken: async () => current?.token ?? null,
    getUserInfo: vi.fn(async () => current),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => {
      current = null
      for (const l of listeners) l(null)
    }),
    onAuthStateChanged: (cb: (info: StubInfo | null) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

function render(wide?: boolean) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<HuaqiuAuthSidebarAction wide={wide} />)
  })
  mounted.push({ root, container })
  return container
}

/** Render and flush the store's initial `getUserInfo()` resolution. */
async function renderSettled(wide?: boolean): Promise<HTMLElement> {
  const container = render(wide)
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

function trigger(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button')
  if (!button) throw new Error('sidebar trigger not rendered')
  return button as HTMLButtonElement
}

function menu(): HTMLElement | null {
  return document.body.querySelector('[role="menu"]')
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find(
    (el) => el.textContent?.trim() === label,
  )
  if (!item) throw new Error(`menu item not found: ${label}`)
  return item as HTMLButtonElement
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Put the host in the requested scheme + language before rendering. */
function setHostEnv(options: { dark?: boolean; lang?: string } = {}): void {
  if (options.dark) document.body.setAttribute(DARK_ATTRIBUTE, '')
  else document.body.removeAttribute(DARK_ATTRIBUTE)
  if (options.lang) document.documentElement.setAttribute('lang', options.lang)
  else document.documentElement.removeAttribute('lang')
  syncUiEnv()
}

beforeEach(() => {
  document.body.innerHTML = ''
  setHostEnv({ dark: false, lang: 'zh-CN' })
})

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.innerHTML = ''
  disposeAuth()
  disposeUiEnv()
  vi.restoreAllMocks()
})

describe('HuaqiuAuthSidebarAction (logged out)', () => {
  beforeEach(() => {
    registerAuth(stubAuth(null) as never)
  })

  it('renders the HQ icon and no context menu', async () => {
    const container = await renderSettled()
    expect(getAuthState().authenticated).toBe(false)
    // HQ_ICON: the 40x40 brand mark (no <img> avatar).
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 40')
    expect(container.querySelector('img')).toBeNull()
    expect(menu()).toBeNull()
  })

  it('opens the login dialog through auth.login on click', async () => {
    const container = await renderSettled()
    const auth = (await import('../src/client/auth-state.js')).getAuth() as unknown as {
      login: ReturnType<typeof vi.fn>
    }
    click(trigger(container))
    // Transparency and click-outside-close are unconditional (the dialog owns
    // the DOM and closes on backdrop click, Escape, the × button, and the
    // embed's `close_dialog` postMessage). The host language and color
    // scheme ride along so the card matches the shell.
    expect(auth.login).toHaveBeenCalledWith({ lang: 'zh', theme: 'light' })
    // Logged out: clicking must NOT open the account menu.
    expect(menu()).toBeNull()
  })

  it('passes the dark scheme and English locale through to the embed', async () => {
    setHostEnv({ dark: true, lang: 'en' })
    const container = await renderSettled()
    const auth = (await import('../src/client/auth-state.js')).getAuth() as unknown as {
      login: ReturnType<typeof vi.fn>
    }
    click(trigger(container))
    expect(auth.login).toHaveBeenCalledWith({ lang: 'en', theme: 'dark' })
  })

  it('localizes the trigger label (zh / en)', async () => {
    const zh = await renderSettled()
    expect(trigger(zh).textContent).toContain('华秋EDA AI登录')
    expect(trigger(zh).getAttribute('title')).toBe('登录华秋 EDA AI（eda.cn）账号')

    act(() => {
      setHostEnv({ dark: false, lang: 'en' })
    })
    const en = await renderSettled()
    expect(trigger(en).textContent).toContain('Huaqiu EDA AI login')
    expect(trigger(en).getAttribute('title')).toBe('Sign in to your Huaqiu EDA AI (eda.cn) account')
    // The store is live: the trigger mounted BEFORE the switch re-rendered too.
    expect(trigger(zh).textContent).toContain('Huaqiu EDA AI login')
  })
})

describe('HuaqiuAuthSidebarAction (logged in)', () => {
  beforeEach(() => {
    registerAuth(
      stubAuth({
        id: 'u1',
        token: 'tok',
        nickname: '老铁',
        avatar: 'https://cdn.eda.cn/a.png',
        phone: '13800000000',
      }) as never,
    )
  })

  it('shows the user avatar instead of the HQ icon', async () => {
    const container = await renderSettled()
    expect(getAuthState().authenticated).toBe(true)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.eda.cn/a.png')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('opens a context menu with the profile and logout entries (localized)', async () => {
    const container = await renderSettled()
    click(trigger(container))
    expect(menu()).not.toBeNull()
    expect(menuItem('个人中心')).toBeTruthy()
    expect(menuItem('退出登录')).toBeTruthy()
    expect(menu()?.textContent).toContain('老铁')
  })

  it('renders the English menu labels when the host is in English', async () => {
    setHostEnv({ lang: 'en' })
    const container = await renderSettled()
    click(trigger(container))
    expect(menuItem('Go to profile')).toBeTruthy()
    expect(menuItem('Log out')).toBeTruthy()
  })

  it('themes the menu for the dark palette', async () => {
    setHostEnv({ dark: true })
    const container = await renderSettled()
    click(trigger(container))
    const style = menu()?.style
    // DSH token first, explicit dark fallback second — both must be dark-aware.
    // The fallback surface follows the redesigned prototype (#1e1b24).
    expect(style?.background).toBe('var(--dsw-alias-bg-overlay, #1e1b24)')
    expect(style?.boxShadow).toContain('rgba(0, 0, 0')

    // And light again.
    act(() => {
      setHostEnv({ dark: false })
    })
    expect(menu()?.style.background).toBe('var(--dsw-alias-bg-overlay, #ffffff)')
  })

  it('「Go to profile」opens the tokenized eda.cn profile page in a new tab and closes the menu', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const container = await renderSettled()
    click(trigger(container))
    await act(async () => {
      click(menuItem('个人中心'))
      await Promise.resolve()
    })
    expect(open).toHaveBeenCalledWith(
      buildProfileUrl({ token: 'tok', phone: '13800000000' }),
      '_blank',
      'noopener,noreferrer',
    )
    // The token is on the URL by design: eda.cn consumes and hides it.
    expect(open.mock.calls[0]?.[0]).toContain('token=tok')
    expect(open.mock.calls[0]?.[0]).toContain('phone=13800000000')
    expect(menu()).toBeNull()
  })

  it('「Go to profile」URL-encodes a token with reserved query characters', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(buildProfileUrl({ token: 'a+b/c=', phone: '138' })).toBe(
      'https://www.eda.cn/account/profile?token=a%2Bb%2Fc%3D&phone=138',
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('「Go to profile」omits an unknown phone but always sends the token', () => {
    expect(buildProfileUrl({ token: 'tok' })).toBe(
      'https://www.eda.cn/account/profile?token=tok&phone=',
    )
  })

  it('「Log out」logs out and closes the menu', async () => {
    const container = await renderSettled()
    click(trigger(container))
    click(menuItem('退出登录'))
    expect(getAuthState().authenticated).toBe(false)
    expect(menu()).toBeNull()
  })

  it('closes on an outside click and on Escape', async () => {
    const container = await renderSettled()

    click(trigger(container))
    expect(menu()).not.toBeNull()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menu()).toBeNull()

    click(trigger(container))
    expect(menu()).not.toBeNull()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(menu()).toBeNull()
  })

  it('closes when the user logs out from elsewhere (state flips to signed out)', async () => {
    const container = await renderSettled()
    click(trigger(container))
    expect(menu()).not.toBeNull()
    const auth = (await import('../src/client/auth-state.js')).getAuth() as unknown as {
      logout: () => Promise<void>
    }
    await act(async () => {
      await auth.logout()
    })
    expect(menu()).toBeNull()
  })
})

describe('HuaqiuAuthSidebarAction (snapshot without a token)', () => {
  /**
   * The store snapshot is derived from `getUserInfo()`, so a payload that lost
   * its token leaves `authenticated: true` with no token on the snapshot. The
   * menu must still open the profile with the token read from the client.
   */
  it('falls back to reading the token from the auth client', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const base = stubAuth(null)
    let calls = 0
    registerAuth({
      ...base,
      getUserInfo: vi.fn(async () => {
        calls += 1
        // First call = the boot snapshot (no token); later calls = the fallback.
        return calls === 1
          ? { id: 'u1', nickname: '老铁' }
          : { id: 'u1', token: 'tok-from-client', nickname: '老铁', phone: '139' }
      }),
    } as never)

    const container = await renderSettled()
    expect(getAuthState().authenticated).toBe(true)
    click(trigger(container))
    await act(async () => {
      click(menuItem('个人中心'))
      await Promise.resolve()
    })
    expect(open).toHaveBeenCalledWith(
      'https://www.eda.cn/account/profile?token=tok-from-client&phone=139',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('does not open anything when no token can be resolved', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const base = stubAuth(null)
    registerAuth({
      ...base,
      getUserInfo: vi.fn(async () => ({ id: 'u1', nickname: '老铁' })),
    } as never)

    const container = await renderSettled()
    click(trigger(container))
    await act(async () => {
      click(menuItem('个人中心'))
      await Promise.resolve()
    })
    expect(open).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })
})

describe('HuaqiuAuthSidebarAction (host mode visibility)', () => {
  beforeEach(() => {
    registerAuth(stubAuth(null, true) as never)
  })

  it('hides the trigger under an hq-eda host (native login surface exists)', async () => {
    registerHqEdgeGetter(() => ({ context: { getTargetHost: () => 'hq-eda' } }))
    const container = await renderSettled()
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps the trigger under a kicad host (no login entrypoint of its own)', async () => {
    registerHqEdgeGetter(() => ({ context: { getTargetHost: () => 'kicad' } }))
    const container = await renderSettled()
    expect(trigger(container)).toBeTruthy()
  })

  it('keeps the trigger when the host identity is still generic/unknown', async () => {
    registerHqEdgeGetter(() => ({ context: { getTargetHost: () => 'generic' } }))
    const container = await renderSettled()
    expect(trigger(container)).toBeTruthy()
  })

  it('keeps the trigger when no hqEdge service is resolvable', async () => {
    registerHqEdgeGetter(() => undefined)
    const container = await renderSettled()
    expect(trigger(container)).toBeTruthy()
  })

  it('fetches and renders the rich profile (name + photo) under a kicad host', async () => {
    registerHqEdgeGetter(() => ({ context: { getTargetHost: () => 'kicad' } }))
    // Host session: token only. Profile comes from eda.cn via getUserProfile.
    registerAuth(stubAuth({ id: 'u1', token: 'tok' }, true, { nickname: '老铁', headimage: 'https://file.eda.cn/avatar.png' }) as never)
    const container = await renderSettled()
    const img = container.querySelector('img') as HTMLImageElement | null
    expect(img?.getAttribute('src')).toBe('https://file.eda.cn/avatar.png')
    expect(container.textContent).toContain('老铁')
  })

  it('falls back to the HQ icon + generic label when the profile fetch fails', async () => {
    registerHqEdgeGetter(() => ({ context: { getTargetHost: () => 'kicad' } }))
    registerAuth(stubAuth({ id: 'u1', token: 'tok' }, true, null) as never)
    const container = await renderSettled()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 40')
  })
})

describe('HuaqiuAuthSidebarAction (logged in, no avatar)', () => {
  it('falls back to the HQ icon when the payload carries no avatar', async () => {
    registerAuth(stubAuth({ id: 'u1', token: 'tok', nickname: '老铁' }) as never)
    const container = await renderSettled()
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 40')
    expect(container.querySelector('img')).toBeNull()
    // The account menu still works without an avatar.
    click(trigger(container))
    expect(menuItem('个人中心')).toBeTruthy()
  })
})
