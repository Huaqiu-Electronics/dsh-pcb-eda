import { describe, expect, it } from 'vitest'
import { createAuthStorage } from '../src/client/storage.js'

function memoryStorage(initial: string | null = null) {
  let value = initial
  return {
    storage: {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next
      },
      removeItem: () => {
        value = null
      },
    },
    read: () => value,
  }
}

describe('createAuthStorage', () => {
  it('round-trips a valid persisted auth payload', () => {
    const memory = memoryStorage()
    const storage = createAuthStorage(memory.storage)
    const payload = {
      id: 'user-1',
      token: 'token-1',
      nickname: 'Ada',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }

    storage.set(payload)

    expect(storage.get()).toEqual(payload)
  })

  it('evicts malformed or structurally invalid persisted credentials', () => {
    const invalidPayloads = [
      '{',
      JSON.stringify({ id: '', token: 'token-1' }),
      JSON.stringify({ id: 'user-1', token: '' }),
      JSON.stringify({ id: 'user-1', token: 'token-1', expiresAt: 'later' }),
      JSON.stringify({ id: 'user-1', token: 'token-1', expiresAt: Number.NaN }),
    ]

    for (const raw of invalidPayloads) {
      const memory = memoryStorage(raw)
      const storage = createAuthStorage(memory.storage)

      expect(storage.get()).toBeNull()
      expect(memory.read()).toBeNull()
    }
  })
})
