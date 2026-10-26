/**
 * The `Schematic Gen` sidebar toolbutton.
 *
 * Regression guard for a migration accident: the row (and its whole module)
 * was deleted with the retired `@huaqiu/dsh-tool-schematic-gen` package and
 * never restored in `@huaqiu/dsh-tool-kicad-schematic-gen`, so the plugin kept
 * loading while its sidebar entry silently vanished. These assertions pin the
 * row's presence, its place in the family block, its semantic attributes and
 * its click wiring.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { JSDOM } from 'jsdom'

// The row is plain DOM, so the DOM has to exist before the module is imported
// (it captures `document` state at mount time).
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const globals = globalThis as unknown as Record<string, unknown>
globals['window'] = dom.window
globals['document'] = dom.window.document
globals['MutationObserver'] = dom.window.MutationObserver
globals['Node'] = dom.window.Node
globals['HTMLElement'] = dom.window.HTMLElement
globals['HTMLButtonElement'] = dom.window.HTMLButtonElement

const {
  SCHEMATIC_ENTRY_SELECTOR,
  mountSchematicGenSidebarEntry,
  schematicEntryCopy,
} = await import('../src/client/sidebar-entry.ts')

const document = dom.window.document

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
  return root as unknown as HTMLElement
}

/** The sibling family rows, mounted in the order the other plugins render them. */
function mountFamily(root: HTMLElement): void {
  for (const attribute of ['data-hqcg-footprint-entry', 'data-hqcg-symbol-entry', 'data-hq-plugin-update-entry']) {
    const row = document.createElement('button')
    row.setAttribute(attribute, '')
    root.appendChild(row)
  }
}

/** Whether `b` follows `a` in document order. */
function follows(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

before(() => {
  document.body.innerHTML = ''
})

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('lang')
})

after(() => {
  dom.window.close()
})

test('row copy is zh by default and en on an English host', () => {
  assert.equal(schematicEntryCopy('zh').label, '原理图生成')
  assert.equal(schematicEntryCopy('en').label, 'Schematic Gen')
  assert.equal(schematicEntryCopy(undefined).label, '原理图生成')
  assert.ok(schematicEntryCopy('en').tooltip.length > 0)
})

test('the row mounts in the family block, after the component-gen rows', () => {
  const root = mountShell()
  mountFamily(root)
  const dispose = mountSchematicGenSidebarEntry({ onToggle: () => {} })

  const row = document.querySelector(SCHEMATIC_ENTRY_SELECTOR)
  assert.ok(row !== null, 'the Schematic Gen row must be injected')
  assert.equal(row.getAttribute('data-dsh-plugin'), 'huaqiu-schematic-gen')
  assert.equal(row.getAttribute('data-dsh-part'), 'sidebar-entry')
  assert.equal(row.getAttribute('aria-label'), '原理图生成')

  const newSession = root.querySelector('[class*="newSession"]')!
  assert.ok(follows(newSession, row!), 'the row sits below New Session')

  const symbol = document.querySelector('[data-hqcg-symbol-entry]')!
  assert.ok(follows(symbol, row!), 'the row lands after Symbol Gen in family order')

  dispose()
  assert.equal(document.querySelector(SCHEMATIC_ENTRY_SELECTOR), null, 'disposal removes the row')
})

test('the row re-labels itself when the host language changes', () => {
  const root = mountShell()
  const dispose = mountSchematicGenSidebarEntry({ onToggle: () => {} })
  const row = document.querySelector(SCHEMATIC_ENTRY_SELECTOR)!

  document.documentElement.setAttribute('lang', 'en')
  // The shared locale observer reports on the next mutation microtask.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(row.getAttribute('aria-label'), 'Schematic Gen')
      dispose()
      assert.ok(root.isConnected)
      resolve()
    }, 0)
  })
})

test('clicking the row runs the toggle action once per click', () => {
  mountShell()
  let clicks = 0
  const dispose = mountSchematicGenSidebarEntry({ onToggle: () => { clicks += 1 } })
  const row = document.querySelector<HTMLButtonElement>(SCHEMATIC_ENTRY_SELECTOR)!

  row.click()
  row.click()
  assert.equal(clicks, 2)
  dispose()
})
