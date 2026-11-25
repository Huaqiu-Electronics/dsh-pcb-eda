import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { isNeedsAuthResult, parseToolResult } from '../src/client/ui/common.jsx'
import { disposeAuth, getAuthState, registerAuth, subscribeAuth } from '../src/client/auth-state.js'
import type { AuthClient } from '../src/client/client.js'

describe('parseToolResult / isNeedsAuthResult (toolview card logic)', () => {
  it('parses the JSON text block of a settled tool result', () => {
    const block = { content: [{ type: 'text', text: '{"status":"needs_auth","kind":"schematic","hint":"login"}' }] }
    const result = parseToolResult(block)
    expect(result).toEqual({ status: 'needs_auth', kind: 'schematic', hint: 'login' })
    expect(isNeedsAuthResult(result)).toBe(true)
  })

  it('returns null for empty / non-JSON content', () => {
    expect(parseToolResult(undefined)).toBeNull()
    expect(parseToolResult({ content: [] })).toBeNull()
    expect(parseToolResult({ content: [{ type: 'text', text: 'not json' }] })).toBeNull()
  })

  it('does not treat successful results as needs_auth', () => {
    const result = parseToolResult({ content: [{ type: 'text', text: '{"status":"generated","kind":"symbol"}' }] })
    expect(isNeedsAuthResult(result)).toBe(false)
  })
})

describe('auth-state store (sidebar + card live state)', () => {
  const listeners = new Set<(info: { nickname?: string } | null) => void>()

  function stubAuth(initial: { nickname?: string } | null) {
    let current = initial
    const auth = {
      isAuthenticated: () => current !== null,
      getAccessToken: async () => (current ? 'tok' : null),
      getUserInfo: async () => current,
      login: async () => {},
      logout: async () => {},
      onAuthStateChanged: (cb: (info: { nickname?: string } | null) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      _set(info: { nickname?: string } | null) {
        current = info
        for (const l of listeners) l(info)
      },
    }
    return auth as unknown as AuthClient['auth'] & { _set(info: { nickname?: string } | null): void }
  }

  beforeEach(() => {
    listeners.clear()
  })
  afterEach(() => {
    disposeAuth()
  })

  it('starts logged out and flips to logged in on auth change', async () => {
    const auth = stubAuth(null)
    registerAuth(auth)
    expect(getAuthState().authenticated).toBe(false)

    const callback = vi.fn()
    const unsubscribe = subscribeAuth(callback)

    auth._set({ nickname: 'Alice' })
    expect(getAuthState()).toEqual({ authenticated: true, resolved: true, nickname: 'Alice' })
    expect(callback).toHaveBeenCalled()

    unsubscribe()
    auth._set(null)
    expect(getAuthState().authenticated).toBe(false)
  })

  it('reports nickname from an already-authenticated client', async () => {
    const auth = stubAuth({ nickname: 'Bob' })
    registerAuth(auth)
    await vi.waitFor(() => expect(getAuthState()).toEqual({ authenticated: true, resolved: true, nickname: 'Bob' }))
  })
})
