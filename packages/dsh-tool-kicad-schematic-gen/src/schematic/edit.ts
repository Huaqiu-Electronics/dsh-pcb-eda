/** Inspect and edit a downloaded module while preserving untouched KiCad forms. */
import { randomUUID, createHash } from 'node:crypto'
import { applyEdits, children, deleteForm, parse, quote, required, value, type Form, type TextEdit } from './sexpr.ts'

/** KiCad coordinate in millimetres. */
export type Point = [number, number]

/** One explicit branch deletion; wires and junctions are identified by inspected UUIDs. */
export interface DeleteSelection {
  references?: string[]
  wires?: string[]
  junctions?: string[]
  labels?: string[]
  noConnects?: string[]
  notes?: string[]
}

/** A model-approved, exact edit plan for one source sheet. */
export interface EditPlan {
  remove?: DeleteSelection
  moveLabels?: Array<{ uuid: string; at: Point; angle?: number }>
  addLabels?: Array<{ name: string; direction: 'input' | 'output' | 'bidirectional' | 'passive'; at: Point; angle: number }>
  addWires?: Array<{ from: Point; to: Point }>
  addJunctions?: Point[]
  replaceNotes?: Array<{ text: string; at: Point; size?: number }>
  addNotes?: Array<{ text: string; at: Point; size?: number }>
  pinTypes?: Array<{ reference: string; number: string; type: 'input' | 'output' | 'bidirectional' | 'passive' | 'power_in' | 'power_out' | 'unspecified' | 'no_connect' }>
}

/** Compact geometry and IDs needed to build an edit plan. */
export interface ModuleInspection {
  sha256: string
  references: Array<{ ref: string; libId: string; value: string | null; footprint: string | null;
    uuid: string; at: Point; pinDefinitionAvailable: boolean;
    pins: Array<{ unit: string; number: string; name: string; electricalType: string }> }>
  wires: Array<{ uuid: string; from: Point; to: Point }>
  junctions: Array<{ uuid: string; at: Point }>
  labels: Array<{ uuid: string; name: string; direction: string; at: Point; angle: number }>
  noConnects: Array<{ uuid: string; at: Point }>
  notes: Array<{ uuid: string; text: string; at: Point }>
}

function rootOf(text: string): Form {
  const root = parse(text)
  if (root.head !== 'kicad_sch') throw new Error('sourcePath is not a KiCad schematic')
  required(root, 'uuid')
  required(root, 'lib_symbols')
  return root
}

function point(form: Form): Point { return [Number(value(form, 1)), Number(value(form, 2))] }
function uuid(form: Form): string { return value(required(form, 'uuid')) }
function reference(form: Form): string {
  const property = children(form, 'property').find(item => value(item) === 'Reference')
  if (property === undefined) throw new Error('symbol instance has no Reference property')
  return value(property, 2)
}

function property(form: Form, name: string): string | undefined {
  const field = children(form, 'property').find(item => value(item) === name)
  return field === undefined ? undefined : value(field, 2)
}

/** Return all model-addressable forms and the exact content revision. */
export function inspectModule(text: string): ModuleInspection {
  const root = rootOf(text)
  const cache = new Map(children(required(root, 'lib_symbols'), 'symbol').map(form => [value(form), form]))
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    references: children(root, 'symbol').map(form => {
      const libId = value(required(form, 'lib_id'))
      const definition = cache.get(libId)
      return {
        ref: reference(form), libId, value: property(form, 'Value') ?? null,
        footprint: property(form, 'Footprint') ?? null,
        uuid: uuid(form), at: point(required(form, 'at')), pinDefinitionAvailable: definition !== undefined,
        pins: (definition === undefined ? [] : children(definition, 'symbol')).flatMap(unit => children(unit, 'pin').map(pin => ({
          unit: value(unit), number: value(required(pin, 'number')),
          name: value(required(pin, 'name')), electricalType: value(pin),
        }))),
      }
    }),
    wires: children(root, 'wire').map(form => {
      const ends = children(required(form, 'pts'), 'xy')
      if (ends.length !== 2) throw new Error('wire must contain exactly two endpoints')
      return { uuid: uuid(form), from: point(ends[0]!), to: point(ends[1]!) }
    }),
    junctions: children(root, 'junction').map(form => ({ uuid: uuid(form), at: point(required(form, 'at')) })),
    labels: children(root, 'hierarchical_label').map(form => ({
      uuid: uuid(form), name: value(form), direction: value(required(form, 'shape')),
      at: point(required(form, 'at')), angle: Number(value(required(form, 'at'), 3)),
    })),
    noConnects: children(root, 'no_connect').map(form => ({ uuid: uuid(form), at: point(required(form, 'at')) })),
    notes: [...children(root, 'text'), ...children(root, 'text_box')].map(form => ({
      uuid: uuid(form), text: value(form), at: point(required(form, 'at')),
    })),
  }
}

function removeByUuid(source: string, root: Form, head: string, ids: string[], edits: TextEdit[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ${head} UUID in edit plan`)
  const available = new Map(children(root, head).map(form => [uuid(form), form]))
  for (const id of ids) {
    const form = available.get(id)
    if (form === undefined) throw new Error(`${head} UUID not found: ${id}`)
    edits.push(deleteForm(source, form))
  }
}

function wire(from: Point, to: Point): string {
  return `(wire (pts (xy ${from[0]} ${from[1]}) (xy ${to[0]} ${to[1]})) (stroke (width 0) (type default)) (uuid "${randomUUID()}"))`
}

function junction(at: Point): string {
  return `(junction (at ${at[0]} ${at[1]}) (diameter 0) (color 0 0 0 0) (uuid "${randomUUID()}"))`
}

function label(name: string, direction: string, at: Point, angle: number): string {
  const justify = angle === 180 ? 'right' : 'left'
  return `(hierarchical_label ${quote(name)} (shape ${direction}) (at ${at[0]} ${at[1]} ${angle}) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid "${randomUUID()}"))`
}

function note(text: string, at: Point, size: number): string {
  return `(text ${quote(text)} (exclude_from_sim no) (at ${at[0]} ${at[1]} 0) (effects (font (size ${size} ${size})) (justify left)) (uuid "${randomUUID()}"))`
}

/** Produce an edited sheet in memory; unknown IDs and stale plans fail before any file write. */
export function editModule(source: string, expectedSha256: string, plan: EditPlan): { text: string; removedNotes: number } {
  const inspection = inspectModule(source)
  if (inspection.sha256 !== expectedSha256) throw new Error('source schematic changed after inspection; inspect it again')
  const root = rootOf(source)
  const edits: TextEdit[] = []
  const selection = plan.remove ?? {}
  const refs = selection.references ?? []
  if (new Set(refs).size !== refs.length) throw new Error('duplicate component reference in edit plan')
  const availableRefs = new Map(children(root, 'symbol').map(form => [reference(form), form]))
  if (availableRefs.size !== children(root, 'symbol').length) throw new Error('source contains duplicate component references')
  for (const ref of refs) {
    const form = availableRefs.get(ref)
    if (form === undefined) throw new Error(`component reference not found: ${ref}`)
    edits.push(deleteForm(source, form))
  }

  const cache = new Map(children(required(root, 'lib_symbols'), 'symbol').map(form => [value(form), form]))
  const changedPins = new Set<string>()
  for (const change of plan.pinTypes ?? []) {
    const instance = availableRefs.get(change.reference)
    if (instance === undefined || refs.includes(change.reference)) {
      throw new Error(`pinTypes reference is not retained: ${change.reference}`)
    }
    const libId = value(required(instance, 'lib_id'))
    const key = `${libId}:${change.number}`
    if (changedPins.has(key)) throw new Error(`duplicate pin type edit: ${key}`)
    changedPins.add(key)
    const definition = cache.get(libId)
    if (definition === undefined) throw new Error(`symbol cache lacks ${libId}`)
    const pins = children(definition, 'symbol').flatMap(unit => children(unit, 'pin'))
      .filter(pin => value(required(pin, 'number')) === change.number)
    if (pins.length !== 1) throw new Error(`expected one pin ${change.number} in ${libId}, found ${pins.length}`)
    const pin = pins[0]!
    const raw = source.slice(pin.start, pin.end)
    const match = /^\(pin\s+[^\s()]+/u.exec(raw)
    if (match === null) throw new Error(`cannot edit pin ${key}`)
    edits.push({ start: pin.start, end: pin.start + match[0].length, text: `(pin ${change.type}` })
  }
  removeByUuid(source, root, 'wire', selection.wires ?? [], edits)
  removeByUuid(source, root, 'junction', selection.junctions ?? [], edits)
  removeByUuid(source, root, 'hierarchical_label', selection.labels ?? [], edits)
  removeByUuid(source, root, 'no_connect', selection.noConnects ?? [], edits)

  const labels = new Map(children(root, 'hierarchical_label').map(form => [uuid(form), form]))
  for (const move of plan.moveLabels ?? []) {
    const form = labels.get(move.uuid)
    if (form === undefined || selection.labels?.includes(move.uuid)) throw new Error(`label UUID not available: ${move.uuid}`)
    const old = required(form, 'at')
    const angle = move.angle ?? Number(value(old, 3))
    edits.push({ start: old.start, end: old.end, text: `(at ${move.at[0]} ${move.at[1]} ${angle})` })
  }

  const originalNotes = [...children(root, 'text'), ...children(root, 'text_box')]
  const noteIds = selection.notes ?? []
  if (new Set(noteIds).size !== noteIds.length) throw new Error('duplicate note UUID in edit plan')
  if (plan.replaceNotes !== undefined && noteIds.length > 0) {
    throw new Error('remove.notes and replaceNotes cannot be combined')
  }
  const availableNotes = new Map(originalNotes.map(form => [uuid(form), form]))
  for (const id of noteIds) {
    const form = availableNotes.get(id)
    if (form === undefined) throw new Error(`note UUID not found: ${id}`)
    edits.push(deleteForm(source, form))
  }
  if (plan.replaceNotes !== undefined) {
    for (const form of originalNotes) edits.push(deleteForm(source, form))
  }
  const additions = [
    ...(plan.addWires ?? []).map(item => wire(item.from, item.to)),
    ...(plan.addJunctions ?? []).map(junction),
    ...(plan.addLabels ?? []).map(item => label(item.name, item.direction, item.at, item.angle)),
    ...(plan.replaceNotes ?? []).map(item => note(item.text, item.at, item.size ?? 1.27)),
    ...(plan.addNotes ?? []).map(item => note(item.text, item.at, item.size ?? 1.27)),
  ]
  if (additions.length > 0) edits.push({ start: root.end - 1, end: root.end - 1, text: `\n\t${additions.join('\n\t')}\n` })
  const text = applyEdits(source, edits)
  rootOf(text)
  return { text, removedNotes: plan.replaceNotes === undefined ? noteIds.length : originalNotes.length }
}
