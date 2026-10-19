/** Turn an edited module sheet into a project-owned KiCad child sheet and root. */
import { randomUUID } from 'node:crypto'
import type { Point } from './edit.ts'
import { applyEdits, children, deleteForm, parse, quote, required, value, type Form, type TextEdit } from './sexpr.ts'

/** External labels the caller expects after editing; extra labels are a plan error. */
export interface Port { name: string; direction: 'input' | 'output' | 'bidirectional' | 'passive' }

/** Text files to publish together in a fresh existing project directory. */
export interface ProjectFiles {
  root: string
  child: string
  symbolLibrary: string
  symbolTable: string
  project: string
  references: string[]
  ports: Port[]
  importedProjectSettings: string[]
  droppedSourceErcExclusions: number
}

/** Safe settings selected from an optional downloaded KiCad project. */
export interface ImportedProjectSettings {
  ercSeverities?: Record<string, string>
  schematic?: Record<string, unknown>
  textVariables?: Record<string, string>
  imported: string[]
  droppedErcExclusions: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function finiteNumber(source: Record<string, unknown>, key: string, target: Record<string, unknown>): void {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value
}

function booleanValue(source: Record<string, unknown>, key: string, target: Record<string, unknown>): void {
  const value = source[key]
  if (typeof value === 'boolean') target[key] = value
}

function stringValue(source: Record<string, unknown>, key: string, target: Record<string, unknown>): void {
  const value = source[key]
  if (typeof value === 'string') target[key] = value
}

/** Select path-free schematic preferences from an untrusted source project JSON document. */
export function importProjectSettings(text: string): ImportedProjectSettings {
  const parsed: unknown = JSON.parse(text)
  const root = record(parsed)
  if (root === undefined) throw new Error('sourceProjectPath must contain a KiCad project JSON object')
  const imported: string[] = []
  const erc = record(root.erc)
  const sourceSeverities = record(erc?.severities)
  let ercSeverities: Record<string, string> | undefined
  if (sourceSeverities !== undefined) {
    const selected: Record<string, string> = {}
    for (const [key, value] of Object.entries(sourceSeverities)) {
      if (!/^[a-z][a-z0-9_]*$/u.test(key) || !['error', 'warning', 'ignore'].includes(String(value))) {
        throw new Error('source project has an invalid ERC severity entry')
      }
      selected[key] = String(value)
    }
    if (Object.keys(selected).length > 0) {
      ercSeverities = selected
      imported.push('erc.severities')
    }
  }
  const sourceSchematic = record(root.schematic)
  const schematic: Record<string, unknown> = {}
  if (sourceSchematic !== undefined) {
    finiteNumber(sourceSchematic, 'annotate_start_num', schematic)
    finiteNumber(sourceSchematic, 'subpart_first_id', schematic)
    finiteNumber(sourceSchematic, 'subpart_id_separator', schematic)
    const sourceDrawing = record(sourceSchematic.drawing)
    if (sourceDrawing !== undefined) {
      const drawing: Record<string, unknown> = {}
      for (const key of ['dashed_lines_dash_length_ratio', 'dashed_lines_gap_length_ratio',
        'default_line_thickness', 'default_text_size', 'junction_size_choice', 'label_size_ratio',
        'pin_symbol_size', 'text_offset_ratio']) finiteNumber(sourceDrawing, key, drawing)
      for (const key of ['intersheets_ref_own_page', 'intersheets_ref_short',
        'intersheets_ref_show']) booleanValue(sourceDrawing, key, drawing)
      for (const key of ['intersheets_ref_prefix', 'intersheets_ref_suffix']) stringValue(sourceDrawing, key, drawing)
      if (Object.keys(drawing).length > 0) schematic.drawing = drawing
    }
  }
  if (Object.keys(schematic).length > 0) imported.push('schematic.drawing-and-annotation')
  const sourceVariables = record(root.text_variables)
  let textVariables: Record<string, string> | undefined
  if (sourceVariables !== undefined) {
    const selected: Record<string, string> = {}
    for (const [key, value] of Object.entries(sourceVariables)) {
      if (typeof value !== 'string') throw new Error('source project text_variables values must be strings')
      selected[key] = value
    }
    if (Object.keys(selected).length > 0) {
      textVariables = selected
      imported.push('text_variables')
    }
  }
  return {
    ...(ercSeverities === undefined ? {} : { ercSeverities }),
    ...(Object.keys(schematic).length === 0 ? {} : { schematic }),
    ...(textVariables === undefined ? {} : { textVariables }),
    imported,
    droppedErcExclusions: Array.isArray(erc?.erc_exclusions) ? erc.erc_exclusions.length : 0,
  }
}

function renameHead(raw: string, oldName: string, newName: string): string {
  const start = raw.indexOf(quote(oldName), '(symbol'.length)
  if (!raw.startsWith('(symbol') || start < 0 || start > 32) {
    throw new Error(`cannot rename cached symbol ${oldName}`)
  }
  return raw.slice(0, start) + quote(newName) + raw.slice(start + quote(oldName).length)
}

/** Align uniquely identified vendor cache names without changing symbol pins or graphics.
 * @param source Schematic text whose numbered vendor caches may differ from instance IDs.
 * @returns Text with consistent IDs; throws for absent, ambiguous, or incompatible definitions.
 */
export function alignVendorSymbolIds(source: string): string {
  const root = parse(source)
  const cached = required(root, 'lib_symbols')
  const cacheMap = new Map(children(cached, 'symbol').map(form => [value(form), form]))
  const edits: TextEdit[] = []
  const renamedCache = new Map<string, string>()
  for (const symbol of children(root, 'symbol')) {
    const id = required(symbol, 'lib_id')
    const used = value(id)
    if (cacheMap.has(used)) continue
    const split = used.indexOf(':')
    if (split < 1 || split === used.length - 1) throw new Error(`symbol instance has no library nickname: ${used}`)
    const nickname = used.slice(0, split)
    const short = used.slice(split + 1)
    const libName = children(symbol, 'lib_name')[0]
    const hinted = libName === undefined ? undefined : value(libName)
    const matches = [...cacheMap.keys()].filter(candidate => {
      const candidateShort = candidate.slice(candidate.indexOf(':') + 1)
      return /^_[1-9][0-9]*$/u.test(candidateShort.slice(short.length))
        && candidateShort.startsWith(short)
        && (candidate.startsWith(`${nickname}:`) || (candidate === candidateShort && hinted === candidate))
    })
    if (matches.length !== 1) {
      throw new Error(`symbol cache lacks used lib_id: ${used}; matching suffixed definitions: ${JSON.stringify(matches)}`)
    }
    const matched = matches[0]!
    const definition = cacheMap.get(matched)!
    const qualified = matched.includes(':') ? matched : `${nickname}:${matched}`
    if (matched !== qualified && cacheMap.has(qualified)) {
      throw new Error(`symbol cache has conflicting definitions for ${qualified}`)
    }
    const innerNames = children(definition, 'symbol').map(form => value(form))
    const innerMatches = (outerId: string): boolean => {
      const short = outerId.slice(outerId.indexOf(':') + 1)
      return innerNames.length > 0 && innerNames.every(name =>
        name.startsWith(`${short}_`) && /^_[0-9]+_[0-9]+$/u.test(name.slice(short.length)))
    }
    if (innerMatches(qualified)) {
      edits.push({ start: id.start, end: id.end, text: `(lib_id ${quote(qualified)})` })
      const previous = renamedCache.get(matched)
      if (previous !== undefined && previous !== qualified) {
        throw new Error(`symbol cache ${matched} is claimed by ${previous} and ${qualified}`)
      }
      if (matched !== qualified && !renamedCache.has(matched)) {
        const raw = source.slice(definition.start, definition.end)
        edits.push({ start: definition.start, end: definition.end, text: renameHead(raw, matched, qualified) })
        renamedCache.set(matched, qualified)
      }
    } else if (innerMatches(used) && !children(root, 'symbol').some(instance =>
      value(required(instance, 'lib_id')) === qualified)) {
      const previous = renamedCache.get(matched)
      if (previous !== undefined && previous !== used) {
        throw new Error(`symbol cache ${matched} is claimed by ${previous} and ${used}`)
      }
      if (!renamedCache.has(matched)) {
        const raw = source.slice(definition.start, definition.end)
        edits.push({ start: definition.start, end: definition.end, text: renameHead(raw, matched, used) })
        renamedCache.set(matched, used)
      }
    } else {
      throw new Error(`symbol cache ${matched} has internal names incompatible with ${used}; inspect the source symbol definition`)
    }
  }
  return edits.length === 0 ? source : applyEdits(source, edits)
}

function symbolReference(form: Form): string {
  const property = children(form, 'property').find(item => value(item) === 'Reference')
  if (property === undefined) throw new Error('symbol has no Reference property')
  return value(property, 2)
}

function portLabels(root: Form): Port[] {
  const ports = new Map<string, Port['direction']>()
  for (const form of children(root, 'hierarchical_label')) {
    const name = value(form)
    const direction = value(required(form, 'shape'))
    if (!['input', 'output', 'bidirectional', 'passive'].includes(direction)) {
      throw new Error(`unsupported hierarchy label direction: ${name} (${direction})`)
    }
    const old = ports.get(name)
    if (old !== undefined && old !== direction) throw new Error(`conflicting hierarchy label directions: ${name}`)
    ports.set(name, direction as Port['direction'])
  }
  return [...ports].map(([name, direction]) => ({ name, direction }))
}

function powerFlagSymbol(powerLibrary: string): string {
  const root = parse(powerLibrary)
  if (root.head !== 'kicad_symbol_lib') throw new Error('configured power library is not a KiCad symbol library')
  const symbol = children(root, 'symbol').find(form => value(form) === 'PWR_FLAG')
  if (symbol === undefined) throw new Error('configured power library lacks PWR_FLAG')
  return powerLibrary.slice(symbol.start, symbol.end)
}

function globalLabel(port: Port, x: number, y: number, angle: number): string {
  const justify = angle === 180 ? 'right' : 'left'
  return `(global_label ${quote(port.name)} (shape ${port.direction}) (at ${x} ${y} ${angle}) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid "${randomUUID()}"))`
}

function wire(x1: number, y1: number, x2: number, y2: number): string {
  return `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0) (type default)) (uuid "${randomUUID()}"))`
}

function flagInstance(projectName: string, path: string, ref: string, x: number, y: number): string {
  return `(symbol (lib_id ${quote(`${projectName}:PWR_FLAG`)}) (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${randomUUID()}") (property "Reference" ${quote(ref)} (at ${x} ${y + 2.54} 0) (effects (font (size 1.27 1.27)) (hide yes))) (property "Value" "PWR_FLAG" (at ${x} ${y - 3.81} 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "${randomUUID()}")) (instances (project ${quote(projectName)} (path ${quote(path)} (reference ${quote(ref)}) (unit 1)))))`
}

function wireEndpoints(root: Form): Set<string> {
  const endpoints = new Set<string>()
  for (const form of children(root, 'wire')) {
    const points = children(required(form, 'pts'), 'xy')
    if (points.length !== 2) throw new Error('wire must contain exactly two endpoints')
    for (const point of points) endpoints.add(`${Number(value(point, 1))},${Number(value(point, 2))}`)
  }
  return endpoints
}

function childFlagForms(
  sourceRoot: Form, projectName: string, path: string,
  flags: Array<{ connectAt: Point; symbolAt: Point }>, firstNumber: number,
): string[] {
  const endpoints = wireEndpoints(sourceRoot)
  const forms: string[] = []
  const occupied = new Set<string>()
  for (const [index, flag] of flags.entries()) {
    const [x, y] = flag.connectAt
    const [fx, fy] = flag.symbolAt
    const connection = `${x},${y}`
    if (!endpoints.has(connection)) {
      throw new Error(`childPowerFlags[${index}].connectAt must match an edited child wire endpoint`)
    }
    if (occupied.has(connection)) throw new Error('childPowerFlags contains duplicate connection points')
    if (x !== fx && y !== fy) throw new Error(`childPowerFlags[${index}] requires a horizontal or vertical connection`)
    occupied.add(connection)
    if (x !== fx || y !== fy) forms.push(wire(x, y, fx, fy))
    forms.push(flagInstance(projectName, path, `#FLG0${firstNumber + index}`, fx, fy))
  }
  return forms
}

function buildRoot(
  projectName: string, sheetName: string, childFile: string,
  rootUuid: string, sheetUuid: string, ports: Port[], drivenInputs: string[],
  flagCache: string | undefined, firstFlagNumber: number,
): string {
  const sx = 101.6; const sy = 76.2; const sw = 50.8
  const left = ports.filter(port => port.direction !== 'output')
  const right = ports.filter(port => port.direction === 'output')
  const rows = Math.max(left.length, right.length, 2)
  const sh = Math.max(25.4, (rows + 2) * 5.08)
  const bodies: string[] = []
  const pins: string[] = []
  let flagNumber = firstFlagNumber
  for (const [side, group] of [['left', left], ['right', right]] as const) {
    for (const [index, port] of group.entries()) {
      const y = sy + 5.08 * (index + 1)
      const x = side === 'left' ? sx : sx + sw
      const end = side === 'left' ? sx - 7.62 : sx + sw + 7.62
      const angle = side === 'left' ? 180 : 0
      bodies.push(wire(x, y, end, y), globalLabel(port, end, y, angle))
      pins.push(`(pin ${quote(port.name)} ${port.direction} (at ${x} ${y} ${angle}) (uuid "${randomUUID()}") (effects (font (size 1.27 1.27)) (justify ${side === 'left' ? 'left' : 'right'})))`)
      if (drivenInputs.includes(port.name)) {
        const tap = sx - 3.81
        const flagY = y - 2.54
        bodies.push(wire(tap, y, tap, flagY), `(junction (at ${tap} ${y}) (diameter 0) (color 0 0 0 0) (uuid "${randomUUID()}"))`)
        bodies.push(flagInstance(projectName, `/${rootUuid}`, `#FLG0${++flagNumber}`, tap, flagY))
      }
    }
  }
  const rootCache = flagCache ?? ''
  return `(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (generator_version "10.0")
  (uuid "${rootUuid}")
  (paper "A4")
  (title_block (title ${quote(sheetName)}))
  (lib_symbols ${rootCache})
  ${bodies.join('\n  ')}
  (sheet (at ${sx} ${sy}) (size ${sw} ${sh}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid "${sheetUuid}")
    (property "Sheetname" ${quote(sheetName)} (at ${sx} ${sy - 1.27} 0) (effects (font (size 1.27 1.27))))
    (property "Sheetfile" ${quote(childFile)} (at ${sx} ${sy + sh + 1.27} 0) (effects (font (size 1.27 1.27))))
    ${pins.join('\n    ')}
    (instances (project ${quote(projectName)} (path "/${rootUuid}" (page "2")))))
  (sheet_instances (path "/" (page "1")))
)
`
}

/** Build a project without consulting or modifying PCB footprints. */
export function buildProject(
  edited: string, projectName: string, sheetName: string,
  expectedPorts: Port[], drivenInputs: string[], powerLibrary?: string, sourceProjectText?: string,
  childPowerFlags: Array<{ connectAt: Point; symbolAt: Point }> = [],
): ProjectFiles {
  edited = alignVendorSymbolIds(edited)
  const sourceRoot = parse(edited)
  if (sourceRoot.head !== 'kicad_sch') throw new Error('edited source is not a KiCad schematic')
  if (children(sourceRoot, 'sheet').length > 0) {
    throw new Error('source module contains child sheets; project assembly requires a single-sheet source')
  }
  const ports = portLabels(sourceRoot)
  const actual = new Map(ports.map(port => [port.name, port.direction]))
  if (new Set(expectedPorts.map(port => port.name)).size !== expectedPorts.length) {
    throw new Error('expectedPorts contains duplicate names')
  }
  if (actual.size === 0 || actual.size !== expectedPorts.length
    || expectedPorts.some(port => actual.get(port.name) !== port.direction)) {
    const expected = new Map(expectedPorts.map(port => [port.name, port.direction]))
    const missing = expectedPorts.filter(port => !actual.has(port.name))
    const unlisted = ports.filter(port => !expected.has(port.name))
    const mismatched = expectedPorts.filter(port => actual.has(port.name) && actual.get(port.name) !== port.direction)
    const details = [
      missing.length > 0 ? `expected but absent from edited sheet: ${JSON.stringify(missing)}` : undefined,
      unlisted.length > 0 ? `edited labels absent from expectedPorts: ${JSON.stringify(unlisted)}` : undefined,
      mismatched.length > 0 ? `direction mismatches (expected -> edited): ${mismatched.map(port =>
        `${JSON.stringify(port.name)} ${port.direction} -> ${actual.get(port.name)}`).join(', ')}` : undefined,
      actual.size === 0 ? 'edited sheet has no hierarchical labels' : undefined,
    ].filter((detail): detail is string => detail !== undefined)
    throw new Error(`hierarchy labels do not match expectedPorts: ${details.join('; ')}. `
      + 'expectedPorts must list every edited hierarchical label with its actual direction; inspect or explicitly edit the labels before retrying.')
  }
  if (new Set(drivenInputs).size !== drivenInputs.length
    || drivenInputs.some(name => actual.get(name) !== 'input')) {
    throw new Error('drivenInputs must name distinct input hierarchy labels')
  }

  const cached = required(sourceRoot, 'lib_symbols')
  const symbols = children(sourceRoot, 'symbol')
  const used = new Set(symbols.map(form => value(required(form, 'lib_id'))))
  const cacheMap = new Map(children(cached, 'symbol').map(form => [value(form), form]))
  if (cacheMap.size !== children(cached, 'symbol').length) throw new Error('duplicate cached symbol IDs')
  for (const id of used) if (!cacheMap.has(id)) throw new Error(`symbol cache lacks used lib_id: ${id}`)

  const shortNames = new Map<string, string>()
  for (const id of used) {
    const split = id.indexOf(':')
    if (split < 1 || split === id.length - 1) throw new Error(`cached symbol has no library nickname: ${id}`)
    const short = id.slice(split + 1)
    const old = shortNames.get(short)
    if (old !== undefined && old !== id) throw new Error(`cached symbols collide at ${short}`)
    shortNames.set(short, id)
  }

  const rootUuid = randomUUID(); const sheetUuid = randomUUID()
  const existingFlagNumbers = [...symbols].map(symbolReference)
    .map(ref => /^#FLG0(\d+)$/u.exec(ref)?.[1]).filter((number): number is string => number !== undefined)
    .map(Number)
  const firstFlagNumber = Math.max(0, ...existingFlagNumbers)
  const edits: TextEdit[] = []
  const references: string[] = []
  for (const form of symbols) {
    const oldId = value(required(form, 'lib_id'))
    const short = oldId.slice(oldId.indexOf(':') + 1)
    const id = required(form, 'lib_id')
    edits.push({ start: id.start, end: id.end, text: `(lib_id ${quote(`${projectName}:${short}`)})` })
    for (const libName of children(form, 'lib_name')) edits.push(deleteForm(edited, libName))
    const ref = symbolReference(form)
    references.push(ref)
    const unit = value(required(form, 'unit'))
    const instance = `(instances (project ${quote(projectName)} (path "/${rootUuid}/${sheetUuid}" (reference ${quote(ref)}) (unit ${unit}))))`
    const old = children(form, 'instances')
    if (old.length !== 1) throw new Error(`symbol ${ref} must have one instances block`)
    edits.push({ start: old[0]!.start, end: old[0]!.end, text: instance })
  }
  const libraryBlocks: string[] = []
  for (const form of children(cached, 'symbol')) {
    const id = value(form)
    if (!used.has(id)) {
      edits.push(deleteForm(edited, form))
      continue
    }
    const short = id.slice(id.indexOf(':') + 1)
    const raw = edited.slice(form.start, form.end)
    edits.push({ start: form.start, end: form.end, text: renameHead(raw, id, `${projectName}:${short}`) })
    libraryBlocks.push(renameHead(raw, id, short))
  }
  for (const form of children(sourceRoot, 'sheet_instances')) edits.push(deleteForm(edited, form))
  for (const form of children(sourceRoot, 'title_block')) edits.push(deleteForm(edited, form))
  const childForms = childFlagForms(sourceRoot, projectName, `/${rootUuid}/${sheetUuid}`,
    childPowerFlags, firstFlagNumber + drivenInputs.length + 1)
  edits.push({ start: sourceRoot.end - 1, end: sourceRoot.end - 1,
    text: `\n  (title_block (title ${quote(sheetName)}))\n  ${childForms.join('\n  ')}\n` })
  const existingFlag = shortNames.get('PWR_FLAG')
  if ((drivenInputs.length > 0 || childPowerFlags.length > 0)
    && existingFlag !== undefined && existingFlag !== 'power:PWR_FLAG') {
    throw new Error('source PWR_FLAG nickname is not from the KiCad power library')
  }
  const flagCache = drivenInputs.length > 0 || childPowerFlags.length > 0
    ? existingFlag === undefined ? powerFlagSymbol(powerLibrary ?? '')
      : edited.slice(cacheMap.get(existingFlag)!.start, cacheMap.get(existingFlag)!.end)
    : undefined
  const renamedFlagCache = flagCache === undefined ? undefined
    : renameHead(flagCache, existingFlag ?? 'PWR_FLAG', `${projectName}:PWR_FLAG`)
  if (childPowerFlags.length > 0 && existingFlag === undefined) {
    edits.push({ start: cached.end - 1, end: cached.end - 1, text: `\n    ${renamedFlagCache}\n  ` })
  }
  const child = applyEdits(edited, edits)
  parse(child)

  if (flagCache !== undefined && existingFlag === undefined) libraryBlocks.push(flagCache)
  const symbolLibrary = `(kicad_symbol_lib\n  (version 20251024)\n  (generator "kicad_symbol_editor")\n  (generator_version "10.0")\n  ${libraryBlocks.join('\n  ')}\n)\n`
  const symbolTable = `(sym_lib_table\n  (version 7)\n  (lib (name ${quote(projectName)})(type "KiCad")(uri "\${KIPRJMOD}/${projectName}.kicad_sym")(options "")(descr ""))\n)\n`
  const childFile = `${projectName}_module.kicad_sch`
  const root = buildRoot(projectName, sheetName, childFile, rootUuid, sheetUuid, ports, drivenInputs,
    drivenInputs.length > 0 ? renamedFlagCache : undefined, firstFlagNumber)
  parse(root); parse(symbolLibrary); parse(symbolTable)
  const imported: ImportedProjectSettings = sourceProjectText === undefined
    ? { imported: [], droppedErcExclusions: 0 } satisfies ImportedProjectSettings
    : importProjectSettings(sourceProjectText)
  const project = JSON.stringify({
    board: { design_settings: {}, layer_presets: [], viewports: [] },
    ...(imported.ercSeverities === undefined ? {} : { erc: {
      erc_exclusions: [], meta: { version: 0 }, pin_map: [], severities: imported.ercSeverities,
    } }),
    libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
    meta: { filename: `${projectName}.kicad_pro`, version: 1 },
    net_settings: { classes: [{ name: 'Default', clearance: 0.2, track_width: 0.25,
      via_diameter: 0.6, via_drill: 0.3, wire_width: 6 }] },
    pcbnew: { last_paths: {}, page_layout_descr_file: '' },
    schematic: { legacy_lib_dir: '', legacy_lib_list: [], ...imported.schematic },
    sheets: [], text_variables: {},
    ...(imported.textVariables === undefined ? {} : { text_variables: imported.textVariables }),
  }, null, 2) + '\n'
  return { root, child, symbolLibrary, symbolTable, project, references, ports,
    importedProjectSettings: imported.imported,
    droppedSourceErcExclusions: imported.droppedErcExclusions }
}
