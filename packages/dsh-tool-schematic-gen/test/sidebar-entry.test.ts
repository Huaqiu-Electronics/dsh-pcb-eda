// @vitest-environment jsdom
/**
 * The `Schematic Gen` sidebar toolbutton.
 *
 * Asserts the row lands in the same block as the component-gen rows (after New
 * Session, and after them in family order), carries the L2 semantic
 * attributes, localizes through `<html lang>`, wires its click to the chip
 * insertion and disposes cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SCHEMATIC_ENTRY_SELECTOR,
  mountSchematicGenSidebarEntry,
  schematicEntryCopy,
} from '../src/client/sidebar-entry.js'

/** Minimal dsh sidebar shell: column > root > logoRow(newSession). */
function mountShell(): HTMLElement {
  const column = document.createElement('div')
  column.setAttribute('data-pane', 'sidebar')
  const root = document.createElement('div')
  const logoRow = document.createElement('div')
  logoRow.className = 'logoRow'
  const newBtn = document.createElement('button')
  newBtn.className = 'newSession'
  logoRow.appendChild(newBtn)
  root.appendChild(logoRow)
  column.appendChild(root)
  document.body.appendChild(column)
  return root
}

/** Two pre-existing component-gen rows, in family order. */
function mountFamily(root: HTMLElement): void {
  for (const attribute of ['data-hqcg-footprint-entry', 'data-hqcg-symbol-entry']) {
    const row = document.createElement('button')
    row.setAttribute(attribute, '')
    const logoRow = root.querySelector('[class*="logoRow"]')!
    root.insertBefore(row, logoRow.nextSibling)
  }
}

const follows = (a: Element, b: Element): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

const microtask = (): Promise<void> => Promise.resolve()

describe('schematicEntryCopy', () => {
  it('is zh by default and en on an English host', () => {
    expect(schematicEntryCopy('zh').label).toBe('原理图生成')
    expect(schematicEntryCopy('en').label).toBe('Schematic Gen')
    expect(schematicEntryCopy(undefined).label).toBe('原理图生成')
    expect(schematicEntryCopy('en').tooltip.length).toBeGreaterThan(0)
  })
})

describe('mountSchematicGenSidebarEntry', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('lang')
  })
  afterEach(() => {
    document.documentElement.removeAttribute('lang')
  })

  it('injects the row after New Session with the semantic attributes', () => {
    const root = mountShell()
    const clicks: string[] = []
    const dispose = mountSchematicGenSidebarEntry({ onToggle: () => clicks.push('click') })

    const row = root.querySelector<HTMLElement>(SCHEMATIC_ENTRY_SELECTOR)!
    const newBtn = root.querySelector<HTMLButtonElement>('button.newSession')!
    expect(row).toBeTruthy()
    expect(follows(newBtn, row)).toBe(true)
    expect(row.getAttribute('data-dsh-plugin')).toBe('huaqiu-schematic-gen')
    expect(row.getAttribute('data-dsh-part')).toBe('sidebar-entry')
    expect(row.textContent).toContain('原理图生成')

    row.click()
    expect(clicks).toEqual(['click'])
    dispose()
  })

  it('sits after the component-gen rows in family order', () => {
    const root = mountShell()
    mountFamily(root)
    const dispose = mountSchematicGenSidebarEntry({ onToggle: () => {} })

    const symbol = root.querySelector<HTMLElement>('[data-hqcg-symbol-entry]')!
    const row = root.querySelector<HTMLElement>(SCHEMATIC_ENTRY_SELECTOR)!
    expect(follows(symbol, row)).toBe(true)
    dispose()
  })

  it('re-labels itself when the host language changes', async () => {
    mountShell()
    const dispose = mountSchematicGenSidebarEntry({ onToggle: () => {} })
    const row = document.querySelector<HTMLElement>(SCHEMATIC_ENTRY_SELECTOR)!
    expect(row.textContent).toContain('原理图生成')

    document.documentElement.setAttribute('lang', 'en-US')
    await microtask()
    expect(row.textContent).toContain('Schematic Gen')
    expect(row.getAttribute('aria-label')).toBe('Schematic Gen')
    expect(row.getAttribute('title')).toBe(schematicEntryCopy('en').tooltip)
    dispose()
  })

  it('is idempotent and removes the row on dispose', async () => {
    const root = mountShell()
    const a = mountSchematicGenSidebarEntry({ onToggle: () => {} })
    const b = mountSchematicGenSidebarEntry({ onToggle: () => {} })
    expect(document.querySelectorAll(SCHEMATIC_ENTRY_SELECTOR).length).toBe(1)

    a()
    b()
    expect(document.querySelectorAll(SCHEMATIC_ENTRY_SELECTOR).length).toBe(0)

    // No resurrection after disposal.
    root.innerHTML = '<div class="logoRow"><button class="newSession">new</button></div>'
    await microtask()
    await microtask()
    expect(document.querySelectorAll(SCHEMATIC_ENTRY_SELECTOR).length).toBe(0)
  })

  it('injects its stylesheet exactly once', () => {
    mountShell()
    const a = mountSchematicGenSidebarEntry({ onToggle: () => {} })
    const b = mountSchematicGenSidebarEntry({ onToggle: () => {} })
    expect(document.querySelectorAll('style[data-plugin-css="huaqiu-schematic-gen-sidebar"]').length).toBe(1)
    a()
    b()
  })
})
