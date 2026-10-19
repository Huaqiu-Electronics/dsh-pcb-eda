/** Translate and isolate one existing single-sheet circuit for a shared builder. */
import { randomUUID } from 'node:crypto'
import { children, parse, required, value, quote, type Form } from './sexpr.ts'
import { alignVendorSymbolIds } from './project.ts'
import type { FlatPoint } from './flat.ts'
import { validatePreviewSchematic } from './preview-diagnostics.ts'

/** Explicit module placement and shared network names; other named nets remain private. */
export interface FlatImportSpec {
  name: string
  offset: FlatPoint
  nets: Record<string, string>
}
/** Imported object identities, renamed references and source-label anchors on the final sheet. */
export interface FlatImportResult {
  references: Record<string, string>
  ports: Record<string, FlatPoint[]>
  netNames: Record<string, string>
  objectUuids: string[]
}
/** Prepared objects committed together after input validation succeeds. */
export interface PreparedFlatImport {
  definitions: Array<[string, string]>
  instances: Array<{ text: string; reference: string; unit: string; libId: string }>
  graphics: string[]
  result: FlatImportResult
}

/** Prepare a copied module with explicit translation, isolated caches and network names.
 * @param source Single-sheet KiCad text with embedded definitions.
 * @param spec Unique ASCII module name, translation and source-to-shared net mapping.
 * @param projectName Destination project name.
 * @param rootId Destination root UUID.
 * @param usedReferences References already reserved in the destination.
 * @returns Complete import without mutating the source or destination. Unsupported objects fail.
 */
export function prepareFlatImport(source: string, spec: FlatImportSpec, projectName: string,
  rootId: string, usedReferences: Set<string>): PreparedFlatImport {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(spec.name)) throw new Error('import module name must be an ASCII identifier')
  if (spec.offset.length !== 2 || spec.offset.some(n => !Number.isFinite(n))) throw new Error(`${spec.name}: offset needs two finite millimetre coordinates`)
  source = alignVendorSymbolIds(source)
  const root = validatePreviewSchematic(source, spec.name)
  if (children(root, 'sheet').length) throw new Error(`${spec.name}: import accepts single-sheet sources only; prepare individual child circuits first`)
  const metadata = new Set(['version', 'generator', 'generator_version', 'uuid', 'paper', 'title_block', 'lib_symbols', 'sheet_instances', 'symbol_instances', 'embedded_fonts'])
  const supported = new Set(['symbol', 'wire', 'junction', 'no_connect', 'label', 'global_label', 'hierarchical_label', 'text', 'text_box', 'rectangle', 'polyline', 'arc', 'circle', 'image'])
  const forms = root.items.filter((i): i is Form => typeof i !== 'string' && !metadata.has(i.head))
  for (const form of forms) if (!supported.has(form.head)) throw new Error(`${spec.name}: unsupported imported object ${form.head}; retain the source and use a supported circuit copy`)
  const cache = children(required(root, 'lib_symbols'), 'symbol')
  const byId = new Map(cache.map(f => [value(f), f]))
  if (byId.size !== cache.length) throw new Error(`${spec.name}: duplicate source symbol definitions`)
  const refMap = new Map<string, string>(), cacheIds = new Map<string, string>(), netMap = new Map<string, string>()
  const ports: Record<string, FlatPoint[]> = Object.create(null) as Record<string, FlatPoint[]>
  const reserved = new Set(usedReferences), instanceKeys = new Set<string>()
  const net = (name: string): string => {
    if (!netMap.has(name)) netMap.set(name, Object.hasOwn(spec.nets, name) ? spec.nets[name]! : `${spec.name}__${name}`)
    const mapped = netMap.get(name)!
    if (!mapped.trim()) throw new Error(`${spec.name}: net ${name} maps to an empty name`)
    return mapped
  }
  const property = (form: Form, name: string): Form => {
    const matches = children(form, 'property').filter(f => value(f) === name)
    if (matches.length !== 1) throw new Error(`${spec.name}: symbol needs one ${name} property`)
    return matches[0]!
  }
  for (const symbol of forms.filter(f => f.head === 'symbol')) {
    const old = value(property(symbol, 'Reference'), 2), id = value(required(symbol, 'lib_id'))
    if (!byId.has(id)) throw new Error(`${spec.name}: symbol cache lacks ${id}`)
    if (!refMap.has(old)) {
      const prefix = /^([A-Za-z#][A-Za-z_]*)(\d+|\?)$/u.exec(old)?.[1]
      if (!prefix) throw new Error(`${spec.name}: unsupported source reference ${old}`)
      let number = 1
      while (reserved.has(`${prefix}${number}`)) number++
      const next = `${prefix}${number}`; reserved.add(next); refMap.set(old, next)
    }
    const unit = value(required(symbol, 'unit')), key = `${old}:${unit}`
    if (instanceKeys.has(key) || !/^[1-9][0-9]*$/u.test(unit)) throw new Error(`${spec.name}: duplicate or invalid unit ${key}`)
    instanceKeys.add(key)
    const previous = cacheIds.get(id)
    if (!previous) cacheIds.set(id, `Imported_${spec.name}:${id.slice(id.indexOf(':') + 1)}`)
  }
  const uuids = new Map<string, string>()
  const nextUuid = (old: string): string => {
    if (!uuids.has(old)) uuids.set(old, randomUUID())
    return uuids.get(old)!
  }
  const emit = (form: Form, mode: 'object' | 'cache', power = false): string => {
    const items = [...form.items]
    if (mode === 'object' && ['at', 'xy', 'start', 'end', 'center'].includes(form.head)) {
      for (const index of [1, 2]) {
        const n = Number(value(form, index))
        if (!Number.isFinite(n)) throw new Error(`${spec.name}: invalid ${form.head} coordinate`)
        items[index] = String(Number((n + spec.offset[index - 1]!).toFixed(6)))
      }
    }
    if (form.head === 'uuid') items[1] = quote(nextUuid(value(form)))
    if (mode === 'cache' && form.head === 'symbol') {
      const original = value(form)
      items[1] = quote(cacheIds.get(original) ?? original)
    }
    if (mode === 'object' && form.head === 'lib_id') items[1] = quote(cacheIds.get(value(form))!)
    if (mode === 'object' && form.head === 'property' && value(form) === 'Reference') items[2] = quote(refMap.get(value(form, 2))!)
    if (mode === 'object' && power && form.head === 'property' && value(form) === 'Value') items[2] = quote(net(value(form, 2)))
    if (mode === 'object' && ['label', 'global_label', 'hierarchical_label'].includes(form.head)) {
      const name = value(form), at = required(form, 'at')
      const anchor: FlatPoint = [Number((Number(value(at, 1)) + spec.offset[0]).toFixed(6)), Number((Number(value(at, 2)) + spec.offset[1]).toFixed(6))]
      ;(ports[name] ??= []).push(anchor)
      items[1] = quote(net(name))
      if (form.head === 'hierarchical_label') {
        items[0] = 'label'
        return `(${items.filter(i => typeof i === 'string' || i.head !== 'shape').map(i => typeof i === 'string' ? i : emit(i, mode, power)).join(' ')})`
      }
    }
    if (mode === 'cache' && form.head === 'pin') {
      const electrical = value(form)
      const hidden = form.items.includes('hide') || children(form, 'hide').some(f => f.items.length === 1 || value(f) === 'yes')
      if (power || (hidden && ['power_in', 'power_out'].includes(electrical))) {
        return `(${items.map(i => typeof i === 'string' ? i : i.head === 'name'
          ? `(${[i.items[0], quote(net(value(i))), ...i.items.slice(2).map(j => typeof j === 'string' ? j : emit(j, mode, power))].join(' ')})`
          : emit(i, mode, power)).join(' ')})`
      }
    }
    return `(${items.map(i => typeof i === 'string' ? i : emit(i, mode, power)).join(' ')})`
  }
  const definitions: Array<[string, string]> = []
  for (const [old, id] of cacheIds) {
    const definition = byId.get(old)!
    if (children(definition, 'extends').length) throw new Error(`${spec.name}: source cache ${old} must have expanded inheritance`)
    const power = children(definition, 'power').length > 0
    const renamed = emit(definition, 'cache', power)
    // KiCad selects units by the cached symbol's local name plus _unit_style.
    const parsed = parse(renamed), localName = id.slice(id.indexOf(':') + 1)
    const text = `(${parsed.items.map(i => typeof i === 'string' ? i : i.head === 'symbol'
      ? `(symbol ${quote(`${localName}${/(_\d+_\d+)$/u.exec(value(i))?.[1] ?? ''}`)} ${i.items.slice(2).map(j => typeof j === 'string' ? j : renamed.slice(j.start, j.end)).join(' ')})`
      : renamed.slice(i.start, i.end)).join(' ')})`
    definitions.push([id, text])
  }
  const instances: PreparedFlatImport['instances'] = [], graphics: string[] = [], objectUuids: string[] = []
  for (const form of forms) {
    if (form.head !== 'symbol') {
      graphics.push(emit(form, 'object'))
    } else {
      const old = value(property(form, 'Reference'), 2), reference = refMap.get(old)!, unit = value(required(form, 'unit'))
      const oldId = value(required(form, 'lib_id')), libId = cacheIds.get(oldId)!
      const power = children(byId.get(oldId)!, 'power').length > 0
      const body = form.items.filter(i => typeof i === 'string' || !['instances', 'lib_name'].includes(i.head))
        .map(i => typeof i === 'string' ? i : emit(i, 'object', power)).join(' ')
      const text = `(${body} (instances (project ${quote(projectName)} (path ${quote(`/${rootId}`)} (reference ${quote(reference)}) (unit ${unit})))) )`
      instances.push({ text, reference, unit, libId })
    }
    objectUuids.push(nextUuid(value(required(form, 'uuid'))))
  }
  for (const key of Object.keys(spec.nets)) if (!netMap.has(key)) throw new Error(`${spec.name}: mapped source network not found: ${key}`)
  for (const old of refMap.keys()) {
    const ids = forms.filter(f => f.head === 'symbol' && value(property(f, 'Reference'), 2) === old).map(f => value(required(f, 'lib_id')))
    if (new Set(ids).size > 1) throw new Error(`${spec.name}: ${old} uses different symbols across units`)
  }
  return { definitions, instances, graphics, result: { references: Object.fromEntries(refMap), ports,
    netNames: Object.fromEntries(netMap), objectUuids } }
}
