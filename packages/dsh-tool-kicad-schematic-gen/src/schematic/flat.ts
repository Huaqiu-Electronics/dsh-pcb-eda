/** Copy and edit one existing sheet using explicit objects and embedded symbol pins. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyEdits, children, deleteForm, quote, required, value, type Form, type TextEdit } from './sexpr.ts'
import { validatePreviewSchematic } from './preview-diagnostics.ts'
import { alignVendorSymbolIds } from './project.ts'
import { flatImageBounds, flatObjectBounds, flatTextSize, unionFlatBounds, type FlatBounds, type FlatImage, type FlatLayoutStyle } from './flat-layout.ts'

/** Coordinates in schematic millimetres. */
export type FlatPoint = [number, number]
/** Explicit wire endpoint; pin numbers use the retained source symbol cache. */
export type FlatEndpoint = FlatPoint | { reference: string; pin: string }
/** One graphic module frame and its visible explanation. */
export type FlatFrame = { name: string; description: string } & (
  { start: FlatPoint; end: FlatPoint; autoBounds?: false }
  | { autoBounds: true; objectUuids?: string[]; excludeUuids: string[] }
)
/** Final frame coordinates, including automatically calculated ranges. */
export interface ResolvedFlatFrame { name: string; description: string; start: FlatPoint; end: FlatPoint }
/** Supported edits; deleting a component does not delete surrounding wires. */
export interface FlatPlan {
  removeReferences: string[]
  removeUuids: string[]
  /** Selected source annotations only; electrical objects are rejected. */
  removeTextUuids: string[]
  setValues: Array<{ reference: string; value: string }>
  setLabels: Array<{ uuid: string; name?: string; at?: FlatPoint; angle?: number }>
  addWires: Array<{ from: FlatEndpoint; to: FlatEndpoint; via: FlatPoint[] }>
  frames: FlatFrame[]
}
/** Editable top-level object returned by list action. */
export interface FlatObject {
  type: string
  uuid: string
  reference?: string
  libId?: string
  unit?: number
  angle?: number
  mirror?: string
  footprint?: string
  dnp?: boolean
  value?: string
  name?: string
  at?: FlatPoint
  from?: FlatPoint
  to?: FlatPoint
  pinError?: string
  pins?: Array<{ number: string; name: string; at: FlatPoint; electricalType: string }>
  bounds?: FlatBounds
  boundsError?: string
  image?: FlatImage
}
/** Deployment-selected templates shared with the flat skill. */
export interface FlatTemplates {
  project: Record<string, unknown> & { meta: { filename: string; version: number } }
  frame: string
  style: FlatLayoutStyle & { inset: number; titleOffset: number; descriptionBottom: number; lineHeight: number; wireWidth: number }
}

/** Load explicit project and graphic templates; malformed configuration fails at plugin load.
 * @param directory Absolute directory containing the flat skill's templates.
 * @returns Parsed project, frame fragment, and validated numeric placement settings.
 */
export function loadFlatTemplates(directory: string): FlatTemplates {
  const project = JSON.parse(readFileSync(join(directory, 'project.kicad_pro'), 'utf8')) as FlatTemplates['project']
  if (project === null || typeof project !== 'object' || project.meta?.version !== 1
    || typeof project.meta.filename !== 'string' || !project.board || !project.net_settings || !project.libraries) {
    throw new Error('flatTemplateDir/project.kicad_pro must contain KiCad project defaults and meta version 1')
  }
  const style = JSON.parse(readFileSync(join(directory, 'frame-style.json'), 'utf8')) as FlatTemplates['style']
  if (style === null || typeof style !== 'object') throw new Error('frame-style.json must be an object')
  for (const key of ['inset', 'titleOffset', 'descriptionBottom', 'lineHeight', 'wireWidth',
    'contentPadding', 'grid', 'textWidthFactor', 'textHeightFactor'] as const) {
    if (typeof style[key] !== 'number' || !Number.isFinite(style[key]) || style[key] <= 0) {
      throw new Error(`frame-style.json: ${key} must be a positive number`)
    }
  }
  const frame = readFileSync(join(directory, 'module-frame.kicad_sch.fragment'), 'utf8')
  for (const token of ['X1', 'Y1', 'X2', 'Y2', 'FRAME_UUID', 'TITLE', 'TITLE_X', 'TITLE_Y', 'TITLE_UUID',
    'DESCRIPTION', 'DESCRIPTION_X', 'DESCRIPTION_Y', 'DESCRIPTION_UUID']) {
    if (!frame.includes(`{{${token}}}`)) throw new Error(`frame template lacks {{${token}}}`)
  }
  return { project, frame, style }
}

function rootOf(source: string): Form {
  const root = validatePreviewSchematic(source, 'sourcePath')
  if (children(root, 'sheet').length > 0) throw new Error('flat editor accepts single-sheet sources only')
  required(root, 'uuid')
  required(root, 'lib_symbols')
  return root
}

function property(form: Form, key: string): Form {
  const matches = children(form, 'property').filter(item => value(item) === key)
  if (matches.length !== 1) throw new Error(`expected one ${key} property in symbol`)
  return matches[0]!
}

function reference(form: Form): string { return value(property(form, 'Reference'), 2) }
function id(form: Form): string { return value(required(form, 'uuid')) }
function point(form: Form): FlatPoint {
  const at: FlatPoint = [Number(value(form, 1)), Number(value(form, 2))]
  if (at.some(item => !Number.isFinite(item))) throw new Error(`invalid coordinates in ${form.head}`)
  return at
}

function replaceAtom(source: string, form: Form, index: number, next: string): TextEdit {
  const atoms = [...source.slice(form.start, form.end).matchAll(/"(?:[^"\\]|\\.)*"|[^\s()]+/gu)]
  const atom = atoms[index]
  if (atom === undefined || typeof form.items[index] !== 'string') throw new Error(`unsupported atom ${index} in ${form.head}`)
  return { start: form.start + atom.index, end: form.start + atom.index + atom[0].length, text: next }
}

function pins(root: Form, instance: Form): NonNullable<FlatObject['pins']> {
  const libId = value(required(instance, 'lib_id'))
  const matches = children(required(root, 'lib_symbols'), 'symbol').filter(item => value(item) === libId)
  if (matches.length !== 1) throw new Error(`embedded symbol cache must uniquely match ${libId}`)
  const definition = matches[0]!
  if (children(definition, 'extends').length > 0) throw new Error(`inherited cache ${libId} must be expanded before pin connections`)
  const unit = Number(value(required(instance, 'unit')))
  const convert = children(instance, 'convert')[0]
  const body = convert === undefined ? 1 : Number(value(convert))
  const at = required(instance, 'at')
  const origin = point(at)
  const angle = Number(value(at, 3))
  if (![0, 90, 180, 270].includes(angle)) throw new Error(`unsupported symbol angle for ${reference(instance)}`)
  const mirror = children(instance, 'mirror')[0]
  const axis = mirror === undefined ? '' : value(mirror)
  if (!['', 'x', 'y'].includes(axis)) throw new Error(`unsupported mirror for ${reference(instance)}`)
  const radians = angle * Math.PI / 180
  return children(definition, 'symbol').flatMap(section => {
    const suffix = /_(\d+)_(\d+)$/u.exec(value(section))
    if (suffix === null) throw new Error(`unsupported cache unit name: ${value(section)}`)
    if ((Number(suffix[1]) !== 0 && Number(suffix[1]) !== unit)
      || (Number(suffix[2]) !== 0 && Number(suffix[2]) !== body)) return []
    return children(section, 'pin').map(pin => {
      const local = point(required(pin, 'at'))
      const rotatedX = local[0] * Math.cos(radians) - local[1] * Math.sin(radians)
      const rotatedY = local[0] * Math.sin(radians) + local[1] * Math.cos(radians)
      // KiCad mirrors the rotated symbol axes before converting library Y to sheet Y.
      const x = axis === 'y' ? -rotatedX : rotatedX
      const y = axis === 'x' ? -rotatedY : rotatedY
      const round = (number: number) => Math.round(number * 1e6) / 1e6
      return { number: value(required(pin, 'number')), name: value(required(pin, 'name')),
        electricalType: value(pin),
        at: [round(origin[0] + x), round(origin[1] - y)] as FlatPoint }
    })
  })
}

/** List editable IDs and pin locations without inspecting net connectivity or writing files.
 * @param source Exact source schematic text.
 * @param style Optional template-selected text allowances for layout measurements.
 * @returns Object IDs and component pins, plus PNG geometry and optional conservative bounds.
 */
export function listFlatObjects(source: string, style?: FlatLayoutStyle): FlatObject[] {
  rootOf(source)
  const root = rootOf(alignVendorSymbolIds(source))
  const types = new Set(['symbol', 'wire', 'junction', 'label', 'global_label', 'hierarchical_label',
    'no_connect', 'text', 'text_box', 'rectangle', 'polyline', 'image'])
  return root.items.filter((item): item is Form => typeof item !== 'string'
    && (types.has(item.head) || children(item, 'uuid').length === 1)).map(form => {
    const object: FlatObject = { type: form.head, uuid: id(form) }
    const at = children(form, 'at')[0]
    if (at !== undefined) object.at = point(at)
    if (form.head === 'symbol') {
      object.reference = reference(form)
      object.libId = value(required(form, 'lib_id'))
      object.unit = Number(value(required(form, 'unit')))
      object.angle = Number(value(required(form, 'at'), 3))
      object.mirror = children(form, 'mirror').map(item => value(item)).join('')
      const footprint = children(form, 'property').find(item => value(item) === 'Footprint')
      if (footprint) object.footprint = value(footprint, 2)
      object.dnp = children(form, 'dnp').some(item => value(item) === 'yes')
      object.value = value(property(form, 'Value'), 2)
      try { object.pins = pins(root, form) }
      catch (error) { object.pinError = error instanceof Error ? error.message : String(error) }
    } else if (form.head === 'wire') {
      const ends = children(required(form, 'pts'), 'xy')
      if (ends.length !== 2) throw new Error('flat editor expects two-endpoint wire forms')
      object.from = point(ends[0]!)
      object.to = point(ends[1]!)
    } else if (['label', 'global_label', 'hierarchical_label', 'text', 'text_box'].includes(form.head)) object.name = value(form)
    if (form.head === 'image') {
      try { Object.assign(object, flatImageBounds(root, form)) }
      catch (error) { object.boundsError = error instanceof Error ? error.message : String(error) }
    } else if (style !== undefined) {
      try {
        const bounds = flatObjectBounds(root, form, style)
        if (bounds) object.bounds = bounds
      } catch (error) { object.boundsError = error instanceof Error ? error.message : String(error) }
    }
    return object
  })
}

/** Summarize all measured content before pagination; old rectangles are excluded by default.
 * @param objects Complete object catalog with optional bounds.
 * @param style Template-selected margins and grid.
 * @returns Content bounds, a conservative frame range, and unmeasured object diagnostics.
 */
export function summarizeFlatLayout(objects: FlatObject[], style: FlatTemplates['style']): {
  contentBounds: FlatBounds | null; suggestedFrame: { start: FlatPoint; end: FlatPoint } | null;
  issues: Array<{ uuid: string; type: string; message: string }>
} {
  const content = objects.filter(object => object.type !== 'rectangle')
  const contentBounds = unionFlatBounds(content.flatMap(object => object.bounds ? [object.bounds] : []))
  const issues = content.filter(object => object.boundsError).map(object => ({ uuid: object.uuid, type: object.type, message: object.boundsError! }))
  return { contentBounds, suggestedFrame: contentBounds ? frameRange(contentBounds, style, 0, 0) : null, issues }
}

function frameRange(bounds: FlatBounds, style: FlatTemplates['style'], textWidth: number, descriptionLines: number,
  titleHeight = 0, descriptionHeight = 0): { start: FlatPoint; end: FlatPoint } {
  const floor = (number: number) => Number((Math.floor(number / style.grid) * style.grid).toFixed(6))
  const ceil = (number: number) => Number((Math.ceil(number / style.grid) * style.grid).toFixed(6))
  const start: FlatPoint = [floor(bounds.left - style.contentPadding),
    floor(bounds.top - style.contentPadding - style.titleOffset - Math.max(style.lineHeight, titleHeight / 2))]
  const end: FlatPoint = [ceil(Math.max(bounds.right + style.contentPadding, start[0] + textWidth + style.inset * 2)),
    ceil(bounds.bottom + style.contentPadding + style.descriptionBottom
      + Math.max(style.lineHeight, Math.max(0, descriptionLines - 1) * style.lineHeight + descriptionHeight / 2))]
  return { start, end }
}

function resolveFrame(frame: FlatFrame, objects: FlatObject[], templates: FlatTemplates): ResolvedFlatFrame {
  if (!frame.autoBounds) return frame
  const byId = new Map(objects.map(object => [object.uuid, object]))
  const include = frame.objectUuids === undefined ? undefined : new Set(frame.objectUuids)
  const exclude = new Set(frame.excludeUuids)
  if ((include && include.size !== frame.objectUuids!.length) || exclude.size !== frame.excludeUuids.length) throw new Error(`frame ${frame.name}: duplicate object selector`)
  for (const uuid of [...(include ?? []), ...exclude]) {
    if (!byId.has(uuid)) throw new Error(`frame ${frame.name}: retained layout UUID not found: ${uuid}`)
    if (include?.has(uuid) && exclude.has(uuid)) throw new Error(`frame ${frame.name}: object appears in both include and exclude: ${uuid}`)
  }
  const content = objects.filter(object => !exclude.has(object.uuid) && (include ? include.has(object.uuid) : object.type !== 'rectangle'))
  const missing = content.filter(object => object.boundsError)
  if (missing.length > 0) throw new Error(`frame ${frame.name}: automatic bounds unavailable: ${JSON.stringify(missing.map(object => ({ uuid: object.uuid, message: object.boundsError })))}; provide manual start/end, or explicitly exclude decoration from this frame`)
  const bounds = unionFlatBounds(content.flatMap(object => object.bounds ? [object.bounds] : []))
  if (!bounds) throw new Error(`frame ${frame.name}: no visible selected content for automatic bounds`)
  const sampleTokens: Record<string, string> = { TITLE: quote(frame.name), DESCRIPTION: quote(frame.description) }
  const sample = rootOf(`(kicad_sch (version 20250114) (uuid "frame-template") (lib_symbols) ${templates.frame.replace(/\{\{([A-Z_0-9]+)\}\}/gu,
    (_all, token: string) => sampleTokens[token] ?? '0')})`)
  const textSizes = children(sample, 'text').map(text => flatTextSize(value(text),
    point(required(required(required(text, 'effects'), 'font'), 'size')), templates.style))
  return { name: frame.name, description: frame.description,
    ...frameRange(bounds, templates.style, Math.max(0, ...textSizes.map(size => size[0])), frame.description.split('\n').length,
      textSizes[0]?.[1], textSizes[1]?.[1]) }
}

function endpoint(root: Form, end: FlatEndpoint, removed: Set<Form>): FlatPoint {
  if (Array.isArray(end)) return end
  const instances = children(root, 'symbol').filter(item => reference(item) === end.reference && !removed.has(item))
  const candidates = instances.flatMap(instance => pins(root, instance)).filter(pin => pin.number === end.pin)
  const locations = new Map(candidates.map(pin => [pin.at.join(','), pin.at]))
  if (locations.size !== 1) throw new Error(`pin endpoint ${end.reference}.${end.pin} must resolve to one location; found ${locations.size}`)
  return [...locations.values()][0]!
}

/** Apply an explicit plan and create a project copy in memory; no endpoint audit or external processes run.
 * @param source Existing single-sheet source with embedded symbols.
 * @param projectName ASCII project filename stem.
 * @param plan Explicit edits and module frames with manual or automatic bounds.
 * @param templates Validated project and graphic templates.
 * @returns New schematic and project text, resolved frame coordinates, and applied edit counts.
 */
export function buildFlatCopy(source: string, projectName: string, plan: FlatPlan, templates: FlatTemplates): {
  schematic: string; project: string; resolvedFrames: ResolvedFlatFrame[];
  changes: { removedObjects: number; changedValues: number; changedLabels: number; addedWireSegments: number; addedFrames: number }
} {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(projectName)) throw new Error('projectName must be an ASCII filename stem starting with a letter')
  rootOf(source)
  source = alignVendorSymbolIds(source)
  const root = rootOf(source)
  const objects = listFlatObjects(source)
  const removedRefs = new Set(plan.removeReferences)
  if (removedRefs.size !== plan.removeReferences.length || new Set(plan.removeUuids).size !== plan.removeUuids.length
    || new Set(plan.removeTextUuids).size !== plan.removeTextUuids.length) throw new Error('duplicate deletion selector')
  const selected = new Set<Form>()
  for (const ref of removedRefs) {
    const matches = children(root, 'symbol').filter(item => reference(item) === ref)
    if (matches.length === 0) throw new Error(`reference not found: ${ref}`)
    for (const match of matches) selected.add(match)
  }
  for (const uuid of plan.removeUuids) {
    const matches = root.items.filter((item): item is Form => typeof item !== 'string'
      && objects.some(object => object.uuid === uuid && object.type === item.head) && children(item, 'uuid').some(field => value(field) === uuid))
    if (matches.length !== 1) throw new Error(`editable UUID must match one object: ${uuid}`)
    selected.add(matches[0]!)
  }
  for (const uuid of plan.removeTextUuids) {
    const matches = root.items.filter((item): item is Form => typeof item !== 'string'
      && ['text', 'text_box'].includes(item.head) && id(item) === uuid)
    if (matches.length !== 1) throw new Error(`removeTextUuids must select one top-level text or text_box object: ${uuid}; electrical labels and symbol properties cannot be removed as annotations`)
    selected.add(matches[0]!)
  }
  const edits: TextEdit[] = [...selected].map(form => deleteForm(source, form))
  const changed = new Set<string>()
  for (const change of plan.setValues) {
    if (changed.has(change.reference)) throw new Error(`duplicate value change: ${change.reference}`)
    changed.add(change.reference)
    const matches = children(root, 'symbol').filter(item => reference(item) === change.reference && !selected.has(item))
    if (matches.length === 0) throw new Error(`retained reference not found: ${change.reference}`)
    for (const form of matches) edits.push(replaceAtom(source, property(form, 'Value'), 2, quote(change.value)))
  }
  const labelIds = new Set<string>()
  for (const change of plan.setLabels) {
    if (labelIds.has(change.uuid)) throw new Error(`duplicate label change: ${change.uuid}`)
    labelIds.add(change.uuid)
    const forms = root.items.filter((item): item is Form => typeof item !== 'string'
      && ['label', 'global_label', 'hierarchical_label'].includes(item.head) && id(item) === change.uuid && !selected.has(item))
    if (forms.length !== 1) throw new Error(`retained label not found: ${change.uuid}`)
    const form = forms[0]!
    if (change.name !== undefined) edits.push(replaceAtom(source, form, 1, quote(change.name)))
    if (change.at !== undefined || change.angle !== undefined) {
      const old = required(form, 'at')
      const at = change.at ?? point(old)
      edits.push({ start: old.start, end: old.end, text: `(at ${at[0]} ${at[1]} ${change.angle ?? Number(value(old, 3))})` })
    }
  }
  const additions: string[] = []
  let segments = 0
  for (const wire of plan.addWires) {
    const points = [endpoint(root, wire.from, selected), ...wire.via, endpoint(root, wire.to, selected)]
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1]!, to = points[index]!
      if ((from[0] !== to[0] && from[1] !== to[1]) || (from[0] === to[0] && from[1] === to[1])) throw new Error('wire paths must use nonzero orthogonal segments; supply explicit via points')
      additions.push(`(wire (pts (xy ${from[0]} ${from[1]}) (xy ${to[0]} ${to[1]})) (stroke (width ${templates.style.wireWidth}) (type default)) (uuid ${quote(randomUUID())}))`)
      segments++
    }
  }
  let layoutObjects: FlatObject[] = []
  if (plan.frames.some(frame => frame.autoBounds)) {
    const layoutSource = applyEdits(source, [...edits, ...(additions.length === 0 ? [] :
      [{ start: root.end - 1, end: root.end - 1, text: `\n${additions.join('\n')}\n` }])])
    layoutObjects = listFlatObjects(layoutSource, templates.style)
  }
  const resolvedFrames = plan.frames.map(frame => resolveFrame(frame, layoutObjects, templates))
  for (const frame of resolvedFrames) {
    const [x1, y1] = frame.start, [x2, y2] = frame.end
    const lines = frame.description.split('\n').length
    if (x2 <= x1 + templates.style.inset * 2 || y2 <= y1 + templates.style.titleOffset + templates.style.descriptionBottom + lines * templates.style.lineHeight) {
      throw new Error(`module frame ${frame.name} is too small for its title and explanation`)
    }
    const tokens: Record<string, string> = { X1: String(x1), Y1: String(y1), X2: String(x2), Y2: String(y2),
      FRAME_UUID: quote(randomUUID()), TITLE: quote(frame.name), TITLE_X: String(x1 + templates.style.inset),
      TITLE_Y: String(y1 + templates.style.titleOffset), TITLE_UUID: quote(randomUUID()),
      DESCRIPTION: quote(frame.description), DESCRIPTION_X: String(x1 + templates.style.inset),
      DESCRIPTION_Y: String(y2 - templates.style.descriptionBottom - (lines - 1) * templates.style.lineHeight), DESCRIPTION_UUID: quote(randomUUID()) }
    additions.push(templates.frame.replace(/\{\{([A-Z_0-9]+)\}\}/gu, (_all, token: string) => {
      if (tokens[token] === undefined) throw new Error(`unknown frame template token: ${token}`)
      return tokens[token]!
    }))
  }
  const rootUuid = randomUUID()
  const oldRoot = required(root, 'uuid')
  edits.push({ start: oldRoot.start, end: oldRoot.end, text: `(uuid ${quote(rootUuid)})` })
  const instanceKeys = new Set<string>()
  for (const symbol of children(root, 'symbol').filter(item => !selected.has(item))) {
    const ref = reference(symbol), unit = value(required(symbol, 'unit'))
    if (!/^\d+$/u.test(unit) || instanceKeys.has(`${ref}:${unit}`)) throw new Error(`duplicate or invalid symbol instance ${ref}:${unit}`)
    instanceKeys.add(`${ref}:${unit}`)
    for (const libName of children(symbol, 'lib_name')) edits.push(deleteForm(source, libName))
    const libId = value(required(symbol, 'lib_id'))
    if (children(required(root, 'lib_symbols'), 'symbol').filter(item => value(item) === libId).length !== 1) throw new Error(`retained symbol cache must uniquely match ${libId}`)
    const instances = children(symbol, 'instances')
    const next = `(instances (project ${quote(projectName)} (path ${quote(`/${rootUuid}`)} (reference ${quote(ref)}) (unit ${unit}))))`
    if (instances.length > 1) throw new Error(`multiple instance blocks in ${ref}`)
    if (instances[0]) edits.push({ start: instances[0].start, end: instances[0].end, text: next })
    else edits.push({ start: symbol.end - 1, end: symbol.end - 1, text: ` ${next}` })
  }
  if (additions.length > 0) edits.push({ start: root.end - 1, end: root.end - 1, text: `\n${additions.join('\n')}\n` })
  const schematic = applyEdits(source, edits)
  validatePreviewSchematic(schematic, projectName)
  const project = structuredClone(templates.project)
  project.meta.filename = `${projectName}.kicad_pro`
  return { schematic, project: `${JSON.stringify(project, null, 2)}\n`, resolvedFrames, changes: { removedObjects: selected.size,
    changedValues: changed.size, changedLabels: labelIds.size, addedWireSegments: segments, addedFrames: plan.frames.length } }
}
