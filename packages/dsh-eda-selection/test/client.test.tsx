// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { apply, EDA_SELECTION_NS, inject, SelectionDock } from '../src/client/index.js'
import type { SelectionSnapshot } from '../src/client/hq-edge.js'

// React 19 wants the act environment flag set before any render.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: Root; container: HTMLElement }> = []

function render(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(node as never)
  })
  mounted.push({ root, container })
  return container
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()
    if (!entry) break
    act(() => entry.root.unmount())
    entry.container.remove()
  }
})

/** The dictionary the locale service hands back, keyed by this namespace. */
const identityTranslate = (key: string) => key

function snapshot(over: Partial<SelectionSnapshot> = {}): SelectionSnapshot {
  return {
    hasSelection: true,
    itemCount: 3,
    editor: 'PCB',
    labels: ['U1', 'R3', 'C7'],
    revision: '12',
    ...over,
  }
}

/** A bridge double with a mutable current value and a real listener set. */
function makeEdge(initial: SelectionSnapshot | null = null) {
  let current = initial
  const listeners = new Set<(next: SelectionSnapshot | null) => void>()
  return {
    selection: {
      getCurrent: () => current,
      onChanged(listener: (next: SelectionSnapshot | null) => void) {
        listeners.add(listener)
        // The real bridge replays immediately when a state is already known.
        if (current !== null) listener(current)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    publish(next: SelectionSnapshot | null) {
      current = next
      for (const listener of [...listeners]) listener(next)
    },
    listenerCount: () => listeners.size,
  }
}

interface Registered {
  slot: string
  spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }
  component: () => unknown
  dispose: () => void
}

/** A minimal cordis client context double that records everything it is given. */
function makeCtx(edge: ReturnType<typeof makeEdge> | null) {
  const registrations: Registered[] = []
  const dictionaries: Record<string, unknown> = {}
  const effects: string[] = []
  const ctx = {
    slots: {
      inject: (slot: string, callback: () => () => void) => {
        return callback()
      },
      register: (
        spec: Registered['spec'],
        component: () => unknown,
      ) => {
        const dispose = () => {
          const at = registrations.findIndex((r) => r.spec === spec)
          if (at >= 0) registrations.splice(at, 1)
        }
        registrations.push({ slot: '', spec, component, dispose })
        return dispose
      },
    },
    locale: {
      register: (namespace: string, dicts: unknown) => {
        dictionaries[namespace] = dicts
      },
      bind: () => identityTranslate,
    },
    get: (name: string) => (name === 'hqEdge' ? (edge ?? undefined) : undefined),
    effect: (fn: () => (() => void) | void, label?: string) => {
      effects.push(label ?? '')
      fn()
    },
  }
  // `slots.inject` is called with the slot name by the plugin; record it.
  const originalInject = ctx.slots.inject
  ctx.slots.inject = (slot: string, callback: () => () => void) => {
    const result = callback()
    for (const r of registrations) {
      if (r.slot === '') r.slot = slot
    }
    return result
  }
  void originalInject

  return { ctx, registrations, dictionaries, effects }
}

describe('apply() — dock entry registration', () => {
  it('declares the services it needs', () => {
    expect([...inject]).toEqual(['slots', 'locale', 'hqEdge'])
  })

  it('registers the dictionaries under its own namespace', () => {
    const { ctx, dictionaries } = makeCtx(makeEdge())
    apply(ctx as never)
    expect(Object.keys(dictionaries)).toEqual([EDA_SELECTION_NS])
    expect(dictionaries[EDA_SELECTION_NS]).toHaveProperty('zh')
    expect(dictionaries[EDA_SELECTION_NS]).toHaveProperty('en')
  })

  it('installs exactly one dock entry, beside the shipped ones', () => {
    const { ctx, registrations } = makeCtx(makeEdge())
    apply(ctx as never)
    expect(registrations).toHaveLength(1)
    const entry = registrations[0]
    expect(entry?.slot).toBe('conversation.input.dock')
    expect(entry?.spec.name).toBe('conversation.input.dock')
    // Our own id: a fresh entry is added BESIDE queue/todo/goal, never replacing one.
    expect(entry?.spec.id).toBe('eda-selection')
    // Above `queue` (20), below `todo` (0).
    expect(entry?.spec.order).toBe(5)
    expect(entry?.spec.locale).toBe(EDA_SELECTION_NS)
    expect(entry?.spec.label?.()).toBe('dock.label')
  })

  it('runs through ctx.effect so the entry participates in teardown', () => {
    const { ctx, effects } = makeCtx(makeEdge())
    apply(ctx as never)
    expect(effects).toHaveLength(1)
    expect(effects[0]).toContain('eda-selection')
  })

  it('never throws without the slot service', () => {
    const ctx = {
      locale: { register: vi.fn(), bind: () => identityTranslate },
      get: () => makeEdge(),
    }
    expect(() => apply(ctx as never)).not.toThrow()
  })

  it('never throws without the locale service', () => {
    const { ctx, registrations } = makeCtx(makeEdge())
    delete (ctx as { locale?: unknown }).locale
    expect(() => apply(ctx as never)).not.toThrow()
    expect(registrations).toHaveLength(1)
  })

  it('survives a locale.register that throws (duplicate registration)', () => {
    const { ctx, registrations } = makeCtx(makeEdge())
    ctx.locale.register = () => {
      throw new Error('already registered')
    }
    expect(() => apply(ctx as never)).not.toThrow()
    expect(registrations).toHaveLength(1)
  })
})

describe('SelectionDock — rendering', () => {
  it('renders nothing while the state is unknown', () => {
    const container = render(<SelectionDock t={identityTranslate} getEdge={() => makeEdge(null).selection as never} />)
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders nothing for a known-empty selection', () => {
    const edge = makeEdge(snapshot({ hasSelection: false, itemCount: 0, labels: [], revision: '13' }))
    const container = render(<SelectionDock t={identityTranslate} getEdge={() => edge as never} />)
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()
  })

  it('renders the chip when a selection is published', () => {
    const edge = makeEdge(null)
    const container = render(<SelectionDock t={identityTranslate} getEdge={() => edge as never} />)
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()

    act(() => {
      edge.publish(snapshot())
    })

    const chip = container.querySelector('[data-dsh-part="selection-chip"]')
    expect(chip).not.toBeNull()
    // The identity translator echoes its keys, so the rendered line is the
    // concatenation of the keys in order — which is exactly what proves the
    // component feeds the snapshot through the dictionary rather than
    // hardcoding copy. Note the MISSING space before `chip.labels`: the colon
    // lives inside that localized string, so it is appended without a joining
    // space (see `formatSelectionChip`).
    expect(chip?.textContent).toBe(
      'chip.label chip.sep chip.items (editor.pcb)chip.labels',
    )
    expect(chip?.getAttribute('data-editor')).toBe('PCB')
    expect(chip?.getAttribute('data-revision')).toBe('12')
    expect(chip?.getAttribute('role')).toBe('status')
    expect(chip?.getAttribute('aria-label')).toBe('chip.aria')
  })

  it('re-renders on every published change', () => {
    const edge = makeEdge(null)
    const container = render(<SelectionDock t={identityTranslate} getEdge={() => edge as never} />)

    act(() => {
      edge.publish(snapshot())
    })
    expect(container.querySelector('[data-dsh-part="selection-chip"]')?.textContent).toContain('chip.items')

    act(() => {
      edge.publish(snapshot({ itemCount: 1, labels: ['R1'], revision: '13' }))
    })
    expect(container.querySelector('[data-dsh-part="selection-chip"]')?.textContent).toBe(
      'chip.label chip.sep chip.item (editor.pcb)chip.labels',
    )

    act(() => {
      edge.publish(null)
    })
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()
  })

  it('subscribes once and unsubscribes on unmount', () => {
    const edge = makeEdge(null)
    const { root, container } = (() => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const r = createRoot(el)
      act(() => {
        r.render(<SelectionDock t={identityTranslate} getEdge={() => edge as never} /> as never)
      })
      return { root: r, container: el }
    })()
    expect(edge.listenerCount()).toBe(1)

    act(() => root.unmount())
    expect(edge.listenerCount()).toBe(0)
    container.remove()
  })

  it('renders nothing permanently when the bridge is missing', () => {
    const container = render(<SelectionDock t={identityTranslate} getEdge={() => undefined} />)
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders nothing when the bridge predates the selection face', () => {
    const container = render(
      <SelectionDock t={identityTranslate} getEdge={() => ({ selection: undefined }) as never} />,
    )
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()
  })
})

describe('apply() — the installed entry end to end', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('mounts the chip the slot was given and keeps it live', () => {
    const edge = makeEdge(null)
    const { ctx, registrations } = makeCtx(edge)
    apply(ctx as never)

    const component = registrations[0]?.component as () => React.ReactElement
    const container = render(component())
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()

    act(() => {
      edge.publish(snapshot())
    })
    expect(container.querySelector('[data-dsh-part="selection-chip"]')?.textContent).toContain('chip.items')
  })

  it('the slot disposer removes the registration', () => {
    const edge = makeEdge(null)
    const { ctx, registrations } = makeCtx(edge)
    apply(ctx as never)
    expect(registrations).toHaveLength(1)

    act(() => registrations[0]?.dispose())

    // The registration is gone. (Unmounting the component the slot renders is
    // what disposes the bridge subscription — covered above — and that is the
    // real slot's job, not this double's.)
    expect(registrations).toHaveLength(0)
  })

  it('a missing bridge leaves the entry installed but the chip empty', () => {
    const { ctx, registrations } = makeCtx(null)
    expect(() => apply(ctx as never)).not.toThrow()

    const component = registrations[0]?.component as () => React.ReactElement
    const container = render(component())
    expect(container.querySelector('[data-dsh-part="selection-chip"]')).toBeNull()
    expect(container.textContent).toBe('')
  })
})
