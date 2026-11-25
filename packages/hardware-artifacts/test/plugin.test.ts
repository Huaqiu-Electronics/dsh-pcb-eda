/**
 * Plugin wiring.
 *
 * `apply` is what the profile actually mounts, so the tool set has to arrive
 * through it — not only through `createHardwareTools`. A stub host is enough:
 * the point is which services are touched and what is registered, both of which
 * are observable without a Cordis runtime.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { hardwareToolNames } from '../src/tools.js'

interface StubHost {
  readonly registered: string[]
  readonly provided: string[]
  readonly effects: string[]
}

function mount(options: { tools?: boolean; webServer?: boolean } = {}): StubHost {
  const registered: string[] = []
  const provided: string[] = []
  const effects: string[] = []
  const services: Record<string, unknown> = {}
  if (options.tools !== false) {
    services.tools = {
      register: (tool: { readonly name: string }) => {
        registered.push(tool.name)
        return (): void => {}
      },
    }
  }
  if (options.webServer === true) {
    services.webServer = { register: () => (): void => {} }
  }
  const ctx = {
    get: (name: string) => services[name],
    provide: (name: string) => { provided.push(name) },
    effect: (fn: () => unknown, label?: string) => {
      effects.push(label ?? '')
      // Cordis invokes the effect body and keeps its disposer; nothing here
      // needs a later disposer, but the body must actually run.
      void fn()
    },
    ...(options.webServer === true ? { webServer: services.webServer } : {}),
  }
  apply(ctx as unknown as Parameters<typeof apply>[0], {})
  return { registered, provided, effects }
}

describe('profile wiring', () => {
  it('registers the hardware tools through the agent tool registry', () => {
    const host = mount()
    expect(host.registered).toEqual(hardwareToolNames())
    expect(host.provided).toEqual(['hardwareArtifacts'])
    expect(host.effects).toContain('hardware-artifacts: hardware_fabricate')
  })

  it('mounts without a tool registry, losing only the agent surface', () => {
    const host = mount({ tools: false })
    expect(host.registered).toEqual([])
    // The service the client half consumes is still provided.
    expect(host.provided).toEqual(['hardwareArtifacts'])
  })

  it('registers the local routes and the tools together', () => {
    const host = mount({ webServer: true })
    expect(host.registered).toEqual(hardwareToolNames())
    expect(host.effects).toContain('hardware-artifacts: local read/launch routes')
  })
})
