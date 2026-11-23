import { describe, expect, it } from 'vitest'
import { apply, HARDWARE_TAB_ID, HARDWARE_TAB_KIND } from '../src/client/index.js'
import { createHardwareStore } from '../src/client/store.js'

interface Registration {
  readonly name: string
  readonly key?: string
  readonly id?: string
}

function fakeContext(): { registrations: Registration[]; tabTypes: unknown[]; context: Parameters<typeof apply>[0] } {
  const registrations: Registration[] = []
  const tabTypes: unknown[] = []
  const context = {
    slots: {
      inject: (_key: string, callback: () => () => void) => callback(),
      register: (spec: Registration) => {
        registrations.push(spec)
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition: unknown) => {
        tabTypes.push(definition)
        return () => {}
      },
    },
    effect: (fn: () => (() => void) | void) => { fn() },
  }
  return { registrations, tabTypes, context }
}

describe('client slot registrations', () => {
  it('uses only supported DSH seats and one keep-mounted tab type', () => {
    const { registrations, tabTypes, context } = fakeContext()
    apply(context)
    expect(registrations.map(entry => entry.name)).toEqual([
      'conversation.header.leading',
      'sidebar.right.pane.tab',
      'conversation.session.header.corner',
      'settings.section',
    ])
    expect(registrations[1]?.key).toBe(HARDWARE_TAB_ID)
    expect(tabTypes).toEqual([{
      id: HARDWARE_TAB_ID,
      kind: HARDWARE_TAB_KIND,
      keepMounted: true,
      title: expect.any(Function),
    }])
  })
})

describe('product store', () => {
  it('keeps canonical artifact paths and bumps revision on selection', () => {
    const store = createHardwareStore()
    const first = store.create()
    expect(first.getSnapshot().activeDestination).toBe('schematic')
    first.actions.setActive('pcb')
    first.actions.selectArtifact('/tmp/power.kicad_pcb', 'pcb')
    expect(first.getSnapshot()).toMatchObject({
      activeDestination: 'pcb',
      pcbPath: '/tmp/power.kicad_pcb',
      revision: 2,
    })
    let notified = 0
    const off = first.subscribe(() => { notified += 1 })
    first.actions.setActive('bom')
    off()
    first.actions.setActive('3d')
    expect(notified).toBe(1)
  })
})
