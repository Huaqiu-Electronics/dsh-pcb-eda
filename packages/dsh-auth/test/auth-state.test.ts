import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disposeAuth,
  getAuth,
  getAuthState,
  registerAuth,
} from '../src/client/auth-state.js'
import type { AuthClient } from '../src/client/client.js'

type Auth = AuthClient['auth']
type AuthInfo = NonNullable<Awaited<ReturnType<Auth['getUserInfo']>>>

function fakeAuth(nickname: string) {
  let listener: Parameters<Auth['onAuthStateChanged']>[0] | null = null
  const unsubscribe = vi.fn(() => {
    listener = null
  })
  const info = { nickname, token: `${nickname}-token` } as AuthInfo
  const auth: Auth = {
    isAuthenticated: () => true,
    getAccessToken: async () => info.token,
    getUserInfo: () => new Promise<AuthInfo | null>(() => {}),
    login: async () => {},
    logout: async () => {},
    onAuthStateChanged(next) {
      listener = next
      return unsubscribe
    },
  }
  return {
    auth,
    emit(nextNickname: string) {
      listener?.({ nickname: nextNickname, token: `${nextNickname}-token` } as AuthInfo)
    },
    unsubscribe,
  }
}

afterEach(() => {
  disposeAuth()
})

describe('auth state registration', () => {
  it('unsubscribes the previous auth client before replacing it', () => {
    const first = fakeAuth('first')
    const second = fakeAuth('second')

    registerAuth(first.auth)
    registerAuth(second.auth)

    expect(first.unsubscribe).toHaveBeenCalledOnce()
    expect(second.unsubscribe).not.toHaveBeenCalled()
    expect(getAuth()).toBe(second.auth)

    first.emit('stale')
    expect(getAuthState().nickname).not.toBe('stale')

    second.emit('current')
    expect(getAuthState()).toEqual({
      authenticated: true,
      nickname: 'current',
      token: 'current-token',
    })
  })
})
