/**
 * What the plugin actually contributes to DSH's document seats.
 *
 * The claim under test is narrow and load-bearing: three definitions in the
 * document-preview registry, three bodies in the keyed document slot, all under
 * the same ids, and nothing registered at all when the Host does not expose
 * those seats. If this drifts, ECAD files silently fall back to the text view.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@huaqiu/ecad-renderer', () => ({
  renderSchematic: async () => ({ canvas: {}, viewer: {}, dispose: () => {} }),
  renderPcb: async () => ({ canvas: {}, viewer: {}, dispose: () => {} }),
}))
vi.mock('three', () => ({
  AmbientLight: class {}, Box3: class {}, BufferGeometry: class {}, Color: class {}, DirectionalLight: class {},
  DoubleSide: 2, Float32BufferAttribute: class {}, Group: class {}, HemisphereLight: class {}, Mesh: class {},
  MeshStandardMaterial: class {}, PerspectiveCamera: class {}, Scene: class {}, Vector3: class {}, WebGLRenderer: class {},
}))
vi.mock('three/addons/controls/OrbitControls.js', () => ({ OrbitControls: class {} }))
vi.mock('occt-import-js', () => ({ default: async () => ({ ReadStepFile: () => ({ success: false, meshes: [] }) }) }))

import {
  PCB_BODY_ID, SCHEMATIC_BODY_ID, STEP_BODY_ID,
  documentPreviewDefinitions, installDocumentPreviews,
} from '../src/client/document/index.js'
import type { DocumentClientContext, DocumentPreviewDefinition } from '../src/client/document/contract.js'

interface RecordedSlot {
  readonly spec: { readonly name: string; readonly key: string; readonly inject?: (...args: unknown[]) => object }
  readonly component: unknown
}

function fakeContext(): {
  ctx: DocumentClientContext
  definitions: DocumentPreviewDefinition[]
  slots: RecordedSlot[]
  bodies: string[]
  effects: string[]
  disposeAll(): void
} {
  const definitions: DocumentPreviewDefinition[] = []
  const slots: RecordedSlot[] = []
  const bodies: string[] = []
  const effects: string[] = []
  const disposers: (() => void)[] = []
  const ctx: DocumentClientContext = {
    documentPreviews: {
      register(definition) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index !== -1) definitions.splice(index, 1)
        }
      },
    },
    slots: {
      inject(key, callback) {
        bodies.push(key)
        return callback()
      },
      register(spec, component) {
        slots.push({ spec: spec as RecordedSlot['spec'], component })
        return () => {
          const index = slots.indexOf(slots[slots.length - 1] as RecordedSlot)
          if (index !== -1) slots.splice(index, 1)
        }
      },
    },
    effect(fn, label) {
      effects.push(label ?? '')
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
  }
  return {
    ctx, definitions, slots, bodies, effects,
    disposeAll: () => { for (const disposer of disposers.reverse()) disposer() },
  }
}

describe('documentPreviewDefinitions', () => {
  it('claims the four ECAD suffixes with an external-band priority and whole-byte reads', () => {
    const definitions = documentPreviewDefinitions()
    expect(definitions.map(definition => definition.id)).toEqual([SCHEMATIC_BODY_ID, PCB_BODY_ID, STEP_BODY_ID])
    expect(definitions.map(definition => definition.extensions)).toEqual([
      ['kicad_sch'], ['kicad_pcb'], ['step', 'stp'],
    ])
    for (const definition of definitions) {
      // 'extension' is what puts the graphic viewer ahead of the plain-text
      // fallback in the owner's ranking.
      expect(definition.priority).toBe('extension')
      expect(definition.loading).toBe('bytes-complete')
      expect(definition.wrap).toBe(false)
    }
  })

  it('labels each viewer for the document toolbar', () => {
    expect(documentPreviewDefinitions().map(definition => definition.title())).toEqual(['原理图', 'PCB', '3D 模型'])
  })

  it('returns a fresh list, so installing twice cannot share mutation', () => {
    expect(documentPreviewDefinitions()).not.toBe(documentPreviewDefinitions())
  })
})

describe('installDocumentPreviews', () => {
  it('registers one definition and one body per kind under the same id', () => {
    const fake = fakeContext()
    installDocumentPreviews(fake.ctx)

    expect(fake.definitions.map(definition => definition.id)).toEqual([SCHEMATIC_BODY_ID, PCB_BODY_ID, STEP_BODY_ID])
    expect(fake.bodies).toEqual([
      'sidebar.right.tab.document', 'sidebar.right.tab.document', 'sidebar.right.tab.document',
    ])
    expect(fake.slots.map(entry => entry.spec.key)).toEqual([SCHEMATIC_BODY_ID, PCB_BODY_ID, STEP_BODY_ID])
    expect(fake.slots.every(entry => entry.spec.name === 'sidebar.right.tab.document')).toBe(true)
    // A body is useless without its definition, so both live under one effect label each.
    expect(fake.effects).toEqual([
      `hardware-ui: document ${SCHEMATIC_BODY_ID}`,
      `hardware-ui: document ${PCB_BODY_ID}`,
      `hardware-ui: document ${STEP_BODY_ID}`,
      `hardware-ui: document body ${SCHEMATIC_BODY_ID}`,
      `hardware-ui: document body ${PCB_BODY_ID}`,
      `hardware-ui: document body ${STEP_BODY_ID}`,
    ])
  })

  it('injects the kind each ECAD body renders', () => {
    const fake = fakeContext()
    installDocumentPreviews(fake.ctx)
    expect(fake.slots[0]?.spec.inject?.('session-1')).toEqual({ kind: 'schematic' })
    expect(fake.slots[1]?.spec.inject?.('session-1')).toEqual({ kind: 'pcb' })
  })

  it('passes the sheet probe through when the host provides one', () => {
    const fake = fakeContext()
    const probe = async (): Promise<boolean> => true
    installDocumentPreviews(fake.ctx, { probeSheet: () => probe })
    expect(fake.slots[0]?.spec.inject?.('session-1')).toEqual({ kind: 'schematic', probeSheet: probe })
    expect(fake.slots[1]?.spec.inject?.('session-1')).toEqual({ kind: 'pcb', probeSheet: probe })
  })

  it('takes the reader URL from the host when one is supplied', () => {
    const fake = fakeContext()
    installDocumentPreviews(fake.ctx, { stepWasmUrl: '/custom/occt.wasm' })
    expect(fake.slots[2]?.spec.inject?.()).toEqual({ wasmUrl: '/custom/occt.wasm' })
  })

  it('registers nothing when the Host has no document seats, instead of throwing', () => {
    expect(() => installDocumentPreviews({})).not.toThrow()
    const slotsOnly: RecordedSlot[] = []
    installDocumentPreviews({
      slots: { inject: (_key, callback) => callback(), register: (spec) => { slotsOnly.push({ spec: spec as RecordedSlot['spec'], component: undefined }); return () => {} } },
    })
    expect(slotsOnly).toEqual([])
  })

  it('retires every registration when the plugin unloads', () => {
    const fake = fakeContext()
    installDocumentPreviews(fake.ctx)
    expect(fake.definitions).toHaveLength(3)
    fake.disposeAll()
    expect(fake.definitions).toHaveLength(0)
    expect(fake.slots).toHaveLength(0)
  })
})
