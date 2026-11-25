// @vitest-environment jsdom
/**
 * The document body as the user meets it.
 *
 * Two behaviours are the whole contract of a preview body: it renders the
 * document, and when it cannot, it says so *inside the document*. A thrown error
 * escaping into the MDI shell would take the panel and the conversation with it,
 * so the failure path is asserted as carefully as the success path.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const calls = { render: 0 }
vi.mock('@huaqiu/ecad-renderer', () => ({
  renderSchematic: async () => { calls.render += 1; return { canvas: {}, viewer: {}, dispose: () => {} } },
  renderPcb: async () => { calls.render += 1; return { canvas: {}, viewer: {}, dispose: () => {} } },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { EcadBody, decodeDocumentText, type EcadBodyProps } from '../src/client/document/EcadBody.js'
import { sheetReferences } from '../src/client/document/sheets.js'

const FLAT = '(kicad_sch (version 20231120) (uuid "root"))'
const HIERARCHICAL = `(kicad_sch (version 20231120) (uuid "root")
  (sheet (at 10 10) (size 20 20)
    (property "Sheetname" "Power")
    (property "Sheet file" ` + '"power.kicad_sch"' + `))
)`

function props(text: string, overrides: Partial<EcadBodyProps> = {}): EcadBodyProps {
  const controller = new AbortController()
  return {
    sessionId: 'session-1',
    resourceAddress: 'dsh-resource://file/session/session-1/boards/main.kicad_sch',
    content: { kind: 'bytes', data: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer> },
    wrap: false,
    scrollportRef: () => {},
    addResource: () => {},
    setResources: () => {},
    useTabInfo: () => ({ tab: { id: 'tab-1', signal: controller.signal } }),
    kind: 'schematic',
    ...overrides,
  }
}

// jsdom never lays anything out, and the mount correctly refuses to render into
// a zero-sized box. Every element is given a box so the real code path runs.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
})

async function render(element: ReturnType<typeof createElement>): Promise<{ root: Root; host: HTMLElement }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  return { root, host }
}

/** Let the mount's animation-frame and microtask chain settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
  })
}

describe('EcadBody', () => {
  it('shows progress, then the rendered document with its interaction hint', async () => {
    const { root, host } = await render(createElement(EcadBody, props(FLAT)))
    expect(host.querySelector('[data-ecad-loading]')).not.toBeNull()
    await settle()
    expect(host.querySelector('[data-ecad-loading]')).toBeNull()
    expect(host.querySelector('[data-ecad-preview]')?.getAttribute('data-ecad-kind')).toBe('schematic')
    expect(host.querySelector('[data-ecad-hint]')?.textContent).toContain('滚轮缩放')
    await act(async () => { root.unmount() })
  })

  it('renders a malformed file as an in-document error, not a crash', async () => {
    const { root, host } = await render(createElement(EcadBody, props('definitely not sexpr')))
    await settle()
    const alert = host.querySelector('[data-ecad-error]')
    expect(alert).not.toBeNull()
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toContain('解析失败')
    await act(async () => { root.unmount() })
  })

  it('discloses declared child sheets and which of them could not be read', async () => {
    const probe = vi.fn(async (path: string) => path.endsWith('power.kicad_sch'))
    const { root, host } = await render(createElement(EcadBody, props(HIERARCHICAL, { probeSheet: probe })))
    await settle()
    const sheets = host.querySelector('[data-ecad-sheets]')
    expect(sheets).not.toBeNull()
    expect(sheets?.textContent).toContain('本图引用 1 个子图')
    expect(sheets?.textContent).toContain('Power')
    // The declared reference is resolved against the document, not the cwd.
    expect(probe).toHaveBeenCalledWith('boards/power.kicad_sch', expect.anything())
    await act(async () => { root.unmount() })
  })

  it('does not claim a hierarchy for a flat schematic', async () => {
    const { root, host } = await render(createElement(EcadBody, props(FLAT)))
    await settle()
    expect(host.querySelector('[data-ecad-sheets]')).toBeNull()
    await act(async () => { root.unmount() })
  })
})

describe('decodeDocumentText', () => {
  it('decodes UTF-8 and drops a byte-order mark', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x28, 0x61, 0x29])
    expect(decodeDocumentText(withBom)).toBe('(a)')
  })

  it('keeps non-ASCII text intact', () => {
    expect(decodeDocumentText(new TextEncoder().encode('原理图 "R1"'))).toBe('原理图 "R1"')
  })
})

describe('sheetReferences against the same fixture the body uses', () => {
  it('finds the one declared sheet', () => {
    const parsed = { sheets: [{ properties: [{ name: 'Sheetname', text: 'Power' }, { name: 'Sheet file', text: 'power.kicad_sch' }] }] }
    expect(sheetReferences(parsed, 'boards/main.kicad_sch')).toHaveLength(1)
  })
})
