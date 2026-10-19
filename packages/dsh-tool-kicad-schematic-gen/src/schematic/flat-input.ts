/** Resolve the flat editor's model JSON into bounded, explicit operations. */
import { requiredString, validateKeys } from './input.ts'
import type { FlatEndpoint, FlatPlan, FlatPoint } from './flat.ts'

/** Read-only catalog or creation of a new edited project copy. */
export type FlatRequest = { action: 'list'; sourcePath: string; offset: number; limit: number; types: string[]; references: string[] }
  | { action: 'connections'; sourcePath: string; reference: string; pin: string; offset: number; limit: number }
  | { action: 'create'; sourcePath: string; targetDir: string; projectName: string; plan: FlatPlan }

function list(value: unknown, name: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1000) throw new Error(`${name} must be an array of at most 1000 entries`)
  return value as unknown[]
}
function text(value: unknown, field: string, max = 300): string { return requiredString({ [field]: value }, field, max) }
function point(value: unknown, field: string): FlatPoint {
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 2000)) {
    throw new Error(`${field} must be two finite coordinates in millimetres, each within +/-2000`)
  }
  return value as FlatPoint
}
function endpoint(value: unknown, field: string): FlatEndpoint {
  if (Array.isArray(value)) return point(value, field)
  const input = validateKeys(value, ['reference', 'pin'], field)
  return { reference: requiredString(input, 'reference'), pin: requiredString(input, 'pin') }
}
function uuid(value: unknown): string {
  const result = text(value, 'uuid', 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(result)) throw new Error('object UUID must use the canonical UUID format')
  return result
}

/** Validate a model request and resolve optional lists and catalog pagination.
 * @param args Model-supplied tool JSON.
 * @param listLimit Configured maximum number of objects per catalog response.
 * @returns A list or create request with all operation arrays present.
 */
export function parseFlatRequest(args: unknown, listLimit: number): FlatRequest {
  const input = validateKeys(args, ['action', 'sourcePath', 'offset', 'types', 'references', 'reference', 'pin', 'targetDir', 'projectName',
    'removeReferences', 'removeUuids', 'removeTextUuids', 'setValues', 'setLabels', 'addWires', 'frames'], 'edit_kicad_flat_schematic')
  const sourcePath = requiredString(input, 'sourcePath')
  if (input.action === 'connections') {
    validateKeys(input, ['action', 'sourcePath', 'reference', 'pin', 'offset'], 'flat connections')
    const offset = input.offset ?? 0
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    return {action: 'connections', sourcePath, reference: requiredString(input, 'reference'),
      pin: requiredString(input, 'pin'), offset, limit: listLimit}
  }
  if (input.action === 'list') {
    validateKeys(input, ['action', 'sourcePath', 'offset', 'types', 'references'], 'flat list')
    const offset = input.offset === undefined ? 0 : input.offset
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
    const types = list(input.types, 'types').map(item => text(item, 'type'))
    const supported = ['symbol', 'wire', 'junction', 'label', 'global_label', 'hierarchical_label', 'no_connect', 'text', 'text_box', 'rectangle', 'polyline', 'image']
    if (types.some(type => !supported.includes(type))) throw new Error(`types must use ${supported.join(', ')}`)
    const references = list(input.references, 'references').map(item => text(item, 'reference'))
    return { action: 'list', sourcePath, offset, limit: listLimit, types, references }
  }
  if (input.action !== 'create') throw new Error('action must be list, connections or create')
  if (input.references !== undefined || input.reference !== undefined || input.pin !== undefined) throw new Error('reference selectors apply only to list/connections')
  if (input.offset !== undefined || input.types !== undefined) throw new Error('offset and types apply only to list')
  const plan: FlatPlan = {
    removeReferences: list(input.removeReferences, 'removeReferences').map(item => text(item, 'reference')),
    removeUuids: list(input.removeUuids, 'removeUuids').map(uuid),
    removeTextUuids: list(input.removeTextUuids, 'removeTextUuids').map(uuid),
    setValues: list(input.setValues, 'setValues').map(item => {
      const change = validateKeys(item, ['reference', 'value'], 'setValues entry')
      return { reference: requiredString(change, 'reference'), value: requiredString(change, 'value') }
    }),
    setLabels: list(input.setLabels, 'setLabels').map(item => {
      const change = validateKeys(item, ['uuid', 'name', 'at', 'angle'], 'setLabels entry')
      if (change.name === undefined && change.at === undefined && change.angle === undefined) throw new Error('setLabels entry needs name, at, or angle')
      const angle = change.angle
      if (angle !== undefined && angle !== 0 && angle !== 90 && angle !== 180 && angle !== 270) throw new Error('label angle must be 0, 90, 180, or 270')
      return { uuid: uuid(change.uuid), ...(change.name === undefined ? {} : { name: requiredString(change, 'name') }),
        ...(change.at === undefined ? {} : { at: point(change.at, 'label.at') }), ...(angle === undefined ? {} : { angle }) }
    }),
    addWires: list(input.addWires, 'addWires').map(item => {
      const wire = validateKeys(item, ['from', 'to', 'via'], 'addWires entry')
      return { from: endpoint(wire.from, 'wire.from'), to: endpoint(wire.to, 'wire.to'),
        via: list(wire.via, 'wire.via').map(value => point(value, 'wire.via')) }
    }),
    frames: list(input.frames, 'frames').map(item => {
      const frame = validateKeys(item, ['name', 'description', 'start', 'end', 'autoBounds', 'objectUuids', 'excludeUuids'], 'frames entry')
      const title = { name: requiredString(frame, 'name'), description: requiredString(frame, 'description', 2000) }
      if (frame.autoBounds === true) {
        if (frame.start !== undefined || frame.end !== undefined) throw new Error('autoBounds frames must omit start/end')
        const objectUuids = frame.objectUuids === undefined ? undefined : list(frame.objectUuids, 'frame.objectUuids').map(uuid)
        if (objectUuids?.length === 0) throw new Error('frame.objectUuids must select at least one retained object')
        return { ...title, autoBounds: true as const, ...(objectUuids === undefined ? {} : { objectUuids }),
          excludeUuids: list(frame.excludeUuids, 'frame.excludeUuids').map(uuid) }
      }
      if (frame.autoBounds !== undefined && frame.autoBounds !== false) throw new Error('frame.autoBounds must be boolean')
      if (frame.objectUuids !== undefined || frame.excludeUuids !== undefined) throw new Error('frame object selectors require autoBounds: true')
      return { ...title, start: point(frame.start, 'frame.start'), end: point(frame.end, 'frame.end') }
    }),
  }
  return { action: 'create', sourcePath, targetDir: requiredString(input, 'targetDir'),
    projectName: requiredString(input, 'projectName'), plan }
}
