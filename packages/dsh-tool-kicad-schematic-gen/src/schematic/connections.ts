/** Read visible single-sheet wire connections; never infer label aliases or hidden power nets. */
import type {FlatObject, FlatPoint} from './flat.ts'

const epsilon = 1e-6
function same(a: FlatPoint, b: FlatPoint): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon
}
function onWire(p: FlatPoint, wire: FlatObject): boolean {
  const a = wire.from!, b = wire.to!
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (length <= epsilon) return same(p, a)
  const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
  return Math.abs(cross) / length <= epsilon
    && p[0] >= Math.min(a[0], b[0]) - epsilon && p[0] <= Math.max(a[0], b[0]) + epsilon
    && p[1] >= Math.min(a[1], b[1]) - epsilon && p[1] <= Math.max(a[1], b[1]) + epsilon
}

/** Trace a physical wire component from exactly one placed pin, stopping at component bodies.
 * Wire ends on a segment join it; interior crossings require an explicit junction.
 * Returned symbols contain only pins touching this component, not every pin on the device.
 */
export function inspectPinConnections(objects: FlatObject[], reference: string, number: string) {
  const instances = objects.filter(o => o.type === 'symbol' && o.reference === reference)
  if (!instances.length) throw new Error(`reference not found: ${reference}`)
  const candidates = instances.flatMap(o => (o.pins ?? []).filter(p => p.number === number).map(pin => ({object: o, pin})))
  if (instances.some(o => o.pinError)) throw new Error(`cannot resolve all pins for ${reference}; inspect pinError in list`)
  if (candidates.length !== 1) throw new Error(`expected one placed pin ${reference}.${number}, found ${candidates.length}; inspect units before connecting`)
  const target = candidates[0]!
  const wires = objects.filter(o => o.type === 'wire')
  const junctions = objects.filter(o => o.type === 'junction' && o.at)
  const selected = new Set<FlatObject>()
  const pending = wires.filter(w => onWire(target.pin.at, w))
  for (const wire of pending) selected.add(wire)
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!
    for (const other of wires) {
      if (selected.has(other)) continue
      const joins = onWire(current.from!, other) || onWire(current.to!, other)
        || onWire(other.from!, current) || onWire(other.to!, current)
        || junctions.some(j => onWire(j.at!, current) && onWire(j.at!, other))
      if (joins) { selected.add(other); pending.push(other) }
    }
  }
  const touches = (at: FlatPoint) => same(at, target.pin.at) || pending.some(w => onWire(at, w))
  const connected = objects.flatMap((o): FlatObject[] => {
    if (o.type === 'wire') return selected.has(o) ? [o] : []
    if (o.type === 'symbol') {
      const pins = o.pins?.filter(p => touches(p.at)) ?? []
      return pins.length ? [{...o, pins}] : []
    }
    return ['label', 'global_label', 'hierarchical_label', 'junction', 'no_connect'].includes(o.type)
      && o.at && touches(o.at) ? [o] : []
  })
  return {
    scope: 'visible_wire_component_on_this_sheet',
    target: {reference, pin: number, name: target.pin.name, at: target.pin.at,
      symbolUuid: target.object.uuid, unit: target.object.unit, endpoint: {reference, pin: number}},
    netNames: [...new Set(connected.filter(o => ['label', 'global_label', 'hierarchical_label'].includes(o.type)).map(o => o.name!))],
    limitations: ['Does not follow same-name labels, implicit power nets, other sheets or component bodies. Not ERC or a complete netlist.',
      'Interior wire crossings connect only at explicit junctions; wire endpoints on segments connect.'],
    diagnostics: objects.filter(o => o.pinError).map(o => ({reference: o.reference, uuid: o.uuid, pinError: o.pinError})),
    objects: connected,
  }
}
