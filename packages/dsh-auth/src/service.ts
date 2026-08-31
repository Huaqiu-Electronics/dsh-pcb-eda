/**
 * Node-side `huaqiuAuth` service: a tiny in-memory credential cache.
 *
 * The browser half of this package owns the login flow (auth.eda.cn iframe +
 * postMessage) and pushes the resulting credentials over the plugin-owned
 * `webServer` route. This node half just stores and exposes them for the
 * tools (`getAccessToken()` → `x-user-token`, `getUserInfo()` → `x-user-id`).
 *
 * The transport is deliberately decoupled: `huaqiuAuth.auth` is a capability
 * (`isAuthenticated`/`getAccessToken`/`getUserInfo`), NOT a promise that the
 * browser and node tokens are the same value (migration plan review #7).
 */

export interface HuaqiuUserInfo {
  id: string
  token: string
  nickname?: string
}

export interface HuaqiuAuthApi {
  isAuthenticated(): boolean
  getAccessToken(): Promise<string | null>
  getUserInfo(): Promise<HuaqiuUserInfo | null>
  /** Node-side no-op: login always happens in the browser. */
  login(): Promise<void>
  logout(): Promise<void>
  onAuthStateChanged(listener: (info: HuaqiuUserInfo | null) => void): () => void
}

export interface HuaqiuAuthService {
  auth: HuaqiuAuthApi
  /** Node-only setters used by the webServer route handlers. */
  setCredentials(info: HuaqiuUserInfo): void
  invalidate(): void
}

export class InMemoryHuaqiuAuthService implements HuaqiuAuthService {
  private current: HuaqiuUserInfo | null = null
  private listeners = new Set<(info: HuaqiuUserInfo | null) => void>()

  readonly auth: HuaqiuAuthApi = {
    isAuthenticated: () => this.current !== null,
    getAccessToken: async () => this.current?.token ?? null,
    getUserInfo: async () => this.current ? { ...this.current } : null,
    login: async () => {
      /* login is a browser action */
    },
    logout: async () => this.invalidate(),
    onAuthStateChanged: (listener) => this.on(listener),
  }

  setCredentials(info: HuaqiuUserInfo): void {
    this.current = { ...info }
    this.emit()
  }

  invalidate(): void {
    if (this.current === null) {
      return
    }
    this.current = null
    this.emit()
  }

  private on(listener: (info: HuaqiuUserInfo | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.current ? { ...this.current } : null)
    }
  }
}
