/**
 * Prompt-placement contract for `pcb_preview`.
 *
 * The preview invocation rule used to be an always-on system-prompt section.
 * It now lives in the tool description: the model needs it only when this tool
 * is visible, and the assembled prompt must not pay for it in every session.
 */
import { describe, it, expect, vi } from 'vitest'
import { apply, inject } from '../src/index.js'

describe('pcb_preview prompt placement', () => {
  it('does not register an always-on system-prompt section', () => {
    expect(inject).not.toContain('systemPrompt')

    const section = vi.fn((_section: unknown) => () => {})
    const register = vi.fn((_tool: unknown) => () => {})
    const ctx = {
      tools: { register },
      systemPrompt: { section },
    }
    apply(ctx as never)

    expect(section).not.toHaveBeenCalled()
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('keeps invocation and reporting rules in the tool description', () => {
    const register = vi.fn((_tool: unknown) => () => {})
    apply({ tools: { register } } as never)

    const tool = register.mock.calls[0]![0] as { description: string }
    expect(tool.description).toMatch(/\.kicad_pcb path/)
    expect(tool.description).toMatch(/view\/preview\/render a PCB board/)
    expect(tool.description).toMatch(/right panel/)
    expect(tool.description).toMatch(/do not paste board file contents/)
  })
})
