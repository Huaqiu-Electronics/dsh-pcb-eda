import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planPowerLabels, insideBounds, offsetBounds, type PowerLayoutArea, type PowerGeometry } from '../src/schematic/power-layout.ts'
import type { FlatObject } from '../src/schematic/flat.ts'
import type { PowerLabelEntry } from '../src/schematic/builder.ts'

const label = (uuid = 'current'): PowerLabelEntry => ({ uuid, net: 'GND', at: [50, 50], angle: 0, type: 'label', module: 'core' })
const geometry = (_net: string, angle: number): PowerGeometry => ({
  body: angle === 0 ? { left: -1, right: 1, top: 0, bottom: 3 }
    : angle === 180 ? { left: -1, right: 1, top: -3, bottom: 0 }
    : angle === 90 ? { left: 0, right: 3, top: -1, bottom: 1 } : { left: -3, right: 0, top: -1, bottom: 1 },
  textSize: [3, 1.3],
})
const box = (uuid: string, left: number, top: number, right: number, bottom: number): FlatObject =>
  ({ uuid, type: 'text', bounds: { left, top, right, bottom } })

test('clear layouts keep native direction; blocked lower body rotates at the original anchor', () => {
  const clear = planPowerLabels([label()], [], geometry, [297, 210], { maxMoveMm: 0 })
  assert.equal(clear.placements.current!.angle, 0)
  const rotated = planPowerLabels([label()], [box('capacitor', 48, 51, 52, 56)], geometry, [297, 210], { maxMoveMm: 0 })
  assert.notEqual(rotated.placements.current!.angle, 0)
  assert.deepEqual(rotated.placements.current!.at, [50, 50])
  assert.deepEqual(rotated.diagnostics.unresolved, [])
})

test('planning follows geometry across fresh UUIDs and keeps every selected net', () => {
  const obstacles = [box('capacitor', 48, 51, 52, 56)]
  const first = planPowerLabels([label('first')], obstacles, geometry, [297, 210], {})
  const second = planPowerLabels([label('second')], obstacles, geometry, [297, 210], {})
  assert.deepEqual(first.placements.first, second.placements.second)
  assert.equal(first.diagnostics.plannedCount, 1)
  assert.ok(first.diagnostics.candidateCount <= 144)
})

test('short movements never cross another wire; unresolved overlaps remain explicit', () => {
  const surround = box('crowded', 46, 46, 54, 54)
  const free = planPowerLabels([label()], [surround], geometry, [297, 210], {})
  // A text enclosure blocks a moved lead, so the planner does not jump through it.
  assert.equal(free.diagnostics.movedCount, 0)
  assert.equal(free.diagnostics.unresolved.length, 1)
  const wires: FlatObject[] = [
    { type: 'wire', uuid: 'above', from: [40, 48], to: [60, 48], bounds: { left: 40, top: 47.95, right: 60, bottom: 48.05 } },
    { type: 'wire', uuid: 'below', from: [40, 52], to: [60, 52], bounds: { left: 40, top: 51.95, right: 60, bottom: 52.05 } },
  ]
  const plan = planPowerLabels([label()], wires, geometry, [297, 210], {})
  const at = plan.placements.current!.at
  assert.ok(at[1] >= 48 && at[1] <= 52)
})

test('invalid limits reject early; measurement gaps are reported instead of claiming completeness', () => {
  assert.throws(() => planPowerLabels([label()], [], geometry, [297, 210], { maxMoveMm: 100 }), /maxMoveMm/)
  assert.throws(() => planPowerLabels([label()], [], geometry, [297, 210], { clearanceMm: -1 }), /clearanceMm/)
  const plan = planPowerLabels([label()], [{ type: 'image', uuid: 'unmeasured' }], geometry, [297, 210], {})
  assert.deepEqual(plan.diagnostics.unmeasuredObjectUuids, ['unmeasured'])
})

test('module content bounds prevent otherwise clean power symbols escaping into a title or adjacent module', () => {
  const area:PowerLayoutArea={name:'supply',bounds:{left:40,top:40,right:70,bottom:70},
    contentBounds:{left:42,top:49,right:68,bottom:61},objectUuids:['current']}
  const original={...label(),at:[50,60] as [number,number]}
  const plan=planPowerLabels([original],[],geometry,[297,210],{maxMoveMm:0},[area])
  const placement=plan.placements.current!, metrics=geometry('GND',placement.angle!)
  assert.equal(plan.diagnostics.stage,'automatic')
  assert.notEqual(placement.angle,0)
  assert.ok(insideBounds(offsetBounds(metrics.body,placement.at),area.contentBounds))
  const [x,y]=placement.valueAt!,[w,h]=metrics.textSize
  assert.ok(insideBounds({left:x-w/2,right:x+w/2,top:y-h/2,bottom:y+h/2},area.contentBounds))
  assert.deepEqual(plan.diagnostics.unresolved,[])
  assert.throws(()=>planPowerLabels([original],[],geometry,[297,210],{maxMoveMm:0},
    [{...area,contentBounds:{left:49,top:59,right:51,bottom:61}}]),/POWER_PLACEMENT_UNAVAILABLE.*supply.*Enlarge/)
  assert.throws(()=>planPowerLabels([original,{...original,uuid:'second',net:'+5V'}],[],geometry,[297,210],{maxMoveMm:0},
    [{...area,objectUuids:['current','second'],contentBounds:{left:49,top:59,right:51,bottom:61}}]),
    /POWER_PLACEMENT_UNAVAILABLE.*GND.*\+5V|POWER_PLACEMENT_UNAVAILABLE.*\+5V.*GND/)
})
