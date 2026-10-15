// @vitest-environment jsdom
/**
 * DOM regression guard for the shared sidebar entry row.
 *
 * Builds a minimal fake sidebar shell and asserts placement, semantic
 * attributes, click wiring, DOM-level idempotency, self-healing after a React
 * re-render displaces the row, family ordering, label refresh and disposal.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mountSidebarEntry, type SidebarEntryOptions } from '../src/index.js'

/** Minimal dsh sidebar shell: column > root > logoRow(newSession). */
function mountShell(): HTMLElement {
  const column = document.createElement('div')
  column.setAttribute('data-pane', 'sidebar')
  const root = document.createElement('div')
  const logoRow = document.createElement('div')
  logoRow.className = 'logoRow'
  const newBtn = document.createElement('button')
  newBtn.className = 'newSession'
  newBtn.textContent = 'new session'
  logoRow.appendChild(newBtn)
  root.appendChild(logoRow)
  column.appendChild(root)
  document.body.appendChild(column)
  return root
}

/** One row option set; callers override what they assert on. */
function options(overrides: Partial<SidebarEntryOptions> = {}): SidebarEntryOptions {
  return {
    rowAttribute: 'data-test-entry',
    rowSelector: '[data-test-entry]',
    plugin: 'huaqiu-test',
    icon: '<svg viewBox="0 0 16 16"></svg>',
    css: { entry: 'row', entryIcon: 'row__icon', entryLabel: 'row__label' },
    label: () => 'entry',
    tooltip: () => 'open entry',
    position: 'after',
    onToggle: () => {},
    familySelectors: ['[data-test-entry]'],
    ...overrides,
  }
}

/** Whether `b` follows `a` in document order. */
function follows(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

async function microtask(): Promise<void> {
  await Promise.resolve()
}

describe('mountSidebarEntry', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('lang')
  })

  it('injects the row after New Session with the semantic attributes', () => {
    const root = mountShell()
    const clicks: string[] = []
    const dispose = mountSidebarEntry(options({ onToggle: () => clicks.push('clicked') }))

    const row = root.querySelector<HTMLElement>('[data-test-entry]')!
    const newBtn = root.querySelector<HTMLButtonElement>('button.newSession')!
    expect(row).toBeTruthy()
    expect(follows(newBtn, row)).toBe(true)
    expect(row.getAttribute('data-dsh-plugin')).toBe('huaqiu-test')
    expect(row.getAttribute('data-dsh-part')).toBe('sidebar-entry')
    expect(row.getAttribute('aria-label')).toBe('entry')
    expect(row.getAttribute('title')).toBe('open entry')
    expect(row.textContent).toContain('entry')
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('type')).toBe('button')

    row.click()
    expect(clicks).toEqual(['clicked'])
    dispose()
  })

  it('is DOM-level idempotent', () => {
    mountShell()
    const a = mountSidebarEntry(options())
    const b = mountSidebarEntry(options())
    expect(document.querySelectorAll('[data-test-entry]').length).toBe(1)
    a()
    b()
  })

  it('self-heals when a React re-render displaces the row', async () => {
    const root = mountShell()
    const dispose = mountSidebarEntry(options())
    const row = root.querySelector<HTMLElement>('[data-test-entry]')!
    expect(row).toBeTruthy()

    // Simulate React replacing the sidebar subtree: the row is torn out.
    root.innerHTML = '<div class="logoRow"><button class="newSession">new</button></div>'
    expect(document.body.contains(row)).toBe(false)

    // The observers run as microtasks after the mutation record is delivered.
    await microtask()
    await microtask()
    expect(document.querySelectorAll('[data-test-entry]').length).toBe(1)
    dispose()
  })

  it('keeps family order across a re-render', async () => {
    const root = mountShell()
    const family = ['[data-row-a]', '[data-row-b]'] as const
    const disposeA = mountSidebarEntry({
      ...options({ rowAttribute: 'data-row-a', rowSelector: family[0], position: 'before', familySelectors: family }),
    })
    const disposeB = mountSidebarEntry({
      ...options({ rowAttribute: 'data-row-b', rowSelector: family[1], position: 'after', familySelectors: family }),
    })
    const a = root.querySelector<HTMLElement>(family[0])!
    const b = root.querySelector<HTMLElement>(family[1])!
    expect(follows(a, b)).toBe(true)

    // Displace both and let every plugin re-place: order must be preserved.
    root.innerHTML = '<div class="logoRow"><button class="newSession">new</button></div>'
    await microtask()
    await microtask()
    expect(follows(a, b)).toBe(true)

    disposeA()
    disposeB()
  })

  it('re-applies localized labels on refresh', () => {
    mountShell()
    let lang: 'zh' | 'en' = 'zh'
    const listeners = new Set<() => void>()
    const subscribe = (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
    const dispose = mountSidebarEntry(options({
      label: () => (lang === 'zh' ? '原理图生成' : 'Schematic Gen'),
      tooltip: () => (lang === 'zh' ? '打开原理图生成' : 'Open schematic generator'),
      refresh: { subscribe },
    }))
    const row = document.querySelector<HTMLElement>('[data-test-entry]')!

    expect(row.textContent).toContain('原理图生成')
    expect(row.getAttribute('title')).toBe('打开原理图生成')

    lang = 'en'
    for (const fn of [...listeners]) fn()
    expect(row.textContent).toContain('Schematic Gen')
    expect(row.getAttribute('title')).toBe('Open schematic generator')
    dispose()
  })

  it('reflects the active bridge via data-active and never writes "undefined"', () => {
    mountShell()
    let open = true
    const listeners = new Set<() => void>()
    const subscribe = (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
    const dispose = mountSidebarEntry(options({
      active: { subscribe, isOpen: () => open },
    }))
    const row = document.querySelector<HTMLElement>('[data-test-entry]')!
    expect(row.hasAttribute('data-active')).toBe(true)

    open = false
    for (const fn of [...listeners]) fn()
    expect(row.hasAttribute('data-active')).toBe(false)
    dispose()
  })

  it('removes the row and stops its observers on dispose', async () => {
    const root = mountShell()
    const dispose = mountSidebarEntry(options())
    expect(document.querySelectorAll('[data-test-entry]').length).toBe(1)
    dispose()
    expect(document.querySelectorAll('[data-test-entry]').length).toBe(0)

    // After disposal the row must not come back on a later re-render.
    root.innerHTML = '<div class="logoRow"><button class="newSession">new</button></div>'
    await microtask()
    await microtask()
    expect(document.querySelectorAll('[data-test-entry]').length).toBe(0)
  })
})
