/**
 * Standalone (no HQ Edge) mirror of the browser-login credential.
 *
 * Host mode has `HuaqiuApiKeySync`: it polls HQ Edge's loopback token endpoint
 * and mirrors the operator token into `HUAQIU_API_KEY`. A standalone product
 * build (the Desktop distribution) has no such endpoint — the credential
 * arrives the way it always did, as a push from the browser half
 * (`auth.eda.cn` iframe → postMessage → `webServer` route → `setCredentials`).
 *
 * So this bridge subscribes to the auth service's own change signal instead of
 * polling, and does exactly what the host sync does with the value it gets:
 *
 *   - a pushed credential (login / silent restore / token refresh) → mirror its
 *     token into `HUAQIU_API_KEY` through the in-memory credential channel, so
 *     the `huaqiu` provider can resolve it per request without the value ever
 *     reaching `.credentials.yaml`;
 *   - a logout / cleared session → unset the reference;
 *   - an unchanged token → write nothing (no churn on the store).
 *
 * The gateway then works "out of the box after login": no restart, no manual
 * key entry. Logout is reflected before the next request because the write
 * happens synchronously inside the auth-state notification.
 *
 * @module @huaqiu/dsh-auth/standaloneCredentials
 */

import {
  clearVolatile,
  HUAQIU_API_KEY_REF,
  isVolatileStore,
  writeVolatile,
} from './apiKeySync.js'
import type { CredentialStore, CredentialStoreProvider, SyncLogger } from './apiKeySync.js'

/** The slice of `huaqiuAuth.auth` this bridge depends on. */
export interface StandaloneAuthPort {
  /** Current credential (pushed value, else the persisted silent-login one). */
  getUserInfo(): Promise<{ readonly id: string, readonly token: string } | null>
  /** Notifies on every credential change (login, refresh, logout). */
  onAuthStateChanged(listener: (info: { readonly token: string } | null) => void): () => void
}

export class HuaqiuStandaloneCredentialBridge {
  private readonly unsubscribe: () => void
  /** Last token mirrored (or `null` when the reference is known-unset). */
  private lastToken: string | null = null
  private disposed = false

  constructor(
    private readonly auth: StandaloneAuthPort,
    private readonly storeProvider: CredentialStoreProvider,
    private readonly log: SyncLogger,
  ) {
    // Subscribe FIRST, then read the current value: a credential pushed
    // between the read and the subscription can then never be missed.
    this.unsubscribe = this.auth.onAuthStateChanged((info) => {
      if (this.disposed) return
      this.fire(info === null ? null : info.token)
    })
  }

  /** Fire-and-forget mirror that never lets a store error escape the emitter. */
  private fire(token: string | null): void {
    void this.mirror(token).catch((error: unknown) => {
      this.log.warn('huaqiu api-key bridge write failed', { error: String(error) })
    })
  }

  /**
   * Initial synchronization: a credential that already existed when the plugin
   * booted (a pushed login from an earlier page, or the persisted silent-login
   * session) reaches the reference without waiting for the next login.
   */
  start(): void {
    void this.auth.getUserInfo()
      .then((info) => this.fire(info === null ? null : info.token))
      .catch((error: unknown) => {
        this.log.warn('huaqiu api-key bridge initial sync failed', { error: String(error) })
      })
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /** Mirror one credential value (or its absence) into `HUAQIU_API_KEY`. */
  async mirror(token: string | null): Promise<void> {
    const store = this.storeProvider()
    if (store === null) {
      // The credentials service may still be activating; the next push (or the
      // initial read) retries. Same self-healing rule as the host sync.
      this.log.debug('huaqiu api-key bridge skipped: credentials service unavailable')
      return
    }
    if (token !== null && token.length > 0) {
      if (token === this.lastToken) return
      this.lastToken = token
      await writeVolatile(store, HUAQIU_API_KEY_REF, token)
      this.log.info('huaqiu api-key credential synced from login', { inMemory: isVolatileStore(store) })
      return
    }
    if (this.lastToken === null) return
    this.lastToken = null
    await clearVolatile(store, HUAQIU_API_KEY_REF)
    this.log.info('huaqiu api-key credential cleared after logout', { inMemory: isVolatileStore(store) })
  }
}

/** Re-exported so `index.ts` can build the store provider in one place. */
export type { CredentialStore }
