/** Script API for model-planned single-sheet circuits; no automatic topology or routing. */
import { randomUUID,createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { children, parse, value, quote, applyEdits, type Form } from './sexpr.ts'
import { buildFlatCopy, listFlatObjects, loadFlatTemplates, type FlatPoint, type FlatEndpoint, type FlatFrame, type ResolvedFlatFrame } from './flat.ts'
import { prepareFlatImport, type FlatImportSpec, type FlatImportResult } from './import-flat.ts'
import { flatTextSize } from './flat-layout.ts'
import { normalizeCommonUnits } from './symbol-units.ts'
import { planPowerLabels, type PowerPlanningOptions, type PowerPlacementPlan, type PowerGeometry } from './power-layout.ts'
import {assignFootprintText} from './footprint-links.ts'
export type { PowerPlanningOptions, PowerPlacementPlan } from './power-layout.ts'

/** Explicit instance placement in millimetres; library files must be trusted project inputs. */
export interface SymbolPlacement {
  libraryPath: string; libId: string; reference: string; at: FlatPoint
  value?: string; angle?: 0 | 90 | 180 | 270; mirror?: 'x' | 'y'; unit?: number; footprint?: string
  referenceAt?: FlatPoint; valueAt?: FlatPoint; fieldAngle?: number
  hideReference?: boolean; hideValue?: boolean
}
/** Explicit deployment templates and page choice; no implicit file discovery. */
export interface SchematicOptions {
  projectName: string; templateDir: string; paper: 'A4' | 'A3' | 'A2' | 'A1' | 'A0'; title: string
  /** Explicit shared power nets required before render/save; never inferred from names. */
  requiredPowerSymbols?: Record<string, string>
}

/** Planned module rectangle; origin and size use sheet millimetres. */
export interface ModuleRegionSpec { name: string; description: string; origin: FlatPoint; size: FlatPoint }

/** Explicit shared-net conversion; library Value must equal each selected network name. */
export interface PowerLabelSpec {
  libraryPath: string; nets: Record<string, string>
  placements?: Record<string, { at: FlatPoint; via?: FlatPoint[]; angle?: 0 | 90 | 180 | 270; valueAt?: FlatPoint }>
}
/** Conservative power-symbol overlap hint; not an electrical check. */
export interface PowerLayoutWarning { code: 'POWER_LAYOUT_OVERLAP'; uuid: string; reference: string; otherUuid: string; otherType: string }
/** Converted label identity and final symbol pin position; explicit movement adds connected wire segments. */
export interface PowerLabelReplacement { uuid: string; reference: string; net: string; libId: string; at: FlatPoint }
/** Current-build label identity and sheet coordinates; module identifies imported provenance. */
export interface PowerLabelEntry {
  uuid: string; net: string; at: FlatPoint; angle: number; type: 'label' | 'global_label'; module?: string
}
/** Structural completion check, not connectivity or layout verification. */
export interface PowerSymbolStatus {
  net: string; libId: string; symbolCount: number; remainingLabelUuids: string[]
}

/** Region-local script operations; changing its origin in the script moves the regenerated group. */
export class ModuleRegion {
  /** Keep one planned origin for symbols, properties, wire bends and annotations.
   * @param schematic Owning sheet. @param origin Planned top-left sheet coordinate.
   */
  constructor(private readonly schematic: Schematic, private readonly origin: FlatPoint) {}
  /** Convert a region-relative coordinate to sheet coordinates.
   * @param local Millimetres from the region's top-left. @returns Sheet coordinate.
   */
  at(local: FlatPoint): FlatPoint { const p = point(local); return [this.origin[0] + p[0], this.origin[1] + p[1]] }
  /** Place an instance with region-relative position and explicit property anchors.
   * @param spec Actual symbol and local placement. @returns Instance UUID.
   */
  addSymbol(spec: SymbolPlacement): string {
    return this.schematic.addSymbol({ ...spec, at: this.at(spec.at),
      ...(spec.referenceAt ? { referenceAt: this.at(spec.referenceAt) } : {}),
      ...(spec.valueAt ? { valueAt: this.at(spec.valueAt) } : {}) })
  }
  /** Resolve a placed pin as a region-relative coordinate.
   * @param reference Placed instance. @param number Actual pin number. @returns Local coordinate.
   */
  pin(reference: string, number: string): FlatPoint {
    const p = this.schematic.pin(reference, number); return [p[0] - this.origin[0], p[1] - this.origin[1]]
  }
  private endpoint(input: FlatEndpoint): FlatEndpoint { return Array.isArray(input) ? this.at(input) : input }
  /** Route local points or named pins through local explicit bends.
   * @param from Local point or pin. @param to Local point or pin. @param via Local bends.
   * @returns Segment UUIDs.
   */
  wire(from: FlatEndpoint, to: FlatEndpoint, via: FlatPoint[] = []): string[] {
    return this.schematic.wire(this.endpoint(from), this.endpoint(to), via.map(p => this.at(p)))
  }
  /** Add a local network label.
   * @param name Network name. @param at Local point or pin. @param angle Orthogonal angle. @returns UUID.
   */
  label(name: string, at: FlatEndpoint, angle: 0 | 90 | 180 | 270 = 0): string {
    return this.schematic.label(name, this.endpoint(at), angle)
  }
  /** Mark an explicit branch or intentionally unused pin.
   * @param kind Marker kind. @param at Local point or pin. @returns UUID.
   */
  marker(kind: 'junction' | 'no_connect', at: FlatEndpoint): string { return this.schematic.marker(kind, this.endpoint(at)) }
  /** Add an explicitly connected child-sheet port at a local point or actual pin.
   * @param name Port name. @param at Local point or actual pin. @param angle Text rotation.
   * @returns Label UUID.
   */
  hierarchicalLabel(name: string, at: FlatEndpoint, angle: 0 | 90 | 180 | 270 = 0): string {
    return this.schematic.hierarchicalLabel(name, this.endpoint(at), angle)
  }
}

function point(at: FlatPoint): FlatPoint {
  if (at.length !== 2 || at.some(n => !Number.isFinite(n))) throw new Error('coordinates require two finite millimetre values')
  return at
}
function definition(source: string, name: string, chain: string[] = []): string {
  const root = parse(source)
  if (root.head !== 'kicad_symbol_lib') throw new Error('libraryPath must contain a kicad_symbol_lib')
  const matches = children(root, 'symbol').filter(f => value(f) === name)
  if (matches.length !== 1) throw new Error(`symbol ${name}: expected one library definition, found ${matches.length}`)
  if (chain.includes(name)) throw new Error(`symbol inheritance cycle: ${[...chain, name].join(' -> ')}`)
  const f = matches[0]!, parent = children(f, 'extends')[0]
  if (!parent) return source.slice(f.start, f.end)
  const base = definition(source, value(parent), [...chain, name]), baseForm = parse(base)
  // Derived scalar fields and properties replace the corresponding parent fields.
  const own = f.items.filter((i): i is Form => typeof i !== 'string' && i.head !== 'extends')
  const key = (i: Form) => i.head === 'property' ? `property:${value(i)}` : i.head
  if (own.some(i => i.head === 'symbol')) throw new Error(`derived symbol ${name}: custom body overrides are unsupported; use an expanded library`)
  const retained = baseForm.items.filter((i): i is Form => typeof i !== 'string' && !own.some(o => key(o) === key(i)))
  return `(symbol ${quote(name)} ${retained.map(i => base.slice(i.start, i.end)).join('\n')} ${own.map(i => source.slice(i.start, i.end)).join('\n')})`
}

function powerDefinitions(spec: Pick<PowerLabelSpec, 'libraryPath' | 'nets'>): Map<string, Form> {
  const library = readFileSync(spec.libraryPath, 'utf8'), forms = new Map<string, Form>()
  const selections = Object.entries(spec.nets)
  if (!selections.length) throw new Error('POWER_SYMBOL_MAPPING_INVALID: provide explicitly shared networks')
  for (const [net, libId] of selections) {
    const separator = libId.indexOf(':')
    if (!net || separator < 1 || separator === libId.length - 1) throw new Error('POWER_SYMBOL_MAPPING_INVALID: use exact net names and Library:Symbol IDs')
    const form = parse(definition(library, libId.slice(separator + 1)))
    const val = children(form, 'property').find(p => value(p) === 'Value')
    const pins = children(form, 'symbol').flatMap(s => children(s, 'pin'))
    const pin = pins[0], at = pin && children(pin, 'at')[0], length = pin && children(pin, 'length')[0]
    if (!children(form, 'power').length || !val || value(val, 2) !== net || pins.length !== 1
      || !at || Number(value(at, 1)) !== 0 || Number(value(at, 2)) !== 0 || !length || Number(value(length)) !== 0) {
      throw new Error(`POWER_SYMBOL_MAPPING_INVALID: ${libId} must be a power symbol with Value ${net} and one zero-length pin at its origin; do not merge or rename power domains`)
    }
    forms.set(net, form)
  }
  return forms
}

/** Symbol-local points of a placed unit, split into body graphics and pin ends. */
function unitExtent(sections: Form[], unit: number): { graphics: FlatPoint[]; pins: FlatPoint[] } {
  const graphics: FlatPoint[] = [], pins: FlatPoint[] = []
  const pair = (form: Form): FlatPoint => [Number(value(form, 1)), Number(value(form, 2))]
  const add = (list: FlatPoint[], x: number, y: number) => { if (Number.isFinite(x) && Number.isFinite(y)) list.push([x, y]) }
  for (const section of sections) {
    const suffix = /_(\d+)_(\d+)$/u.exec(value(section))
    if (!suffix) continue
    const sectionUnit = Number(suffix[1])
    if (sectionUnit !== 0 && sectionUnit !== unit) continue
    for (const shape of section.items) {
      if (typeof shape === 'string') continue
      if (shape.head === 'rectangle') {
        const start = children(shape, 'start')[0], end = children(shape, 'end')[0]
        if (start && end) { const a = pair(start), b = pair(end); add(graphics, a[0], a[1]); add(graphics, b[0], b[1]) }
      } else if (shape.head === 'circle') {
        const center = children(shape, 'center')[0], radius = children(shape, 'radius')[0]
        if (center && radius) { const c = pair(center), r = Number(value(radius, 1)); add(graphics, c[0] - r, c[1] - r); add(graphics, c[0] + r, c[1] + r) }
      } else if (shape.head === 'arc') {
        for (const key of ['start', 'mid', 'end']) { const f = children(shape, key)[0]; if (f) { const a = pair(f); add(graphics, a[0], a[1]) } }
      } else if (shape.head === 'polyline' || shape.head === 'bezier') {
        const pts = children(shape, 'pts')[0]
        if (pts) for (const xy of children(pts, 'xy')) { const a = pair(xy); add(graphics, a[0], a[1]) }
      } else if (shape.head === 'pin') {
        const at = children(shape, 'at')[0], length = children(shape, 'length')[0]
        if (at) {
          const x = Number(value(at, 1)), y = Number(value(at, 2)), l = length ? Number(value(length, 1)) : 0
          add(pins, x, y)
          const radians = (Number(value(at, 3)) || 0) * Math.PI / 180
          add(pins, x + l * Math.cos(radians), y + l * Math.sin(radians))
        }
      }
    }
  }
  return { graphics, pins }
}
/** Axis-aligned sheet bounds of symbol-local points under one placement transform. */
function boundsOf(points: FlatPoint[], at: FlatPoint, angle: number, mirror: 'x' | 'y' | undefined) {
  if (points.length === 0) return undefined
  const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [lx, ly] of points) {
    const rx = lx * cos - ly * sin, ry = lx * sin + ly * cos
    const x = at[0] + (mirror === 'y' ? -rx : rx), y = at[1] - (mirror === 'x' ? -ry : ry)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, maxX, minY, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 }
}
/** Reference and value share one side: power symbols away from their pin, other bodies by aspect. */
function fieldAnchors(sections: Form[], unit: number, at: FlatPoint, angle: number,
  mirror: 'x' | 'y' | undefined, isPower: boolean): [FlatPoint, FlatPoint] | undefined {
  const extent = unitExtent(sections, unit), gap = 2.54
  const body = boundsOf(extent.graphics, at, angle, mirror)
  const all = boundsOf(extent.graphics.concat(extent.pins), at, angle, mirror)
  if (!all) return undefined
  if (isPower && body) {
    const pins = boundsOf(extent.pins, at, angle, mirror)
    const above = pins === undefined || body.centerY < pins.centerY
    const edge = above ? body.minY : body.maxY, step = above ? -gap : gap
    return [[body.centerX, edge + step * 2], [body.centerX, edge + step]]
  }
  if (all.maxX - all.minX >= all.maxY - all.minY) {
    return [[all.centerX, all.minY - gap * 2], [all.centerX, all.minY - gap]]
  }
  const sideX = all.maxX + gap * 1.5
  return [[sideX, all.centerY - gap / 2], [sideX, all.centerY + gap / 2]]
}

/** Build a circuit through explicit script calls; generation errors throw before save. */
export class Schematic {
  private readonly rootId = randomUUID()
  private readonly definitions = new Map<string, string>()
  private readonly instances: string[] = []
  private readonly graphics: string[] = []
  private readonly references = new Map<string, string>()
  private placedPins: ReturnType<typeof listFlatObjects> | undefined
  private readonly frames: FlatFrame[] = []
  private readonly regions: Array<{ name: string; start: FlatPoint; end: FlatPoint }> = []
  private readonly importedModules = new Set<string>()
  private readonly objectModules = new Map<string, string>()
  private readonly requiredPowerSymbols: Record<string, string>
  private readonly templates: ReturnType<typeof loadFlatTemplates>
  /** Load validated templates. @param options Project identity, page and template directory. */
  constructor(private readonly options: SchematicOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(options.projectName)) throw new Error('projectName must be an ASCII filename without an extension')
    if (!['A4', 'A3', 'A2', 'A1', 'A0'].includes(options.paper)) throw new Error('unsupported paper size')
    this.requiredPowerSymbols = { ...options.requiredPowerSymbols }
    for (const [net, libId] of Object.entries(this.requiredPowerSymbols)) {
      if (!net.trim() || typeof libId !== 'string' || !/^[^:]+:[^:]+$/u.test(libId)) {
        throw new Error('POWER_SYMBOLS_REQUIRED: use explicit non-empty networks and Library:Symbol IDs')
      }
    }
    this.templates = loadFlatTemplates(options.templateDir)
  }
  /** Reserve a non-overlapping fixed module frame before placing its circuit.
   * @param spec Model-planned size, origin, title and explanation.
   * @returns Local-coordinate operations; no content fitting or automatic placement is performed.
   */
  region(spec: ModuleRegionSpec): ModuleRegion {
    const origin = [...point(spec.origin)] as FlatPoint, size = point(spec.size)
    if (!spec.name.trim() || size.some(n => n <= 0)) throw new Error('region requires a name and positive width/height')
    if (this.regions.some(r => r.name === spec.name)) throw new Error(`duplicate region: ${spec.name}`)
    const end: FlatPoint = [origin[0] + size[0], origin[1] + size[1]]
    const overlap = this.regions.find(r => origin[0] < r.end[0] && end[0] > r.start[0] && origin[1] < r.end[1] && end[1] > r.start[1])
    if (overlap) throw new Error(`region ${spec.name} overlaps ${overlap.name}; change origin or size in the layout plan`)
    this.regions.push({ name: spec.name, start: origin, end })
    this.frames.push({ name: spec.name, description: spec.description, start: origin, end })
    return new ModuleRegion(this, origin)
  }
  private source(): string {
    return `(kicad_sch (version 20250114) (generator "model_script") (uuid ${quote(this.rootId)})
      (paper ${quote(this.options.paper)}) (title_block (title ${quote(this.options.title)}))
      (lib_symbols ${[...this.definitions.values()].join('\n')})
      ${this.instances.join('\n')} ${this.graphics.join('\n')}
      (sheet_instances (path "/" (page "1"))))\n`
  }
  /** Persist source-reference mappings in scripts after importModule returns final references. */
  assignFootprints(mappings:Record<string,string>):void {
    const patched=assignFootprintText(this.source(),mappings);
    const instances=children(parse(patched),'symbol').map(form=>patched.slice(form.start,form.end));
    this.instances.splice(0,this.instances.length,...instances);
  }
  /** Merge an existing single-sheet circuit, isolating private nets and renumbering instances.
   * @param spec Source path, unique module name, global translation and explicit shared nets.
   * @returns Reference map, translated label anchors, net names and object UUIDs for frames.
   */
  importModule(spec: FlatImportSpec & { sourcePath: string;footprintMappingPath?:string }): FlatImportResult {
    if (this.importedModules.has(spec.name)) throw new Error(`duplicate imported module: ${spec.name}`)
    const used = new Set([...this.references.keys()].map(key => key.slice(0, key.lastIndexOf(':'))))
    const sourceText=readFileSync(spec.sourcePath,'utf8');
    const prepared = prepareFlatImport(sourceText, spec, this.options.projectName, this.rootId, used)
    const footprints:Record<string,string>={};
    if(spec.footprintMappingPath){
      const mapping=JSON.parse(readFileSync(spec.footprintMappingPath,'utf8'));
      if(mapping.version!==1||mapping.sourceHash!==createHash('sha256').update(sourceText).digest('hex')||!mapping.mappings||typeof mapping.mappings!=='object'||Array.isArray(mapping.mappings))throw new Error('Footprint mapping does not match current module source; localize it again');
      for(const [ref,id] of Object.entries(mapping.mappings)){
        const target=prepared.result.references[ref];
        if(!target||typeof id!=='string'||!/^[^:\r\n]+:[^:\r\n]+$/.test(id))throw new Error(`Invalid/stale module footprint mapping: ${ref}`);
        footprints[target]=id;
      }
    }
    for (const [id] of prepared.definitions) if (this.definitions.has(id)) throw new Error(`imported cache already exists: ${id}`)
    for (const [id, text] of prepared.definitions) this.definitions.set(id, text)
    for (const instance of prepared.instances) {
      this.references.set(`${instance.reference}:${instance.unit}`, instance.libId)
      this.instances.push(instance.text)
    }
    this.graphics.push(...prepared.graphics)
    for (const uuid of prepared.result.objectUuids) this.objectModules.set(uuid, spec.name)
    this.placedPins = undefined
    this.importedModules.add(spec.name)
    if(Object.keys(footprints).length)this.assignFootprints(footprints);
    return prepared.result
  }
  /** Place a symbol using its actual library definition, expanding simple inheritance.
   * @param spec Exact library symbol and model-selected placement.
   * @returns UUID for grouping this instance in a frame.
   */
  addSymbol(spec: SymbolPlacement): string {
    this.placedPins = undefined
    const at = point(spec.at), angle = spec.angle ?? 0, unit = spec.unit ?? 1
    if (!/^[A-Za-z#][A-Za-z0-9_]*\d+$/u.test(spec.reference)) throw new Error(`invalid reference: ${spec.reference}`)
    if (![0, 90, 180, 270].includes(angle) || !Number.isInteger(unit) || unit < 1) throw new Error(`invalid angle or unit for ${spec.reference}`)
    if (spec.mirror !== undefined && !['x', 'y'].includes(spec.mirror)) throw new Error(`invalid mirror for ${spec.reference}`)
    const separator = spec.libId.indexOf(':')
    if (separator < 1 || separator === spec.libId.length - 1) throw new Error('libId requires Library:Symbol')
    const key = `${spec.reference}:${unit}`
    if (this.references.has(key)) throw new Error(`duplicate instance: ${key}`)
    for (const [existing, libId] of this.references) if (existing.startsWith(`${spec.reference}:`) && libId !== spec.libId) throw new Error(`reference ${spec.reference} uses different symbols`)
    const symbolName = spec.libId.slice(separator + 1)
    const raw = normalizeCommonUnits(definition(readFileSync(spec.libraryPath, 'utf8'), symbolName)), form = parse(raw)
    const sections = children(form, 'symbol')
    if (!sections.some(s => { const m = /_(\d+)_(\d+)$/u.exec(value(s)); return m && Number(m[1]) === unit && [0, 1].includes(Number(m[2])) })) throw new Error(`symbol ${spec.libId} has no unit ${unit}`)
    const rename = (f: Form, name: string) => {
      const first = raw.indexOf(quote(value(f)), f.start)
      return { start: first, end: first + quote(value(f)).length, text: quote(name) }
    }
    const normalized = applyEdits(raw, [rename(form, spec.libId), ...sections.map(section => {
      const suffix = /_(\d+)_(\d+)$/u.exec(value(section))
      if (!suffix) throw new Error(`invalid symbol unit name: ${value(section)}`)
      return rename(section, `${symbolName}_${suffix[1]}_${suffix[2]}`)
    })])
    const normalizedForm = parse(normalized)
    const ordered = normalizedForm.items.filter((i): i is Form => typeof i !== 'string')
      .sort((a, b) => Number(a.head === 'symbol') - Number(b.head === 'symbol'))
    const cached = `(symbol ${quote(spec.libId)} ${ordered.map(f => normalized.slice(f.start, f.end)).join('\n')})`
    const previous = this.definitions.get(spec.libId)
    if (previous && previous !== cached) throw new Error(`inconsistent library definition: ${spec.libId}`)
    const defaultProperty = (name: string) => children(form, 'property').find(p => value(p) === name)
    const hiddenProperty = (name: string) => {
      const p = defaultProperty(name)
      if (!p) return false
      if (children(p, 'hide').length > 0 || p.items.slice(2).includes('hide')) return true
      const effects = children(p, 'effects')[0]
      return effects ? children(effects, 'hide').length > 0 || effects.items.includes('hide') : false
    }
    const val = spec.value ?? (defaultProperty('Value') ? value(defaultProperty('Value')!, 2) : symbolName)
    const footprint = spec.footprint ?? (defaultProperty('Footprint') ? value(defaultProperty('Footprint')!, 2) : '')
    const uuid = randomUUID()
    const anchors = fieldAnchors(sections, unit, at, angle, spec.mirror, children(form, 'power').length > 0)
    const referenceAt = point(spec.referenceAt ?? (anchors ? anchors[0] : [at[0], at[1] - 5.08]))
    const valueAt = point(spec.valueAt ?? (anchors ? anchors[1] : [at[0], at[1] - 2.54]))
    const fieldAngle = spec.fieldAngle ?? ([90, 270].includes(angle) ? 90 : 0)
    const property = (name: string, text: string, p: FlatPoint, hide = false) => `(property ${quote(name)} ${quote(text)} (at ${p[0]} ${p[1]} ${fieldAngle}) (effects (font (size 1.27 1.27))${hide ? ' (hide yes)' : ''}))`
    this.definitions.set(spec.libId, cached)
    this.references.set(key, spec.libId)
    this.instances.push(`(symbol (lib_id ${quote(spec.libId)}) (at ${at[0]} ${at[1]} ${angle}) (unit ${unit}) ${spec.mirror ? `(mirror ${spec.mirror})` : ''}
      (in_bom yes) (on_board yes) (dnp no) (uuid ${quote(uuid)})
      ${property('Reference', spec.reference, referenceAt, spec.hideReference ?? hiddenProperty('Reference'))} ${property('Value', val, valueAt, spec.hideValue ?? hiddenProperty('Value'))}
      ${property('Footprint', footprint, at, true)} ${property('Datasheet', defaultProperty('Datasheet') ? value(defaultProperty('Datasheet')!, 2) : '', at, true)}
      (instances (project ${quote(this.options.projectName)} (path ${quote(`/${this.rootId}`)} (reference ${quote(spec.reference)}) (unit ${unit})))))`)
    return uuid
  }
  /** Read every placed pin in one catalog, including rotation and mirror transforms.
   * @returns Instance identities, exact sheet pins and explicit pin errors; no connectivity is inferred.
   */
  pinCatalog(): ReturnType<typeof listFlatObjects> {
    this.placedPins ??= listFlatObjects(this.source()).filter(object => object.type === 'symbol')
    return this.placedPins.map(o => ({ ...o, ...(o.at ? { at: [...o.at] as FlatPoint } : {}),
      ...(o.pins ? { pins: o.pins.map(p => ({ ...p, at: [...p.at] as FlatPoint })) } : {}) }))
  }
  /** Resolve a placed symbol's numbered pin; ambiguous multi-unit matches fail.
   * @param reference Placed reference. @param number Actual library pin number.
   * @returns Transformed sheet coordinates in millimetres.
   */
  pin(reference: string, number: string): FlatPoint {
    const objects = this.pinCatalog().filter(o => o.reference === reference)
    if (objects.length === 0) throw new Error(`reference not placed: ${reference}`)
    const error = objects.find(o => o.pinError)
    if (error) throw new Error(`${reference}: ${error.pinError}`)
    const matches = objects.flatMap(o => o.pins ?? []).filter(p => p.number === number)
    if (matches.length !== 1) throw new Error(`${reference}.${number}: expected one placed pin, found ${matches.length}`)
    return matches[0]!.at
  }
  private endpoint(input: FlatEndpoint): FlatPoint { return Array.isArray(input) ? point(input) : this.pin(input.reference, input.pin) }
  /** Add explicitly routed orthogonal wire segments; no junctions are inferred.
   * @param from Pin or coordinate. @param to Pin or coordinate. @param via Explicit intermediate bends.
   * @returns UUIDs of generated segments for frame grouping.
   */
  wire(from: FlatEndpoint, to: FlatEndpoint, via: FlatPoint[] = []): string[] {
    const points = [this.endpoint(from), ...via.map(point), this.endpoint(to)]
    const segments: string[] = [], ids: string[] = []
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!
      if ((a[0] === b[0] && a[1] === b[1]) || (a[0] !== b[0] && a[1] !== b[1])) throw new Error('wire needs nonzero orthogonal segments; supply explicit via coordinates')
      const id = randomUUID(); ids.push(id)
      segments.push(`(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width ${this.templates.style.wireWidth}) (type default)) (uuid ${quote(id)}))`)
    }
    this.graphics.push(...segments)
    return ids
  }
  /** Add a local electrical label at a pin or wire point.
   * @param name Exact network name. @param at Explicit anchor. @param angle Text rotation.
   * @returns Label UUID for grouping.
   */
  label(name: string, at: FlatEndpoint, angle: 0 | 90 | 180 | 270 = 0): string {
    if (!name || ![0, 90, 180, 270].includes(angle)) throw new Error('label needs a name and orthogonal angle')
    const p = this.endpoint(at), id = randomUUID()
    const justify = angle === 180 || angle === 270 ? 'right' : 'left'
    this.graphics.push(`(label ${quote(name)} (at ${p[0]} ${p[1]} ${angle}) (effects (font (size 1.27 1.27)) (justify ${justify} bottom)) (uuid ${quote(id)}))`)
    return id
  }
  /** List only explicitly selected local/global labels in this build, before conversion.
   * UUIDs are fresh each build; select by module/net/coordinates and use this returned UUID.
   * @param nets Exact shared networks, never a heuristic power-name filter.
   * @returns Detached label records in sheet millimetres; hierarchical labels are excluded.
   */
  powerLabelCatalog(nets: readonly string[]): PowerLabelEntry[] {
    if (!Array.isArray(nets) || !nets.length || nets.some(net => typeof net !== 'string' || !net.trim())) {
      throw new Error('POWER_LABEL_INVALID: provide explicit shared network names')
    }
    const selected = new Set(nets)
    return this.graphics.flatMap(graphic => {
      const form = parse(graphic)
      if (form.head !== 'label' && form.head !== 'global_label') return []
      const net = value(form)
      if (!selected.has(net)) return []
      const anchor = children(form, 'at')[0], identity = children(form, 'uuid')[0]
      if (!anchor || !identity) throw new Error(`POWER_LABEL_INVALID: ${net} needs at and uuid`)
      const uuid = value(identity), module = this.objectModules.get(uuid)
      return [{ uuid, net, at: point([Number(value(anchor, 1)), Number(value(anchor, 2))]),
        angle: anchor.items.length > 3 ? Number(value(anchor, 3)) : 0,
        type: form.head, ...(module ? { module } : {}) }]
    })
  }
  /** Verify constructor-declared power-symbol delivery requirements before publication.
   * Each exact net must have a genuine power definition, matching libId and Value,
   * and no unconverted local/global label. Does not infer or merge power domains.
   * @returns Per-net completion counts; throws without mutating the sheet on failure.
   */
  checkPowerSymbols(): PowerSymbolStatus[] {
    const nets = Object.keys(this.requiredPowerSymbols)
    if (!nets.length) return []
    const labels = this.powerLabelCatalog(nets)
    const statuses = nets.map(net => {
      const libId = this.requiredPowerSymbols[net]!
      const definitionText = this.definitions.get(libId)
      const isPower = definitionText !== undefined && children(parse(definitionText), 'power').length > 0
      const symbolCount = isPower ? this.instances.filter(instance => {
        const form = parse(instance), id = children(form, 'lib_id')[0]
        const val = children(form, 'property').find(property => value(property) === 'Value')
        return id && value(id) === libId && val && value(val, 2) === net
      }).length : 0
      return { net, libId, symbolCount, remainingLabelUuids: labels.filter(label => label.net === net).map(label => label.uuid) }
    })
    const incomplete = statuses.filter(status => !status.symbolCount || status.remainingLabelUuids.length)
    if (incomplete.length) throw new Error(`POWER_SYMBOLS_REQUIRED: ${incomplete.map(status =>
      `${status.net}: ${status.symbolCount} power symbols, ${status.remainingLabelUuids.length} unconverted labels`).join('; ')}. Convert current-build labels or report the unresolved requirement; do not remove power symbols to avoid layout overlaps.`)
    return statuses
  }
  /** Plan bounded cardinal rotations, readable text positions and safe short straight leads.
   * Does not mutate the sheet; consume placements in replacePowerLabels in this same build.
   * Unresolved conservative overlaps are returned, not presented as a clean layout.
   */
  planPowerPlacements(spec: PowerPlanningOptions): PowerPlacementPlan {
    const forms = powerDefinitions(spec), cache = new Map<string, PowerGeometry>()
    const geometry = (net: string, angle: 0 | 90 | 180 | 270): PowerGeometry => {
      const key = `${net}:${angle}`, existing = cache.get(key)
      if (existing) return existing
      const form = forms.get(net)!
      const points = unitExtent(children(form, 'symbol'), 1).graphics
      const extent = boundsOf(points, [0, 0], angle, undefined) ?? { minX: -0.1, maxX: 0.1, minY: -0.1, maxY: 0.1 }
      const result = { body: { left: extent.minX - 0.12, right: extent.maxX + 0.12, top: extent.minY - 0.12, bottom: extent.maxY + 0.12 },
        textSize: flatTextSize(net, [1.27, 1.27], this.templates.style) }
      cache.set(key, result)
      return result
    }
    const pages: Record<SchematicOptions['paper'], FlatPoint> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] }
    return planPowerLabels(this.powerLabelCatalog(Object.keys(spec.nets)), listFlatObjects(this.source(), this.templates.style), geometry, pages[this.options.paper], spec)
  }
  /** Replace explicitly shared local/global power labels using zero-length-pin power symbols.
   * @param spec Trusted library, exact net map and optional label-UUID placements with caller-routed bends.
   * @returns Replaced labels with retained UUIDs and network names; moved anchors receive explicit connecting wires.
   */
  replacePowerLabels(spec: PowerLabelSpec): PowerLabelReplacement[] {
    powerDefinitions(spec)
    // Prepare every placement independently so an incompatible library leaves this sheet intact.
    const prepared = new Schematic(this.options)
    const used = new Set([...this.references.keys()].map(key => key.slice(0, key.lastIndexOf(':'))))
    let counter = 0
    const replacements: PowerLabelReplacement[] = [], retained: string[] = []
    const extraWires: string[] = []
    const convertedIds = new Set<string>()
    const wireGroups = new Map<string, string[]>()
    for (const graphic of this.graphics) {
      const form = parse(graphic)
      if (!['label', 'global_label'].includes(form.head)) { retained.push(graphic); continue }
      const net = value(form)
      const libId = Object.hasOwn(spec.nets, net) ? spec.nets[net] : undefined
      if (libId === undefined) { retained.push(graphic); continue }
      const anchor = children(form, 'at')[0], identity = children(form, 'uuid')[0]
      if (!anchor || !identity) throw new Error(`POWER_LABEL_INVALID: ${net} needs at and uuid`)
      const at = point([Number(value(anchor, 1)), Number(value(anchor, 2))]), uuid = value(identity)
      let reference: string
      do { counter += 1; reference = `#PWR${counter}` } while (used.has(reference))
      used.add(reference)
      const placement = spec.placements?.[uuid]
      const target = placement ? point(placement.at) : at
      if (placement) {
        if (target[0] !== at[0] || target[1] !== at[1]) {
          const start = prepared.graphics.length
          wireGroups.set(uuid, prepared.wire(at, target, placement.via ?? []))
          extraWires.push(...prepared.graphics.slice(start))
        } else if (placement.via?.length) throw new Error(`POWER_LABEL_INVALID: ${uuid} has bends but no moved anchor`)
      }
      prepared.addSymbol({ libraryPath: spec.libraryPath, libId, reference, value: net, at: target,
        ...(placement?.angle !== undefined ? { angle: placement.angle } : {}),
        ...(placement?.valueAt ? { valueAt: placement.valueAt } : {}), hideReference: true })
      convertedIds.add(uuid)
      const index = prepared.instances.length - 1, instance = prepared.instances[index]!
      const oldId = children(parse(instance), 'uuid')[0]!
      prepared.instances[index] = applyEdits(instance, [{ start: oldId.start, end: oldId.end, text: `(uuid ${quote(uuid)})` }])
        .replace(quote(`/${prepared.rootId}`), quote(`/${this.rootId}`))
      replacements.push({ uuid, reference, net, libId, at: target })
    }
    for (const uuid of Object.keys(spec.placements ?? {})) {
      if (!convertedIds.has(uuid)) throw new Error(`POWER_LABEL_INVALID: placement ${uuid} does not select a mapped label`)
    }
    for (const [id, cached] of prepared.definitions) {
      if (this.definitions.has(id) && this.definitions.get(id) !== cached) throw new Error(`inconsistent library definition: ${id}`)
    }
    for (const [id, cached] of prepared.definitions) this.definitions.set(id, cached)
    for (const [key, id] of prepared.references) this.references.set(key, id)
    this.placedPins = undefined
    this.instances.push(...prepared.instances)
    this.graphics.splice(0, this.graphics.length, ...retained, ...extraWires)
    for (const frame of this.frames) {
      if (frame.autoBounds && frame.objectUuids) {
        frame.objectUuids = [...frame.objectUuids, ...frame.objectUuids.flatMap(uuid => wireGroups.get(uuid) ?? [])]
      }
    }
    return replacements
  }
  /** Locate conservative overlaps around power symbols and their visible fields.
   * @returns Suspected object intersections; attached wire endpoints are excluded. Review hints in preview.
   */
  powerLayoutWarnings(): PowerLayoutWarning[] {
    const objects = listFlatObjects(this.source(), this.templates.style)
    const powers = objects.filter(o => o.type === 'symbol' && o.libId
      && children(parse(this.definitions.get(o.libId)!), 'power').length > 0)
    const warnings: PowerLayoutWarning[] = []
    for (const power of powers) {
      if (!power.bounds) continue
      for (const other of objects) {
        if (other.uuid === power.uuid || !other.bounds || ['rectangle', 'junction', 'no_connect'].includes(other.type)) continue
        if (other.type === 'wire' && [other.from, other.to].some(p => p && power.at && p[0] === power.at[0] && p[1] === power.at[1])) continue
        const a = power.bounds, b = other.bounds
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
          warnings.push({ code: 'POWER_LAYOUT_OVERLAP', uuid: power.uuid, reference: power.reference!, otherUuid: other.uuid, otherType: other.type })
        }
      }
    }
    return warnings
  }
  /** Add a passive hierarchy port connected at an explicit anchor; no connection is inferred.
   * @param name Port name. @param at Actual pin or sheet coordinate. @param angle Text rotation.
   * @returns Label UUID for a generated child sheet.
   */
  hierarchicalLabel(name: string, at: FlatEndpoint, angle: 0 | 90 | 180 | 270 = 0): string {
    if (!name || ![0, 90, 180, 270].includes(angle)) throw new Error('hierarchical label needs a name and orthogonal angle')
    const p = this.endpoint(at), id = randomUUID()
    this.graphics.push(`(hierarchical_label ${quote(name)} (shape passive) (at ${p[0]} ${p[1]} ${angle}) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid ${quote(id)}))`)
    return id
  }
  /** Add an explicit branch junction or intentionally unconnected pin marker.
   * @param kind Marker kind. @param at Pin or coordinate.
   * @returns Marker UUID.
   */
  marker(kind: 'junction' | 'no_connect', at: FlatEndpoint): string {
    if (!['junction', 'no_connect'].includes(kind)) throw new Error('unsupported marker')
    const p = this.endpoint(at), id = randomUUID()
    this.graphics.push(`(${kind} (at ${p[0]} ${p[1]}) ${kind === 'junction' ? '(diameter 0) (color 0 0 0 0)' : ''} (uuid ${quote(id)}))`)
    return id
  }
  /** Add a module frame with manual bounds or explicitly grouped automatic bounds.
   * @param frame Visible title, explanation and range selection; omitted excludeUuids resolves to an empty list.
   */
  frame(frame: { name: string; description: string } & (
    { start: FlatPoint; end: FlatPoint; autoBounds?: false }
    | { autoBounds: true; objectUuids?: string[]; excludeUuids?: string[] }
  )): void {
    this.frames.push(frame.autoBounds ? { ...frame, excludeUuids: frame.excludeUuids ?? [] } : frame)
  }
  /** Serialize the current design with existing frame and project templates.
   * @returns Schematic text, project JSON text, resolved frames and edit counts.
   */
  render(): ReturnType<typeof buildFlatCopy> {
    this.checkPowerSymbols()
    if (!this.instances.length) throw new Error('place at least one symbol before rendering')
    return buildFlatCopy(this.source(), this.options.projectName, { removeReferences: [], removeUuids: [], removeTextUuids: [], setValues: [], setLabels: [], addWires: [], frames: this.frames }, this.templates)
  }
  /** Write a new output pair without overwriting existing files; use a unique candidate directory.
   * @param directory Explicit output directory; created recursively when absent.
   * @returns Written paths, resolved frames and conservative power-layout warnings from the saved design. Errors may leave a partial pair.
   */
  save(directory: string): { schematicPath: string; projectPath: string; frames: ResolvedFlatFrame[]; layoutWarnings: PowerLayoutWarning[] } {
    const result = this.render(), schematicPath = join(directory, `${this.options.projectName}.kicad_sch`), projectPath = join(directory, `${this.options.projectName}.kicad_pro`)
    if (existsSync(schematicPath) || existsSync(projectPath)) throw new Error(`output already exists: ${directory}; choose a unique candidate directory`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(schematicPath, result.schematic, { flag: 'wx' })
    writeFileSync(projectPath, result.project, { flag: 'wx' })
    return { schematicPath, projectPath, frames: result.resolvedFrames, layoutWarnings: this.powerLayoutWarnings() }
  }
}
