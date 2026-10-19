/** Fetch and summarize KiCad models without storing their source files. */

import { BoardParser, SchematicParser, type boardProto, type schematicProto } from 'kicad-sexpr-parser'
import { getModelUrls, type SourceOptions } from './service.ts'
import { isCommonOnlyUnit, normalizeCommonUnits } from '../schematic/symbol-units.ts'
import {parse,children,value} from '../schematic/sexpr.ts'

/** Upper bound for each upstream model file read into memory. */
export interface ModelOptions extends SourceOptions {
  maxModelBytes: number
}

/** Limits required when fetching one already-selected upstream model. */
export type ModelFetchOptions = Pick<ModelOptions, 'requestTimeoutMs' | 'maxModelBytes'>

export interface SymbolPin {
  unit: string
  number: string
  name: string
  type: string
}

/** Placement support in the schematic script builder; not an electrical assessment. */
export interface BuilderCompatibility {
  status: 'ready' | 'unsupported_units'
  availableUnits: number[]
  normalization?: 'common_only_to_unit_1'
  nextAction: string
}

/** Inspect unit suffixes before a model chooses a symbol for scripted placement.
 * @param symbol Parsed upstream symbol, including nested unit sections.
 * @returns Supported positive units and a placement correction when needed.
 */
export function inspectBuilderCompatibility(symbol: schematicProto.I_LibSymbol, sourceText?: string): BuilderCompatibility {
  const sections = symbol.children ?? []
  const commonOnly = isCommonOnlyUnit(sections.map(child => child.name), symbol.name,
    sections.reduce((count, child) => count + (child.pins?.length ?? 0), 0),
    !(symbol.pins?.length) && sections.every(child => !(child.children?.length)))
    && (sourceText === undefined || normalizeCommonUnits(sourceText) !== sourceText)
  if (commonOnly) return { status: 'ready', availableUnits: [1], normalization: 'common_only_to_unit_1',
    nextAction: 'Import automatically normalizes this standalone common-only symbol to unit 1, preserving pins and graphics. Place unit 1; confirm physical pin numbers and package against the selected part.' }
  const availableUnits = [...new Set((symbol.children ?? []).flatMap(child => {
    const suffix = /_(\d+)_(\d+)$/u.exec(child.name)
    return suffix && Number(suffix[1]) > 0 && [0, 1].includes(Number(suffix[2])) ? [Number(suffix[1])] : []
  }))].sort((a, b) => a - b)
  const status = availableUnits.length > 0 ? 'ready' : 'unsupported_units'
  return { status, availableUnits, nextAction: status === 'ready'
    ? `Place a listed unit (${availableUnits.join(', ')}); confirm physical pin numbers and package against the selected part. A symbol name is not an MPN match.`
    : 'This symbol has no positive unit supported by the script builder. Check whether a parent definition is needed, or select another online symbol; after different searches fail, use a compatible local symbol. Do not repeatedly place unit 1 or rewrite the parser.' }
}

export interface FootprintPad {
  number: string
  type: string
}

/** Downloaded model that cannot be parsed; the other model can remain usable. */
export interface InvalidModel {
  status: 'invalid'; code: 'MODEL_FORMAT_INVALID' | 'MODEL_PARSE_FAILED'
  sourceUrl: string; message: string; retryUnchanged: false; nextAction: string
}

export interface ModelSummary {
  part: string
  symbol: { status: 'missing' } | InvalidModel | {
    status: 'parsed'
    name: string
    subsymbols: string[]
    pinCount: number
    pins: SymbolPin[]
    builderCompatibility: BuilderCompatibility
  }
  footprint: { status: 'missing' } | InvalidModel | {
    status: 'parsed'
    name: string
    padCount: number
    pads: FootprintPad[]
  }
  validation: { pinPadMatch: 'not_checked' }
}

export async function fetchModelText(
  url: URL,
  type: string,
  options: ModelFetchOptions,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]),
  })
  if (!response.ok) throw new Error(`Huaqiu ${type} file: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > options.maxModelBytes) {
    await response.body?.cancel()
    throw new Error(`Huaqiu ${type} file exceeds ${options.maxModelBytes} bytes`)
  }
  if (response.body === null) throw new Error(`Huaqiu ${type} file: empty response`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > options.maxModelBytes) {
        await reader.cancel()
        throw new Error(`Huaqiu ${type} file exceeds ${options.maxModelBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function collectPins(symbol: schematicProto.I_LibSymbol): SymbolPin[] {
  const pins: SymbolPin[] = []
  const visit = (unit: schematicProto.I_LibSymbol): void => {
    for (const pin of unit.pins ?? []) {
      pins.push({ unit: unit.name, number: pin.number.text, name: pin.name.text, type: pin.type })
    }
    for (const child of unit.children ?? []) visit(child)
  }
  visit(symbol)
  return pins
}

function summarizeSymbol(text: string): ModelSummary['symbol'] {
  const [symbol] = new SchematicParser().parseLibSymbols(text)
  if (!symbol) throw new Error('Huaqiu symbol file: no KiCad symbol found')
  const pins = collectPins(symbol)
  return { status: 'parsed', name: symbol.name, subsymbols: (symbol.children ?? []).map(child => child.name), pinCount: pins.length, pins,
    builderCompatibility: inspectBuilderCompatibility(symbol, text) }
}

/** Fetch one complete Symbol library file for project-local import. */
export async function fetchSymbolSource(
  mfgId: string,
  mpn: string,
  options: ModelFetchOptions,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ text: string; sourceUrl: string; symbol: schematicProto.I_LibSymbol }> {
  const { symbol: url } = await getModelUrls(mfgId, mpn, options, signal, fetcher)
  if (url === null) throw new Error(`Huaqiu symbol is missing for ${mfgId}:${mpn}`)
  const text = await fetchModelText(url, 'symbol', options, signal, fetcher)
  if (!/^\s*\(kicad_symbol_lib(?=\s|\()/.test(text)) {
    throw new Error('Huaqiu symbol file is not a KiCad Symbol library')
  }
  const symbols = new SchematicParser().parseLibSymbols(text)
  if (symbols.length !== 1 || !symbols[0]) {
    throw new Error('Huaqiu symbol file must define exactly one top-level KiCad symbol')
  }
  return { text, sourceUrl: url.href, symbol: symbols[0] }
}

export function summarizeFootprint(text: string): ModelSummary['footprint'] {
  // Legacy .kicad_mod files legitimately use (module ...). The board parser
  // accepts only modern footprint roots; pad metadata does not need conversion.
  const root = parse(text)
  if (root.head === 'module') {
    const pads = children(root,'pad').map(pad => {
      const at=children(pad,'at')[0],size=children(pad,'size')[0],layers=children(pad,'layers')[0]
      if(!at||!size||!layers||layers.items.length<2||![1,2].every(i=>Number.isFinite(Number(value(at,i)))&&Number(value(size,i))>0&&Number.isFinite(Number(value(size,i)))))throw new Error('Legacy footprint pad requires finite position, positive size and layers')
      value(pad,3) // A shape atom is required even when only summarizing pin numbers.
      return {number:value(pad),type:value(pad,2)}
    })
    if (pads.some(pad => !['smd','thru_hole','np_thru_hole','connect'].includes(pad.type))) throw new Error('Unsupported legacy footprint pad type')
    return {status:'parsed',name:value(root),padCount:pads.length,pads}
  }
  const board = new BoardParser().parse(`(kicad_pcb (version 20240108) (generator dsh-tool-kicad-library) ${text})`)
  const footprint: boardProto.I_Footprint | undefined = board.footprints[0]
  if (!footprint) throw new Error('Huaqiu footprint file: no KiCad footprint found')
  const pads = footprint.pads.map(pad => ({ number: pad.number, type: pad.type }))
  return { status: 'parsed', name: footprint.library_link, padCount: pads.length, pads }
}

/** Summarize valid models independently; file format/parse failures preserve the other model.
 * @param mfgId Selected manufacturer identifier. @param mpn Selected exact part number.
 * @param options Network limits. @param signal Cancellation. @param fetcher HTTP implementation.
 * @returns Independent model statuses; detail, download and size failures reject the call.
 */
export async function getComponentModels(
  mfgId: string,
  mpn: string,
  options: ModelOptions,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ModelSummary> {
  const { symbol: symbolUrl, footprint: footprintUrl } = await getModelUrls(mfgId, mpn, options, signal, fetcher)
  const [symbolText, footprintText] = await Promise.all([
    symbolUrl === null ? null : fetchModelText(symbolUrl, 'symbol', options, signal, fetcher),
    footprintUrl === null ? null : fetchModelText(footprintUrl, 'footprint', options, signal, fetcher),
  ])
  return {
    part: `${mfgId}:${mpn}`,
    symbol: symbolText === null ? { status: 'missing' } : inspectModelText(symbolText, symbolUrl!, 'symbol'),
    footprint: footprintText === null ? { status: 'missing' } : inspectModelText(footprintText, footprintUrl!, 'footprint'),
    validation: { pinPadMatch: 'not_checked' },
  }
}

function inspectModelText(text: string, url: URL, type: 'symbol'): ModelSummary['symbol']
function inspectModelText(text: string, url: URL, type: 'footprint'): ModelSummary['footprint']
function inspectModelText(text: string, url: URL, type: 'symbol' | 'footprint'): ModelSummary['symbol'] | ModelSummary['footprint'] {
  const validHeader = type === 'symbol' ? /^\s*\(kicad_symbol_lib(?=\s|\()/u.test(text) : /^\s*\((?:footprint|module)(?=\s|\()/u.test(text)
  try {
    if (!validHeader) throw new Error(`Downloaded ${type} is not a KiCad model; content begins: ${text.slice(0, 160)}`)
    return type === 'symbol' ? summarizeSymbol(text) : summarizeFootprint(text)
  } catch (error) {
    return { status: 'invalid', code: validHeader ? 'MODEL_PARSE_FAILED' : 'MODEL_FORMAT_INVALID', sourceUrl: url.href,
      message: (error instanceof Error ? error.message : String(error)).slice(0,400), retryUnchanged: false,
      nextAction: `The downloaded ${type} is unusable. Use the other model only if its status is parsed; choose another compatible ${type} or candidate. Do not retry unchanged or rewrite the parser.` }
  }
}
