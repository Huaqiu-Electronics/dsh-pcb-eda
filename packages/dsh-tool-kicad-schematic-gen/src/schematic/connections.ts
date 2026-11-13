/** Read visible single-sheet wire connections; never infer label aliases or hidden power nets. */
import type {FlatObject, FlatPoint} from './flat.ts'
import {SCHEMATIC_GRID_MM} from './grid.ts'

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

function wiresJoin(a: FlatObject, b: FlatObject, junctions: FlatPoint[]): boolean {
  return onWire(a.from!, b) || onWire(a.to!, b) || onWire(b.from!, a) || onWire(b.to!, a)
    || junctions.some(at => onWire(at, a) && onWire(at, b))
}

interface NoConnectPin { reference:string; pin:string }

/** Native NC and explicitly unused pins share one sheet marker per real endpoint. */
export function inspectNoConnectPins(objects: FlatObject[], declared: readonly NoConnectPin[] = []) {
  const key=({reference,pin}:NoConnectPin)=>JSON.stringify([reference,pin])
  const required=new Set(declared.map(key))
  const pins=objects.flatMap(o=>o.reference?(o.pins??[]).map(p=>({
    reference:o.reference!,pin:p.number,at:p.at,native:p.electricalType==='no_connect',
  })):[])
  const wires=objects.filter(o=>o.type==='wire'&&o.from&&o.to)
  const labels=objects.filter(o=>o.at&&['label','global_label','hierarchical_label'].includes(o.type))
  const markers=objects.filter(o=>o.type==='no_connect'&&o.at)
  const issues:Array<NoConnectPin&{code:string;message:string}>=[]
  for(const p of declared)if(!pins.some(candidate=>key(candidate)===key(p)))
    issues.push({...p,code:'MODULE_NO_CONNECT_PIN_MISSING',message:'The declared unused pin is absent from the schematic.'})
  const seen=new Set<string>()
  const targets=pins.filter(p=>{
    const id=JSON.stringify([p.reference,p.pin,p.at])
    if(seen.has(id)||(!p.native&&!required.has(key(p))))return false
    seen.add(id)
    return true
  }).map(p=>{
    const stacked=pins.some(other=>same(other.at,p.at)
      &&((other.native!==p.native)||(!other.native&&!required.has(key(other)))))
    if(wires.some(wire=>onWire(p.at,wire))||labels.some(label=>same(label.at!,p.at)))
      issues.push({reference:p.reference,pin:p.pin,code:'MODULE_NO_CONNECT_WIRED',message:'A no-connect pin touches a wire or net label.'})
    else if(stacked)
      issues.push({reference:p.reference,pin:p.pin,code:'MODULE_NO_CONNECT_SHARED_POINT',message:'This endpoint also belongs to an active pin or a pin of a different NC type.'})
    return {...p,marker:markers.find(marker=>same(marker.at!,p.at))?.uuid}
  })
  return {targets,issues}
}

/** Remove power annotations only where the surviving annotation reaches the same physical wires. */
export function redundantPowerAnnotations(objects: FlatObject[], owned: ReadonlySet<string>, nets: ReadonlySet<string>): string[] {
  const wires = objects.filter(o => o.type === 'wire' && o.from && o.to)
  const moduleWires = wires.filter(o => owned.has(o.uuid))
  const junctions = objects.flatMap(o => o.type === 'junction' && o.at ? [o.at] : [])
  const pending = new Set(moduleWires)
  const componentByWire = new Map<FlatObject, FlatObject[]>()
  for (const first of pending) {
    const component = [first]
    pending.delete(first)
    for (const wire of component) {
      componentByWire.set(wire, component)
      for (const next of pending) if (wiresJoin(wire, next, junctions)) {
        component.push(next)
        pending.delete(next)
      }
    }
  }
  const groups = new Map<FlatObject[], Map<string, FlatObject[]>>()
  for (const label of objects) {
    if (!owned.has(label.uuid) || !label.at || !nets.has(label.name ?? '')
      || !['label','global_label'].includes(label.type)) continue
    const attached = wires.filter(w => onWire(label.at!, w))
    const component = attached.length ? componentByWire.get(attached[0]!) : undefined
    // Leave unjoined crossings, unattached labels and cross-module wiring intact.
    if (!component || attached.some(w => componentByWire.get(w) !== component)) continue
    const byNet = groups.get(component) ?? new Map<string, FlatObject[]>()
    groups.set(component, byNet)
    const labels = byNet.get(label.name!) ?? []
    labels.push(label)
    byNet.set(label.name!, labels)
  }
  const removed = new Set<string>()
  for (const [component, byNet] of groups) {
    for (const labels of byNet.values()) {
      // Keep the first authored anchor; only remove the tail of a dedicated label stub
      // when every other electrical attachment lies at its surviving end.
      const [keep, ...duplicates] = labels
      for (const label of duplicates) {
        const at = label.at!
        const touching = component.filter(w => onWire(at, w))
        const leaf = touching.length === 1 && touching[0]
        if (leaf && !same(at, keep!.at!) && (same(at, leaf.from!) || same(at, leaf.to!))) {
          const base = same(at, leaf.from!) ? leaf.to! : leaf.from!
          const onTail = (p: FlatPoint) => onWire(p, leaf) && !same(p, base)
          const hasAttachment = objects.some(o => o !== label && !removed.has(o.uuid)
            && (o.pins?.some(pin => onTail(pin.at))
              || (['label','global_label','hierarchical_label','junction','no_connect'].includes(o.type) && o.at && onTail(o.at))))
          const hasBranch = wires.some(w => w !== leaf && !removed.has(w.uuid)
            && (onTail(w.from!) || onTail(w.to!) || onWire(at, w)))
          const shortStub=Math.hypot(at[0]-base[0],at[1]-base[1])<=6*SCHEMATIC_GRID_MM+epsilon
          if (shortStub && !hasAttachment && !hasBranch && component.some(w => w !== leaf && !removed.has(w.uuid) && onWire(base, w))) {
            removed.add(leaf.uuid)
          }
        }
        removed.add(label.uuid)
      }
    }
  }
  return [...removed]
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
  const junctions = objects.flatMap(o => o.type === 'junction' && o.at ? [o.at] : [])
  const selected = new Set<FlatObject>()
  const pending = wires.filter(w => onWire(target.pin.at, w))
  for (const wire of pending) selected.add(wire)
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!
    for (const other of wires) {
      if (selected.has(other)) continue
      const joins = wiresJoin(current, other, junctions)
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
    limitations: ['Does not follow same-name labels, implicit power nets, other sheets or component bodies. This is a local connectivity trace.',
      'Interior wire crossings connect only at explicit junctions; wire endpoints on segments connect.'],
    diagnostics: objects.filter(o => o.pinError).map(o => ({reference: o.reference, uuid: o.uuid, pinError: o.pinError})),
    objects: connected,
  }
}
