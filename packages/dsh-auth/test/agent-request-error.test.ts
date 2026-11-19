import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  createHuaqiuMissingCredentialLoginListener,
  type RequestErrorListenerView,
  type RequestErrorPayloadView,
} from '../src/index.js'
import type { InMemoryHuaqiuAuthService } from '../src/service.js'

// Keep the service constructor away from a real ~/.dsh/auth/session.json.
const TMP = join(tmpdir(), `dsh-auth-request-error-test-${process.pid}`)
vi.mock('@deepseek-ai/dsh-home-paths', () => ({ dshHomePath: () => TMP }))

function makeService(hostMode = true) {
  const login = vi.fn(async () => {})
  return {
    service: {
      hostMode,
      auth: { login },
    },
    login,
  }
}

function payload(overrides: {
  provider?: string
  code?: string
  aborted?: boolean
} = {}): RequestErrorPayloadView {
  return {
    provider: overrides.provider ?? 'huaqiu',
    failure: { code: overrides.code ?? 'MISSING_CREDENTIAL' },
    signal: { aborted: overrides.aborted ?? false } as AbortSignal,
  }
}

const terminal = async () => undefined

describe('createHuaqiuMissingCredentialLoginListener', () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }))
  afterEach(() => rmSync(TMP, { recursive: true, force: true }))

  it('opens login for a live huaqiu MISSING_CREDENTIAL and preserves the terminal action', async () => {
    const { service, login } = makeService()
    const next = vi.fn(terminal)
    const listener = createHuaqiuMissingCredentialLoginListener(service)

    const action = await listener(payload(), next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(login).toHaveBeenCalledTimes(1)
    expect(action).toBeUndefined()
  })

  it('delegates to the waterfall before deciding', async () => {
    const { service, login } = makeService()
    const order: string[] = []
    const listener = createHuaqiuMissingCredentialLoginListener(service, () => {
      // no warnings expected on the happy path
      order.push('warn')
    })

    await listener(payload(), async () => {
      order.push('next')
      return undefined
    })
    expect(order).toEqual(['next'])
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('does not open login when an inner listener chose retry', async () => {
    const { service, login } = makeService()
    const listener = createHuaqiuMissingCredentialLoginListener(service)
    const action = await listener(payload(), async () => ({ kind: 'retry' }))

    expect(action).toEqual({ kind: 'retry' })
    expect(login).not.toHaveBeenCalled()
  })

  it('does not open login in standalone mode', async () => {
    const { service, login } = makeService(false)
    await createHuaqiuMissingCredentialLoginListener(service)(payload(), terminal)
    expect(login).not.toHaveBeenCalled()
  })

  it('never opens Huaqiu login for another provider', async () => {
    for (const provider of ['deepseek-official', 'openai', 'anthropic', 'unknown']) {
      const { service, login } = makeService()
      await createHuaqiuMissingCredentialLoginListener(service)(payload({ provider }), terminal)
      expect(login).not.toHaveBeenCalled()
    }
  })

  it('never opens login for another failure code, even with Huaqiu wording', async () => {
    for (const code of ['QUOTA', 'PI_AI_ERROR', 'RATE_LIMITED', 'AUTHENTICATION_FAILED']) {
      const { service, login } = makeService()
      await createHuaqiuMissingCredentialLoginListener(service)(payload({ code }), terminal)
      expect(login).not.toHaveBeenCalled()
    }
  })

  it('does not open login for an aborted turn', async () => {
    const { service, login } = makeService()
    await createHuaqiuMissingCredentialLoginListener(service)(payload({ aborted: true }), terminal)
    expect(login).not.toHaveBeenCalled()
  })

  it('coalesces concurrent failures and allows a fresh login once it settles', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const login = vi.fn(async () => pending)
    const service = { hostMode: true, auth: { login } }
    const listener = createHuaqiuMissingCredentialLoginListener(service)

    const first = listener(payload(), terminal)
    const second = listener(payload(), terminal)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(login).toHaveBeenCalledTimes(1)

    release()
    await Promise.all([first, second])
    await listener(payload(), terminal)
    expect(login).toHaveBeenCalledTimes(2)
  })

  it('swallows a login failure, logs it, and does not poison later failures', async () => {
    const login = vi.fn(async () => {
      throw new Error('host login not completed: HTTP 502')
    })
    const service = { hostMode: true, auth: { login } }
    const warn = vi.fn()
    const listener = createHuaqiuMissingCredentialLoginListener(service, warn)

    const action = await listener(payload(), terminal)
    expect(action).toBeUndefined()
    // The hook is fire-and-forget: let the rejected promise's catch run.
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith('automatic Huaqiu login failed', {
      error: 'Error: host login not completed: HTTP 502',
    })

    await listener(payload(), terminal)
    expect(login).toHaveBeenCalledTimes(2)
  })
})

/** Minimal Cordis context: enough to observe what the plugin registers. */
function makeCtx() {
  const events: string[] = []
  let listener: RequestErrorListenerView | undefined
  let provided: InMemoryHuaqiuAuthService | undefined
  let effects = 0
  const ctx = {
    on(event: string, fn: RequestErrorListenerView) {
      events.push(event)
      if (event === 'agent/request-error') listener = fn
      return { dispose() {} }
    },
    effect(fn: () => unknown) {
      effects += 1
      // Run only the `ctx.provide` effect. The webServer route registration
      // and the 5 s credential-sync poll are outside this unit's scope.
      if (effects === 1) fn()
      return { dispose() {} }
    },
    provide(key: string, value: unknown) {
      if (key === 'huaqiuAuth') provided = value as InMemoryHuaqiuAuthService
      return { dispose() {} }
    },
    get() {
      return undefined
    },
    webServer: {
      register() {
        return { dispose() {} }
      },
    },
  }
  return {
    ctx,
    events,
    get listener() {
      return listener
    },
    get service() {
      return provided
    },
  }
}

describe('dsh-auth node plugin registration', () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }))
  afterEach(() => rmSync(TMP, { recursive: true, force: true }))

  it('subscribes only to the live request-error event, never to durable session events', () => {
    const fake = makeCtx()
    apply(fake.ctx as never, { hqEdgeBaseUrl: 'http://127.0.0.1:1' })

    expect(fake.events).toEqual(['agent/request-error'])
    expect(fake.listener).toBeTypeOf('function')
    expect(fake.service?.hostMode).toBe(true)
  })

  it('wires the registered hook to the applied service', async () => {
    const fake = makeCtx()
    apply(fake.ctx as never, { hqEdgeBaseUrl: 'http://127.0.0.1:1' })
    const login = vi.spyOn(fake.service!.auth, 'login').mockResolvedValue(undefined)

    await fake.listener!(payload(), terminal)
    expect(login).toHaveBeenCalledTimes(1)
  })
})
