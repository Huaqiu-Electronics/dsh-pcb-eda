/** Combine single-sheet modules with hierarchy ports into one KiCad project without editing the sources. */
import { randomUUID } from 'node:crypto'
import { applyEdits, children, parse, quote, required, value, type Form, type TextEdit } from './sexpr.ts'
import { buildProject, type Port } from './project.ts'
import { readModulePorts, type DirectionConflict } from './ports.ts'

/** An explicit connection from one child port to a root net. */
export interface PortConnection { port: string; net: string }
/** One source module instance; each port is connected or explicitly unused. */
export interface AssemblySheet {
  name: string
  source: string
  connections: PortConnection[]
  unconnectedPorts?: string[]
}
/** Fresh project files and the reference mapping needed for netlist assertions. */
export interface AssemblyFiles {
  root: string
  children: Array<{ filename: string; text: string; name: string; references: Record<string, string>;
    directionConflicts: DirectionConflict[] }>
  symbolLibrary: string
  symbolTable: string
  project: string
  warnings: string[]
}

function comparableSymbol(raw: string): string {
  const normalize = (form: Form): unknown => form.items.filter(item =>
    typeof item === 'string' || item.head !== 'property' || value(item) !== 'Datasheet')
    .map(item => typeof item === 'string' ? item : normalize(item))
  return JSON.stringify(normalize(parse(raw)))
}

function symbolReference(form: Form): string {
  const property = children(form, 'property').find(item => value(item) === 'Reference')
  if (property === undefined) throw new Error('symbol has no Reference property')
  return value(property, 2)
}

function preparePorts(source: string): { ports: Port[]; directionConflicts: DirectionConflict[]; normalizedSource: string } {
  const root = parse(source)
  if (root.head !== 'kicad_sch' || children(root, 'sheet').length > 0) {
    throw new Error('assembly source must be a single-sheet .kicad_sch')
  }
  const { ports, directionConflicts } = readModulePorts(root)
  if (ports.length === 0) throw new Error('assembly source needs hierarchical labels')
  const edits = children(root, 'hierarchical_label').filter(label =>
    value(required(label, 'shape')) !== 'passive')
    .map(label => {
      const shape = required(label, 'shape')
      return { start: shape.start, end: shape.end, text: '(shape passive)' }
    })
  return { ports, directionConflicts,
    normalizedSource: edits.length === 0 ? source : applyEdits(source, edits) }
}

function referencePrefix(reference: string): string {
  const match = /^(#?[A-Za-z]+)\d+$/u.exec(reference)
  if (match === null) throw new Error(`unsupported reference for automatic annotation: ${reference}`)
  return match[1]!
}

function renumberChild(source: string, rootUuid: string, sheetUuid: string, projectName: string,
  counters: Map<string, number>): { text: string; references: Record<string, string> } {
  const root = parse(source)
  const edits: TextEdit[] = []
  const references: Record<string, string> = {}
  for (const symbol of children(root, 'symbol')) {
    const old = symbolReference(symbol)
    if (references[old] === undefined) {
      const prefix = referencePrefix(old)
      const number = (counters.get(prefix) ?? 0) + 1
      counters.set(prefix, number)
      references[old] = `${prefix}${number}`
    }
    const next = references[old]!
    const property = children(symbol, 'property').find(item => value(item) === 'Reference')!
    const rawProperty = source.slice(property.start, property.end)
    edits.push({ start: property.start, end: property.end,
      text: rawProperty.replace(quote(old), quote(next)) })
    const unit = value(required(symbol, 'unit'))
    const instance = required(symbol, 'instances')
    edits.push({ start: instance.start, end: instance.end,
      text: `(instances (project ${quote(projectName)} (path ${quote(`/${rootUuid}/${sheetUuid}`)} (reference ${quote(next)}) (unit ${unit}))))` })
  }
  const ownUuid = required(root, 'uuid')
  edits.push({ start: ownUuid.start, end: ownUuid.end, text: `(uuid ${quote(randomUUID())})` })
  let child = applyEdits(source, edits)
  // A repeated module needs distinct element identities on each copied sheet.
  child = child.replace(/\(uuid "[0-9a-f-]{36}"\)/giu, () => `(uuid ${quote(randomUUID())})`)
  parse(child)
  return { text: child, references }
}

function wire(x1: number, y: number, x2: number): string {
  return `(wire (pts (xy ${x1} ${y}) (xy ${x2} ${y})) (stroke (width 0) (type default)) (uuid ${quote(randomUUID())}))`
}

function splitPorts(sheet: { ports: Port[]; connections: PortConnection[] }): { left: Port[]; right: Port[] } {
  const netByPort = new Map(sheet.connections.map(connection => [connection.port, connection.net]))
  const power = sheet.ports.filter(port => /^(GND|VSS|VCC|VIN|VBAT|VDD|\+\d)/iu.test(netByPort.get(port.name) ?? port.name))
  const others = sheet.ports.filter(port => !power.includes(port))
  const leftCount = Math.max(Math.ceil(sheet.ports.length / 2), power.length)
  return { left: [...power, ...others.slice(0, leftCount - power.length)],
    right: others.slice(leftCount - power.length) }
}

function makeRoot(projectName: string, title: string, rootUuid: string,
  sheets: Array<{ name: string; filename: string; uuid: string; ports: Port[]; connections: PortConnection[] }>,
  drivenNets: string[], flagCache: string | undefined): string {
  const forms: string[] = []
  const pendingFlags = new Set(drivenNets)
  const layout = sheets.map(sheet => splitPorts(sheet))
  const heights = layout.map(({ left, right }) => {
    return Math.max(45.72, (Math.max(left.length, right.length, 2) + 2) * 7.62)
  })
  const rowStarts: number[] = []
  let nextRow = 30.48
  for (let row = 0; row < Math.ceil(sheets.length / 2); row++) {
    rowStarts.push(nextRow)
    nextRow += Math.max(...heights.slice(row * 2, row * 2 + 2)) + 20.32
  }
  const page = ([['A3', 297], ['A2', 420], ['A1', 594], ['A0', 841]] as const)
    .find(([, height]) => nextRow - 20.32 + 25.4 <= height)?.[0]
  if (page === undefined) throw new Error('hierarchy sheet ports exceed A0 page height')
  for (const [index, sheet] of sheets.entries()) {
    const sx = 63.5 + (index % 2) * 190.5
    const sy = rowStarts[Math.floor(index / 2)]!
    const sw = 114.3
    const { left, right } = layout[index]!
    const sh = heights[index]!
    const pins: string[] = []
    for (const [side, group] of [['left', left], ['right', right]] as const) {
      for (const [row, port] of group.entries()) {
        const x = side === 'left' ? sx : sx + sw
        const y = sy + (row + 1) * 7.62
        const end = side === 'left' ? x - 17.78 : x + 17.78
        const angle = side === 'left' ? 180 : 0
        const net = sheet.connections.find(connection => connection.port === port.name)?.net
        if (net === undefined) {
          forms.push(`(no_connect (at ${x} ${y}) (uuid ${quote(randomUUID())}))`)
          pins.push(`(pin ${quote(port.name)} ${port.direction} (at ${x} ${y} ${angle}) (uuid ${quote(randomUUID())}) (effects (font (size 1.27 1.27)) (justify ${side === 'left' ? 'left' : 'right'})))`)
          continue
        }
        forms.push(wire(x, y, end), `(global_label ${quote(net)} (shape ${port.direction}) (at ${end} ${y} ${angle}) (effects (font (size 1.27 1.27)) (justify ${side === 'left' ? 'right' : 'left'})) (uuid ${quote(randomUUID())}))`)
        if (pendingFlags.delete(net)) {
          const fx = side === 'left' ? x - 8.89 : x + 8.89
          const fy = y - 5.08
          forms.push(`(wire (pts (xy ${fx} ${y}) (xy ${fx} ${fy})) (stroke (width 0) (type default)) (uuid ${quote(randomUUID())}))`,
            `(junction (at ${fx} ${y}) (diameter 0) (color 0 0 0 0) (uuid ${quote(randomUUID())}))`,
            `(symbol (lib_id ${quote(`${projectName}:PWR_FLAG`)}) (at ${fx} ${fy} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
              (uuid ${quote(randomUUID())}) (property "Reference" ${quote(`#FLG0${drivenNets.indexOf(net) + 1}`)} (at ${fx} ${fy + 2.54} 0) (effects (font (size 1.27 1.27)) (hide yes)))
              (property "Value" "PWR_FLAG" (at ${fx} ${fy - 3.81} 0) (effects (font (size 1.27 1.27))))
              (pin "1" (uuid ${quote(randomUUID())})) (instances (project ${quote(projectName)} (path ${quote(`/${rootUuid}`)}
              (reference ${quote(`#FLG0${drivenNets.indexOf(net) + 1}`)}) (unit 1)))))`)
        }
        pins.push(`(pin ${quote(port.name)} ${port.direction} (at ${x} ${y} ${angle}) (uuid ${quote(randomUUID())}) (effects (font (size 1.27 1.27)) (justify ${side === 'left' ? 'left' : 'right'})))`)
      }
    }
    forms.push(`(sheet (at ${sx} ${sy}) (size ${sw} ${sh}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
      (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid ${quote(sheet.uuid)})
      (property "Sheetname" ${quote(sheet.name)} (at ${sx} ${sy - 1.27} 0) (effects (font (size 1.27 1.27))))
      (property "Sheetfile" ${quote(sheet.filename)} (at ${sx} ${sy + sh + 1.27} 0) (effects (font (size 1.27 1.27))))
      ${pins.join('\n      ')}
      (instances (project ${quote(projectName)} (path ${quote(`/${rootUuid}`)} (page ${quote(String(index + 2))})))))`)
  }
  const result = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "10.0")
    (uuid ${quote(rootUuid)}) (paper ${quote(page)}) (title_block (title ${quote(title)})) (lib_symbols ${flagCache ?? ''})
    ${forms.join('\n    ')}
    (sheet_instances (path "/" (page "1"))))\n`
  parse(result)
  return result
}

/** Validate explicit port mappings, reannotate copied children, and build a new multi-sheet project. */
export function buildAssembly(projectName: string, title: string, sheets: AssemblySheet[],
  sourceProjectText?: string, drivenNets: string[] = [], powerLibrary?: string): AssemblyFiles {
  if (sheets.length < 1 || sheets.length > 9) throw new Error('hierarchy needs 1 to 9 child sheets')
  if (new Set(sheets.map(sheet => sheet.name)).size !== sheets.length) throw new Error('sheet names must be unique')
  if (new Set(drivenNets).size !== drivenNets.length) throw new Error('drivenNets contains duplicates')
  const problems: string[] = []
  const prepared: Array<{ sheet: AssemblySheet; ports: Port[]; directionConflicts: DirectionConflict[];
    staged: ReturnType<typeof buildProject> }> = []
  const warnings: string[] = []
  const symbolOwners = new Map<string, string>()
  const library = new Map<string, string>()
  for (const [index, sheet] of sheets.entries()) {
    let preparedPorts: ReturnType<typeof preparePorts>
    try { preparedPorts = preparePorts(sheet.source) } catch (error) {
      problems.push(`${sheet.name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const actualPorts = preparedPorts.ports
    const portNames = new Set(actualPorts.map(port => port.name))
    const mapped = new Map<string, string>()
    const duplicates = new Set<string>()
    for (const connection of sheet.connections) {
      if (mapped.has(connection.port)) duplicates.add(connection.port)
      mapped.set(connection.port, connection.net)
    }
    const unconnected = sheet.unconnectedPorts ?? []
    const unused = new Set(unconnected)
    const missing = actualPorts.filter(port => !mapped.has(port.name) && !unused.has(port.name)).map(port => port.name)
    const unknown = [...mapped.keys()].filter(port => !portNames.has(port))
    const unknownUnused = [...unused].filter(port => !portNames.has(port))
    const overlap = [...unused].filter(port => mapped.has(port))
    const emptyNets = sheet.connections.filter(connection => !connection.net.trim()).map(connection => connection.port)
    const details = [
      missing.length > 0 ? `unmapped child ports ${JSON.stringify(missing)}` : undefined,
      unknown.length > 0 ? `unknown child ports ${JSON.stringify(unknown)}` : undefined,
      unknownUnused.length > 0 ? `unknown unconnected ports ${JSON.stringify(unknownUnused)}` : undefined,
      duplicates.size > 0 ? `duplicate connections ${JSON.stringify([...duplicates])}` : undefined,
      unconnected.length !== unused.size ? 'duplicate unconnected ports' : undefined,
      overlap.length > 0 ? `ports both connected and unconnected ${JSON.stringify(overlap)}` : undefined,
      emptyNets.length > 0 ? `ports with empty net names ${JSON.stringify(emptyNets)}` : undefined,
    ].filter((detail): detail is string => detail !== undefined)
    if (details.length > 0) problems.push(`${sheet.name}: connections do not match child hierarchy ports: ${details.join('; ')}`)
    try {
      const staged = buildProject(preparedPorts.normalizedSource, projectName, sheet.name, actualPorts, [], undefined,
        index === 0 ? sourceProjectText : undefined)
      prepared.push({ sheet, ports: actualPorts, directionConflicts: preparedPorts.directionConflicts, staged })
      const stagedLibrary = parse(staged.symbolLibrary)
      for (const symbol of children(stagedLibrary, 'symbol')) {
        const id = value(symbol)
        const raw = staged.symbolLibrary.slice(symbol.start, symbol.end)
        const previous = library.get(id)
        if (previous !== undefined && previous !== raw) {
          if (comparableSymbol(previous) === comparableSymbol(raw)) {
            warnings.push(`${sheet.name}: merged symbol ${id} with ${symbolOwners.get(id)}; only Datasheet or formatting differs; retained the first library definition.`)
          } else {
            const previousForm = parse(previous)
            const changed = symbol.items.filter((item): item is Form => typeof item !== 'string')
              .filter(item => !children(previousForm, item.head).some(old =>
                JSON.stringify(old.items, (key, entry) => key === 'start' || key === 'end' ? undefined : entry)
                === JSON.stringify(item.items, (key, entry) => key === 'start' || key === 'end' ? undefined : entry)))
              .map(item => item.head === 'property' ? `property ${value(item)}` : item.head)
            problems.push(`${sheet.name}: conflicting project-local symbol definition: ${id}; previous module ${symbolOwners.get(id)}; differing fields ${JSON.stringify([...new Set(changed)])}; choose a consistent symbol or rename the conflicting definition and its lib_id in an editable copy.`)
          }
        } else { library.set(id, raw); symbolOwners.set(id, sheet.name) }
      }
    } catch (error) {
      problems.push(`${sheet.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`hierarchy preflight failed; no files were written:\n- ${problems.join('\n- ')}\n`
      + 'code=HIERARCHY_PREFLIGHT_FAILED; filesWritten=false; retryUnchanged=false. Fix only the listed port or symbol differences, then retry. Source files are unchanged.')
  }
  const rootUuid = randomUUID()
  const counters = new Map<string, number>()
  const childFiles: AssemblyFiles['children'] = []
  const rootSheets: Array<{ name: string; filename: string; uuid: string; ports: Port[]; connections: PortConnection[] }> = []
  for (const [index, { sheet, ports: actualPorts, directionConflicts, staged }] of prepared.entries()) {
    const sheetUuid = randomUUID()
    const child = renumberChild(staged.child, rootUuid, sheetUuid, projectName, counters)
    const filename = `schematic/${projectName}_sheet_${index + 1}.kicad_sch`
    childFiles.push({ filename, text: child.text, name: sheet.name, references: child.references,
      directionConflicts })
    rootSheets.push({ name: sheet.name, filename, uuid: sheetUuid, ports: actualPorts, connections: sheet.connections })
  }
  const connectedNets = new Set(sheets.flatMap(sheet => sheet.connections.map(connection => connection.net)))
  if (drivenNets.some(net => !connectedNets.has(net))) throw new Error('drivenNets must name connected root nets')
  let flagCache: string | undefined
  if (drivenNets.length > 0) {
    const power = parse(powerLibrary ?? '')
    const flag = children(power, 'symbol').find(form => value(form) === 'PWR_FLAG')
    if (power.head !== 'kicad_symbol_lib' || flag === undefined) throw new Error('configured power library lacks PWR_FLAG')
    flagCache = powerLibrary!.slice(flag.start, flag.end).replace('(symbol "PWR_FLAG"',
      `(symbol ${quote(`${projectName}:PWR_FLAG`)}`)
    const current = library.get('PWR_FLAG')
    const local = powerLibrary!.slice(flag.start, flag.end)
    if (current !== undefined && current !== local) throw new Error('conflicting project-local symbol definition: PWR_FLAG')
    library.set('PWR_FLAG', local)
  }
  const symbolLibrary = `(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor") (generator_version "10.0")\n${[...library.values()].join('\n')}\n)\n`
  parse(symbolLibrary)
  return {
    root: makeRoot(projectName, title, rootUuid, rootSheets, drivenNets, flagCache), children: childFiles,
    symbolLibrary, symbolTable: `(sym_lib_table (version 7) (lib (name ${quote(projectName)})(type "KiCad")(uri "\${KIPRJMOD}/${projectName}.kicad_sym")(options "")(descr "")))\n`,
    project: prepared[0]!.staged.project, warnings,
  }
}
