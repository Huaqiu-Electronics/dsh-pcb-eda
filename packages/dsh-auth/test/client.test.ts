// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { AUTH_ORIGIN, buildLoginUrl, parseAuthMessage, handleAuthMessage, type AuthTokenPayload } from '../src/client/lib.js'
import { createAuthStorage } from '../src/client/storage.js'
import { createAuthClient } from '../src/client/client.js'
import type { HostSessionUser } from '../src/client/transport.js'
import {
  DIALOG_CARD_ATTR,
  DIALOG_CLOSE_ATTR,
  DIALOG_IFRAME_ATTR,
  DIALOG_OVERLAY_ATTR,
  closeLoginDialog,
  isLoginDialogOpen,
} from '../src/client/ui/login-dialog.js'

const validEnvelope = {
  category: 1,
  data: {
    type: 'update_access_token',
    data: { userId: 'u1', token: 'tok-1', nickname: 'Alice', expires_at: 9999999999 },
  },
}

// Exact payload shape auth.eda.cn actually posts: userId/id are NUMBERS.
// Regression for the login that was rejected with `update_access_token-missing-id`.
const realAuthEdaCnEnvelope = {
  category: 1,
  data: {
    type: 'update_access_token',
    data: {
      userId: 6215935,
      expires_at: 9999999999,
      agreeCollectIP: false,
      token: '0494009e-edbc-5f52-99e3-ae4ef00f051e-6a919aad',
      id: 6215935,
      username: 'jf_66463080',
      nickname: '老铁',
    },
  },
}

function makeClient() {
  const pushes: unknown[] = []
  const transport = {
    pushSession: vi.fn(async (info: AuthTokenPayload) => { pushes.push(['session', info]) }),
    pushLogout: vi.fn(async () => { pushes.push(['logout']) }),
    fetchHostMode: vi.fn(async () => false),
    fetchSession: vi.fn(async (): Promise<{ authenticated: boolean; user: HostSessionUser | null }> =>
      ({ authenticated: false, user: null })),
    triggerLogin: vi.fn(async () => { pushes.push(['login']) }),
    fetchUserInfo: vi.fn(async () => null),
  }
  const storage = createAuthStorage(localStorage)
  const listeners: Array<(e: MessageEvent) => void> = []
  const windowLike = {
    addEventListener: vi.fn((_t: string, fn: (e: MessageEvent) => void) => listeners.push(fn)),
    removeEventListener: vi.fn(() => undefined),
  }
  // The dialog module builds its DOM with the REAL document. We don't mock
  // documentLike — the auth client passes the real one through.
  const client = createAuthClient({
    storage,
    transport,
    windowLike: windowLike as never,
    documentLike: document,
  })
  return { client, transport, storage, windowLike, listeners }
}

function eventLike(origin: string, data: unknown): MessageEvent {
  return { origin, data } as MessageEvent
}

function findOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${DIALOG_OVERLAY_ATTR}]`)
}
function findCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${DIALOG_CARD_ATTR}]`)
}
function findIframe(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>(`[${DIALOG_IFRAME_ATTR}]`)
}
function findCloseButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[${DIALOG_CLOSE_ATTR}]`)
}

describe('parseAuthMessage / handleAuthMessage', () => {
  it('carries the avatar (headimage) through to the credential payload', () => {
    const msg = parseAuthMessage({
      category: 1,
      data: { type: 'update_access_token', data: { userId: 6215935, token: 't', headimage: 'https://cdn.eda.cn/a.png' } },
    })
    expect(msg).toEqual({ kind: 'token', info: { id: '6215935', token: 't', avatar: 'https://cdn.eda.cn/a.png' } })
  })

  it('carries the phone (string or number) through to the credential payload', () => {
    const asString = parseAuthMessage({
      category: 1,
      data: { type: 'update_access_token', data: { userId: 6215935, token: 't', phone: '13800000000' } },
    })
    expect(asString).toEqual({ kind: 'token', info: { id: '6215935', token: 't', phone: '13800000000' } })

    const asNumber = parseAuthMessage({
      category: 1,
      data: { type: 'update_access_token', data: { userId: 6215935, token: 't', phone: 13800000000 } },
    })
    expect(asNumber).toEqual({ kind: 'token', info: { id: '6215935', token: 't', phone: '13800000000' } })
  })

  it('parses a valid token envelope from a JSON string (auth.eda.cn form)', () => {
    const msg = parseAuthMessage(JSON.stringify(validEnvelope))
    expect(msg).toEqual({
      kind: 'token',
      info: { id: 'u1', token: 'tok-1', nickname: 'Alice', expiresAt: 9999999999 },
    })
  })

  it('parses an object envelope with id instead of userId', () => {
    const msg = parseAuthMessage({ category: 1, data: { type: 'update_access_token', data: { id: 'x', token: 't' } } })
    expect(msg).toEqual({ kind: 'token', info: { id: 'x', token: 't' } })
  })

  it('recognizes logout and close_dialog', () => {
    expect(parseAuthMessage({ category: 1, data: { type: 'logout', data: null } })).toEqual({ kind: 'logout' })
    expect(parseAuthMessage({ category: 1, data: { type: 'close_dialog', data: null } })).toEqual({ kind: 'close' })
  })

  it('buildLoginUrl switches between transparent-card and fill modes', () => {
    const transparent = new URL(buildLoginUrl({ lang: 'zh', theme: 'dark' }))
    // Default: no `fill` — the embed stays in transparent card mode and the
    // host must paint a card around the iframe (the sidebar dialog does).
    expect(transparent.searchParams.get('fill')).toBeNull()
    expect(transparent.searchParams.get('locale')).toBe('cn')
    expect(transparent.searchParams.get('lang')).toBe('zh')
    expect(transparent.searchParams.get('theme')).toBe('dark')

    const full = new URL(buildLoginUrl({ fill: 'full', lang: 'en', theme: 'light' }))
    expect(full.searchParams.get('fill')).toBe('full')
    expect(full.searchParams.get('locale')).toBe('en')
    expect(full.searchParams.get('lang')).toBe('en')
    expect(full.searchParams.get('theme')).toBe('light')

    // `true` is accepted as a shorthand for `'full'`.
    const fullShort = new URL(buildLoginUrl({ fill: true }))
    expect(fullShort.searchParams.get('fill')).toBe('full')
  })

  it('rejects malformed / unknown envelopes', () => {
    expect(parseAuthMessage('not json')).toBeNull()
    expect(parseAuthMessage(null)).toBeNull()
    expect(parseAuthMessage({ category: 2, data: { type: 'logout' } })).toBeNull()
    expect(parseAuthMessage({ category: 1, data: { type: 'unknown' } })).toBeNull()
    expect(parseAuthMessage({ category: 1, data: { type: 'update_access_token', data: { token: '' } } })).toBeNull()
  })

  it('accepts a valid envelope regardless of origin (offline deployment — no origin gate)', () => {
    // Offline DSH deployment: the origin is intentionally not gated (webviews
    // may report an opaque origin for the embedded auth.eda.cn iframe). A
    // well-formed envelope is accepted from any origin; garbage is still
    // rejected by envelope validation.
    expect(handleAuthMessage(eventLike('https://evil.example', validEnvelope))).toEqual({ kind: 'token', info: expect.any(Object) })
    expect(handleAuthMessage(eventLike('null', validEnvelope))).toEqual({ kind: 'token', info: expect.any(Object) })
    expect(handleAuthMessage(eventLike(AUTH_ORIGIN, validEnvelope))).toEqual({ kind: 'token', info: expect.any(Object) })
    // Malformed envelopes are still rejected regardless of origin.
    expect(handleAuthMessage(eventLike('https://evil.example', 'not json'))).toBeNull()
    expect(handleAuthMessage(eventLike(AUTH_ORIGIN, { category: 2, data: { type: 'logout' } }))).toBeNull()
  })
})

describe('createAuthStorage', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('round-trips and expires', () => {
    const storage = createAuthStorage(localStorage)
    expect(storage.get()).toBeNull()
    storage.set({ id: 'u', token: 't' })
    expect(storage.get()).toEqual({ id: 'u', token: 't' })
    storage.clear()
    expect(storage.get()).toBeNull()
  })

  it('drops expired tokens (5-day parity)', () => {
    const storage = createAuthStorage(localStorage)
    storage.set({ id: 'u', token: 't', expiresAt: Math.floor(Date.now() / 1000) - 10 })
    expect(storage.get()).toBeNull()
  })
})

describe('login dialog DOM (auth client surface)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.removeAttribute('lang')
    localStorage.clear()
  })
  afterEach(() => {
    closeLoginDialog()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.removeAttribute('lang')
  })

  it('login() mounts a backdrop + card + iframe (NOT a full-viewport iframe)', () => {
    const { client } = makeClient()
    client.auth.login()
    const overlay = findOverlay()
    const card = findCard()
    const iframe = findIframe()
    expect(overlay).not.toBeNull()
    expect(card).not.toBeNull()
    expect(iframe).not.toBeNull()
    // The iframe is INSIDE the card (so the card surface masks Blink's
    // white base canvas behind the embedded doc's transparent grid rows).
    expect(card!.contains(iframe)).toBe(true)
    // The overlay is the full viewport, but the iframe is NOT — it has a
    // defined max-width / height and lives inside the card.
    expect(overlay!.style.position).toBe('fixed')
    expect(iframe!.style.position).not.toBe('fixed')
    expect(iframe!.style.width).not.toBe('100vw')
    // The dialog MUST be at least 768px wide so the auth.eda.cn embed's
    // `md:grid-cols-[2fr_3fr]` 2-column layout (Tailwind `md` = 768px,
    // measured against the iframe viewport) renders the WeChat QR panel
    // next to the phone form. Smaller widths silently fall back to a single
    // column. We cap at 768px (the embed's own `max-w-3xl`) and let the
    // card fill 100vw on viewports smaller than that.
    expect(card!.style.cssText).toContain('width: min(100vw, 768px)')
    expect(iframe!.style.height).toBe('440px')
    expect(isLoginDialogOpen()).toBe(true)
  })

  it('iframe element background matches the host card surface (no white canvas in dark mode)', () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    const { client } = makeClient()
    client.auth.login()
    const card = findCard()!
    const iframe = findIframe()!
    // The card and the iframe element share the same surface color — that
    // is what hides Blink's white default canvas behind the embedded doc's
    // transparent 20px grid strips.
    const darkSurface = 'var(--dsw-alias-bg-layer-1, #20242c)'
    expect(card.style.background).toBe(darkSurface)
    expect(iframe.style.background).toBe(darkSurface)
  })

  it('light theme uses a light surface', () => {
    const { client } = makeClient()
    client.auth.login()
    const card = findCard()!
    const iframe = findIframe()!
    const lightSurface = 'var(--dsw-alias-bg-layer-1, #ffffff)'
    expect(card.style.background).toBe(lightSurface)
    expect(iframe.style.background).toBe(lightSurface)
    // The card has NO border: a 1px border would shrink the iframe to 766px
    // on a 768px card, missing the embed's `md:grid-cols` (Tailwind `md`)
    // threshold by 2px. The card's box-shadow is the only edge.
    expect(card.style.border).toBe('')
  })

  it('flipping the host theme updates the card + iframe colors live (mid-session)', async () => {
    const { client } = makeClient()
    client.auth.login()
    expect(findCard()!.style.background).toContain('#ffffff')
    document.body.setAttribute('data-ds-dark-theme', '')
    // Give the MutationObserver one tick to fire.
    await new Promise((r) => setTimeout(r, 0))
    const card = findCard()!
    const iframe = findIframe()!
    expect(card.style.background).toContain('#20242c')
    expect(iframe.style.background).toContain('#20242c')
    // Border stays empty after a theme flip (see the previous test).
    expect(card.style.border).toBe('')
  })

  it('sidebar dialog embeds the auth card in TRANSPARENT mode (no fill=full)', () => {
    const { client } = makeClient()
    client.auth.login()
    const iframe = findIframe()!
    const src = new URL(iframe.src)
    // The dialog sits inside a host-painted card with its own edge, so it
    // stays in the embed's transparent card mode. Sending `fill=full` here
    // would tell the embed to paint its own background edge-to-edge AND
    // drop the rounded corners — both wrong for the dialog.
    expect(src.searchParams.get('fill')).toBeNull()
    // The 440px iframe height is the "previous" value that shows the
    // agreement checkbox perfectly (see LOGIN_IFRAME_HEIGHT in common.tsx).
    expect(iframe.style.height).toBe('440px')
  })

  it('clicking the backdrop closes the dialog; clicking the card does NOT', () => {
    const { client } = makeClient()
    client.auth.login()
    const overlay = findOverlay()!
    const card = findCard()!
    // mousedown on the card — should not close.
    card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(isLoginDialogOpen()).toBe(true)
    // mousedown on the overlay directly — should close.
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(isLoginDialogOpen()).toBe(false)
  })

  it('Escape closes the dialog', () => {
    const { client } = makeClient()
    client.auth.login()
    expect(isLoginDialogOpen()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(isLoginDialogOpen()).toBe(false)
  })

  it('the × button closes the dialog', () => {
    const { client } = makeClient()
    client.auth.login()
    const close = findCloseButton()!
    close.click()
    expect(isLoginDialogOpen()).toBe(false)
  })

  it('a second login() while open is a no-op (idempotent)', () => {
    const { client } = makeClient()
    client.auth.login()
    client.auth.login()
    expect(document.querySelectorAll(`[${DIALOG_OVERLAY_ATTR}]`)).toHaveLength(1)
  })

  it('login() forwards lang (both `lang` and `locale`) and theme to the embed', () => {
    const { client } = makeClient()
    client.auth.login({ lang: 'en', theme: 'dark' })
    const src = new URL(findIframe()!.src)
    expect(src.searchParams.get('lang')).toBe('en')
    // auth.eda.cn reads `locale`, and its ids are `cn` / `en`
    // (eda-cn-login LanguageContext#getLangFromUrl) — hq-eda-ai sends only
    // `lang=zh`, which the embed ignores.
    expect(src.searchParams.get('locale')).toBe('en')
    expect(src.searchParams.get('theme')).toBe('dark')
  })

  it('login() maps zh to the embed locale id `cn`', () => {
    const { client } = makeClient()
    client.auth.login({ lang: 'zh' })
    const src = new URL(findIframe()!.src)
    expect(src.searchParams.get('lang')).toBe('zh')
    expect(src.searchParams.get('locale')).toBe('cn')
  })

  it('the embed URL never sends `fill=full` (that is what keeps the page transparent)', () => {
    const { client } = makeClient()
    client.auth.login()
    const src = new URL(findIframe()!.src)
    expect(`${src.origin}${src.pathname}`).toBe('https://auth.eda.cn/')
    expect(src.searchParams.get('fill')).toBeNull()
    // `clickOutsideToClose` is the other thing auth.eda.cn actually reads.
    expect(src.searchParams.get('clickOutsideToClose')).toBe('true')
  })

  it('the embed is transparent unconditionally — no option can make it opaque', () => {
    const { client } = makeClient()
    // @ts-expect-error `transparent` is gone: transparency is not optional.
    client.auth.login({ transparent: false })
    const src = new URL(findIframe()!.src)
    expect(src.searchParams.get('transparent')).toBe('true')
    expect(src.searchParams.get('fill')).toBeNull()
    // And the iframe element background is the card surface, never #fff.
    expect(findIframe()!.style.background).not.toBe('#fff')
  })
})

describe('auth client behaviors (acceptance groups A–D)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    closeLoginDialog()
    localStorage.clear()
  })
  afterEach(() => {
    closeLoginDialog()
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('group A: token message → stored + pushed to node + dialog closed', () => {
    const { client, transport, storage } = makeClient()
    client.auth.login()
    expect(isLoginDialogOpen()).toBe(true)

    client.handleMessageEvent(eventLike(AUTH_ORIGIN, JSON.stringify(validEnvelope)))
    expect(storage.get()).toEqual({ id: 'u1', token: 'tok-1', nickname: 'Alice', expiresAt: 9999999999 })
    expect(transport.pushSession).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-1', id: 'u1' }))
    expect(isLoginDialogOpen()).toBe(false) // closed after success
  })

  it('accepts a valid envelope from any origin and closes the dialog (offline deployment)', () => {
    const { client, transport, storage } = makeClient()
    client.auth.login()
    client.handleMessageEvent(eventLike('null', validEnvelope)) // opaque webview origin
    expect(storage.get()).toEqual({ id: 'u1', token: 'tok-1', nickname: 'Alice', expiresAt: 9999999999 })
    expect(transport.pushSession).toHaveBeenCalled()
    expect(isLoginDialogOpen()).toBe(false)
  })

  it('accepts the REAL auth.eda.cn payload where userId/id are numbers (regression)', () => {
    const { client, transport, storage } = makeClient()
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, JSON.stringify(realAuthEdaCnEnvelope)))
    expect(storage.get()).toEqual({
      id: '6215935',
      token: '0494009e-edbc-5f52-99e3-ae4ef00f051e-6a919aad',
      nickname: '老铁',
      expiresAt: 9999999999,
    })
    expect(transport.pushSession).toHaveBeenCalledWith(expect.objectContaining({ id: '6215935' }))
  })

  it('still ignores malformed envelopes (no store, no push, dialog stays)', () => {
    const { client, transport, storage } = makeClient()
    client.auth.login()
    client.handleMessageEvent(eventLike('https://evil.example', 'not an envelope'))
    expect(storage.get()).toBeNull()
    expect(transport.pushSession).not.toHaveBeenCalled()
    expect(isLoginDialogOpen()).toBe(true)
  })

  it('close_dialog postMessage closes the dialog', () => {
    const { client } = makeClient()
    client.auth.login()
    expect(isLoginDialogOpen()).toBe(true)
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, JSON.stringify({ category: 1, data: { type: 'close_dialog', data: null } })))
    expect(isLoginDialogOpen()).toBe(false)
  })

  it('group B: a new login overwrites the previous credentials', () => {
    const { client, storage } = makeClient()
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, validEnvelope))
    const second = { category: 1, data: { type: 'update_access_token', data: { userId: 'u2', token: 'tok-2' } } }
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, second))
    expect(storage.get()).toEqual({ id: 'u2', token: 'tok-2' })
  })

  it('group C: logout clears local state, pushes logout to node, and closes an open dialog', async () => {
    const { client, transport, storage } = makeClient()
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, validEnvelope))
    client.auth.login()
    expect(isLoginDialogOpen()).toBe(true)
    await client.auth.logout()
    expect(storage.get()).toBeNull()
    expect(transport.pushLogout).toHaveBeenCalled()
    expect(await client.auth.getAccessToken()).toBeNull()
    expect(isLoginDialogOpen()).toBe(false)
  })

  it('group D: restore() re-pushes persisted credentials on boot (reload restore)', async () => {
    const { client, transport } = makeClient()
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, validEnvelope)) // persists to localStorage
    client.dispose()

    const { client: client2, transport: transport2 } = makeClient()
    await client2.restore()
    expect(transport2.pushSession).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-1' }))
    expect(await client2.auth.getAccessToken()).toBe('tok-1')
  })

  it('syncNow() re-pushes persisted credentials when the node half was reset', async () => {
    const { client, transport } = makeClient()
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, validEnvelope)) // persists to localStorage (+1 push)
    await client.syncNow() // healing re-push (+1)
    expect(transport.pushSession).toHaveBeenCalledTimes(2)
    expect(transport.pushSession).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'tok-1', id: 'u1' }))
    // A further sync pushes again (idempotent re-push for healing).
    await client.syncNow()
    expect(transport.pushSession).toHaveBeenCalledTimes(3)
  })

  it('syncNow() is a no-op when nothing is stored', async () => {
    const { client, transport } = makeClient()
    await client.syncNow()
    expect(transport.pushSession).not.toHaveBeenCalled()
  })

  it('registering the window message listener wires live events', () => {
    const { client, listeners } = makeClient()
    expect(listeners).toHaveLength(1)
    client.dispose()
  })

  it('onAuthStateChanged fires on login/logout', async () => {
    const { client } = makeClient()
    const seen: unknown[] = []
    client.auth.onAuthStateChanged((info) => seen.push(info))
    client.handleMessageEvent(eventLike(AUTH_ORIGIN, validEnvelope))
    await client.auth.logout()
    expect(seen).toEqual([
      expect.objectContaining({ token: 'tok-1' }),
      null,
    ])
  })
})

describe('host mode (hq-edge integration)', () => {
  it('adopts the host-owned session so the auth gate reads authenticated', async () => {
    const { client, transport } = makeClient()
    transport.fetchHostMode.mockResolvedValue(true)
    transport.fetchSession.mockResolvedValue({
      authenticated: true,
      user: { id: 6215935, token: 'host-tok-1', nickname: '老铁' },
    })
    const seen: unknown[] = []
    client.auth.onAuthStateChanged((info) => seen.push(info))

    expect(await client.refreshHost()).toBe(true)
    expect(client.auth.isAuthenticated()).toBe(true)
    await expect(client.auth.getUserInfo()).resolves.toEqual(
      expect.objectContaining({ id: '6215935', token: 'host-tok-1', nickname: '老铁' }),
    )
    await expect(client.auth.getAccessToken()).resolves.toBe('host-tok-1')
    // Host mode: login never opens the auth.eda.cn iframe.
    await client.auth.login()
    expect(isLoginDialogOpen()).toBe(false)
    expect(seen).toEqual([expect.objectContaining({ token: 'host-tok-1' })])
  })

  it('standalone refreshHost keeps the login entrypoint and storage gate', async () => {
    const { client, transport, storage } = makeClient()
    transport.fetchHostMode.mockResolvedValue(false)
    expect(await client.refreshHost()).toBe(false)
    expect(client.auth.isAuthenticated()).toBe(false)
    // Standalone login still opens the iframe.
    await client.auth.login()
    expect(isLoginDialogOpen()).toBe(true)
    closeLoginDialog()
    // Storage stays authoritative after host resolution in standalone.
    storage.set({ id: 'u1', token: 'tok-1' })
    expect(client.auth.isAuthenticated()).toBe(true)
  })

  it('logout in host mode REQUESTS host logout and adopts the host verdict', async () => {
    const { client, transport } = makeClient()
    transport.fetchHostMode.mockResolvedValue(true)
    transport.fetchSession.mockResolvedValue({ authenticated: true, user: { id: 7, token: 't7' } })
    await client.refreshHost()
    expect(client.auth.isAuthenticated()).toBe(true)

    // The host performs the logout and now reports no session.
    transport.fetchSession.mockResolvedValue({ authenticated: false, user: null })
    await client.auth.logout()

    // The request was forwarded (node half → hq-edge → EDA TriggerLogout),
    // and the emitted state is the HOST's verdict, not a local guess.
    expect(transport.pushLogout).toHaveBeenCalled()
    expect(client.auth.isAuthenticated()).toBe(false)
  })

  it('logout in host mode keeps the authenticated state when the host rejects it', async () => {
    const { client, transport } = makeClient()
    transport.fetchHostMode.mockResolvedValue(true)
    transport.fetchSession.mockResolvedValue({ authenticated: true, user: { id: 7, token: 't7' } })
    await client.refreshHost()

    transport.pushLogout.mockRejectedValueOnce(new Error('host logout failed: HTTP 502'))

    await expect(client.auth.logout()).rejects.toThrow('host logout failed')
    // Never fake the result: the host still reports a session, so we stay
    // authenticated.
    expect(client.auth.isAuthenticated()).toBe(true)
    await expect(client.auth.getAccessToken()).resolves.toBe('t7')
  })

  it('refreshHost notifies only when the credential actually changed', async () => {
    const { client, transport, storage } = makeClient()
    // makeClient uses the real shared localStorage and earlier cases leave a
    // credential behind; host mode must never fall back to it.
    storage.clear()
    transport.fetchHostMode.mockResolvedValue(true)
    transport.fetchSession.mockResolvedValue({ authenticated: true, user: { id: 7, token: 't7' } })
    const seen: unknown[] = []
    client.auth.onAuthStateChanged((info) => seen.push(info))

    await client.refreshHost()
    expect(seen).toEqual([expect.objectContaining({ token: 't7' })])

    // Re-polling an unchanged host must NOT re-notify: `refreshHost()` is run
    // periodically to discover EDA-side login/logout, and re-emitting an
    // identical payload would re-render every mounted card on every tick.
    await client.refreshHost()
    await client.refreshHost()
    expect(seen).toHaveLength(1)

    // The host really logs out → exactly one further notification, and the
    // gate follows the HOST's verdict.
    transport.fetchSession.mockResolvedValue({ authenticated: false, user: null })
    await client.refreshHost()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBeNull()
    expect(client.auth.isAuthenticated()).toBe(false)

    // Logging back in inside EDA is picked up by the same poll.
    transport.fetchSession.mockResolvedValue({ authenticated: true, user: { id: 8, token: 't8' } })
    await client.refreshHost()
    expect(seen).toHaveLength(3)
    expect(client.auth.isAuthenticated()).toBe(true)
    await expect(client.auth.getAccessToken()).resolves.toBe('t8')
  })

  it('host session survives a reconnect until refreshHost resolves a later absence', async () => {
    const { client, transport } = makeClient()
    transport.fetchHostMode.mockResolvedValue(true)
    transport.fetchSession.mockResolvedValue({ authenticated: true, user: { id: 'h1', token: 'h1-tok' } })
    await client.refreshHost()
    expect(client.auth.isAuthenticated()).toBe(true)
    // Host flips to logged-out — the gate must follow.
    transport.fetchSession.mockResolvedValue({ authenticated: false, user: null })
    await client.refreshHost()
    expect(client.auth.isAuthenticated()).toBe(false)
  })
})

describe('subscription (quota + dialog)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    closeLoginDialog()
    // Close any leftover subscription dialog DOM.
    document.querySelectorAll('[data-hq-sub-dialog]').forEach((el) => el.remove())
  })

  it('builds the subscription landing URL with an encoded token', async () => {
    const { buildSubscriptionUrl } = await import('../src/client/lib.js')
    expect(buildSubscriptionUrl({ token: 'a+b/c=d' }))
      .toBe('https://gen.eda.cn/subscription?token=a%2Bb%2Fc%3Dd')
  })

  it('getSubscriptionQuota fetches eda.cn directly and normalizes the payload', async () => {
    const { fetchSubscriptionQuota } = await import('../src/client/lib.js')
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ code: 200, result: { packageName: 'Pro', currentQuota: 3, totalQuota: 10 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const quota = await fetchSubscriptionQuota({
      userId: 'u1', token: 'tok-1', productCode: 'auto-design', fetchImpl,
    })
    expect(quota).toEqual({ hasSubscription: true, packageName: 'Pro', currentQuota: 3, totalQuota: 10 })
    // The request must hit /sub-api/subscriptions/active with auth headers.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/sub-api/subscriptions/active')
    expect(url).toContain('productCode=auto-design')
    expect(url).toContain('userId=u1')
    expect((init.headers as Record<string, string>)['x-token']).toBe('tok-1')
    expect((init.headers as Record<string, string>)['X-User-Id']).toBe('u1')
  })

  it('getSubscriptionQuota returns null without a credential', async () => {
    const { client, storage } = makeClient()
    storage.clear()
    await expect(client.auth.getSubscriptionQuota('erc')).resolves.toBeNull()
  })

  it('openSubscriptionDialog opens the in-app iframe dialog in standalone mode', async () => {
    // Standalone path: a token envelope persists to localStorage (shared
    // backing store), then openSubscriptionDialog must open the in-app
    // iframe dialog at the preferred 1400-wide card size.
    const c2 = makeClient()
    c2.client.handleMessageEvent({ origin: AUTH_ORIGIN, data: JSON.stringify(validEnvelope) })
    await c2.client.auth.openSubscriptionDialog()
    expect(document.querySelector('[data-hq-sub-dialog]')).not.toBeNull()
    const iframe = document.querySelector<HTMLIFrameElement>('[data-hq-sub-dialog-iframe]')
    expect(iframe?.src).toContain('https://gen.eda.cn/subscription')
    expect(iframe?.src).toContain('token=tok-1')
    // Preferred size is honored on the card.
    const card = document.querySelector<HTMLDivElement>('[data-hq-sub-dialog-card]')
    expect(card?.style.width).toContain('1400')
  })

  it('openSubscriptionDialog asks the host (openHostDialog) in host mode, no iframe', async () => {
    const { client, transport } = makeClient()
    transport.fetchHostMode.mockResolvedValue(true)
    transport.fetchSession.mockResolvedValue({ authenticated: true, user: { id: 'h1', token: 'h1-tok' } })
    await client.refreshHost()
    expect(client.auth.isHostMode()).toBe(true)

    const openHostDialog = vi.fn(async (_url: string, _opts?: Record<string, unknown>) => undefined)
    const hostClient = createAuthClient({
      storage: createAuthStorage(localStorage),
      transport,
      windowLike: window as never,
      documentLike: document,
      openHostDialog,
    })
    await hostClient.refreshHost()
    await hostClient.auth.openSubscriptionDialog()
    expect(openHostDialog).toHaveBeenCalledTimes(1)
    expect(openHostDialog.mock.calls[0][0]).toContain('https://gen.eda.cn/subscription?token=h1-tok')
    expect(openHostDialog.mock.calls[0][1]).toMatchObject({ size: { width: 1400, height: 740 }, key: 'hq-subscription-dialog' })
    // No in-app iframe is opened over the host UI.
    expect(document.querySelector('[data-hq-sub-dialog]')).toBeNull()
  })
})
