/**
 * localStorage-backed credential cache (client side). Survives reload, which
 * is what makes the fingerprint silent-login restore (acceptance group D) work.
 */
import type { AuthTokenPayload } from './lib.js'

export const DEFAULT_STORAGE_KEY = 'huaqiu.dsh.auth'

export interface AuthStorage {
  get(): AuthTokenPayload | null
  set(info: AuthTokenPayload): void
  clear(): void
}

export function createAuthStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string = DEFAULT_STORAGE_KEY,
): AuthStorage {
  return {
    get() {
      const raw = storage.getItem(key)
      if (!raw) {
        return null
      }
      try {
        const parsed = JSON.parse(raw) as AuthTokenPayload
        const invalidIdentity =
          !parsed ||
          typeof parsed.token !== 'string' ||
          parsed.token.length === 0 ||
          typeof parsed.id !== 'string' ||
          parsed.id.length === 0
        const invalidExpiry =
          parsed?.expiresAt !== undefined &&
          (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt))
        if (invalidIdentity || invalidExpiry) {
          storage.removeItem(key)
          return null
        }
        // Parity with auth.eda.cn's 5-day token window.
        if (parsed.expiresAt !== undefined && parsed.expiresAt * 1000 <= Date.now()) {
          storage.removeItem(key)
          return null
        }
        return parsed
      } catch {
        storage.removeItem(key)
        return null
      }
    },
    set(info) {
      storage.setItem(key, JSON.stringify(info))
    },
    clear() {
      storage.removeItem(key)
    },
  }
}
