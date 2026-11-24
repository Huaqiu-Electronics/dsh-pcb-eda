/**
 * Fabrication packaging and place-order submission.
 *
 * KiCad's own "Place order" action is a thin wrapper around the Huaqiu
 * (eda.cn) openapi: it exports gerber + drill files, zips them, posts the board
 * form plus the archive as multipart, composes the order page URL the backend
 * describes, and loads that URL in its order webview. Without a KiCad GUI
 * process there is no in-process exporter or webview, so this module reproduces
 * the flow with `kicad-cli` for the artifacts, plain multipart HTTP for the
 * submit, and hands the same final URL to the system default browser. It is the
 * same contract, not a second order backend:
 *
 *   PCB   POST <base>/openapi/api/hqpcb/External/fileQuote
 *   SMT   POST <base>/openapi/pcba/saveDfmTmpOrder
 *
 * Nothing here computes a price. The backend owns the quote, the order id and
 * the URL; this module only packages files and forwards the response.
 *
 * Reference: `pcbnew/fab/place_order_form_builder.h`,
 * `pcbnew/fab/place_order_for_pcb.h`, `pcbnew/fab/place_order_for_smt.h`,
 * `copilot/assistant/quote/{pcb_quote,smt_quote}.cpp`.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { zipSync } from 'fflate'
import type { BomRow } from './service.js'

/** Endpoint paths relative to the order base URL (the host, not a DSH route). */
export const ORDER_PATHS = Object.freeze({
  pcb: '/openapi/api/hqpcb/External/fileQuote',
  smt: '/openapi/pcba/saveDfmTmpOrder',
})

/** Default origin serving the two endpoints. */
export const DEFAULT_ORDER_BASE_URL = 'https://www.eda.cn'

/** Order page host the webview loads after both submissions. */
export const DEFAULT_ORDER_PAGE_BASE = 'https://www.hqpcb.com'

/** `tid` the reference client sends for a board quoted from a file. */
export const ORDER_SOURCE_TID = '354'

export interface BoardFacts {
  /** Copper layer count, as KiCad counts them (F.Cu, In*.Cu, B.Cu). */
  readonly layers: number
  readonly widthMm: number
  readonly heightMm: number
  readonly thicknessMm: number
  readonly minTrackMm?: number
  readonly minViaDrillMm?: number
  readonly outerOz?: number
  readonly innerOz?: number
  /** Placed pads, used for the assembly form's `patch_pad_number`. */
  readonly padCount?: number
}

/** One file inside the fabrication zip. */
export interface PackageFile {
  readonly name: string
  readonly bytes: number
}

export interface FabricationPackage {
  readonly boardPath: string
  readonly revision: string
  readonly zipName: string
  readonly zipBytes: number
  /** `Uint8Array` of the zip, ready to attach. */
  readonly archive: Uint8Array
  readonly files: readonly PackageFile[]
  readonly facts: BoardFacts
  readonly generatedAt: string
}

// ---------------------------------------------------------------------------
// S-expression reading (board facts without a second KiCad parser)
// ---------------------------------------------------------------------------

type SExpr = string | SExpr[]

function tokenize(text: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '(' || char === ')') {
      tokens.push(char)
      index += 1
      continue
    }
    if (char === '"') {
      let value = ''
      index += 1
      while (index < text.length) {
        const current = text[index]
        if (current === '\\') {
          value += text[index + 1] ?? ''
          index += 2
          continue
        }
        if (current === '"') {
          index += 1
          break
        }
        value += current
        index += 1
      }
      // Quoted atoms keep a marker so they are never confused with structure.
      tokens.push(`\u0000${value}`)
      continue
    }
    if (/\s/u.test(char ?? '')) {
      index += 1
      continue
    }
    let end = index
    while (end < text.length && !/[\s()]/u.test(text[end] ?? '')) end += 1
    tokens.push(text.slice(index, end))
    index = end
  }
  return tokens
}

function atom(token: string): string {
  return token.startsWith('\u0000') ? token.slice(1) : token
}

/** Parse a KiCad s-expression document into nested arrays. */
export function parseSexpr(text: string): SExpr[] {
  const root: SExpr[] = []
  const stack: SExpr[][] = [root]
  for (const token of tokenize(text)) {
    if (token === '(') {
      const node: SExpr[] = []
      stack[stack.length - 1]?.push(node)
      stack.push(node)
      continue
    }
    if (token === ')') {
      if (stack.length > 1) stack.pop()
      continue
    }
    stack[stack.length - 1]?.push(atom(token))
  }
  return root
}

function head(node: SExpr): string | undefined {
  return Array.isArray(node) && typeof node[0] === 'string' ? node[0] : undefined
}

function isNode(value: SExpr | undefined): value is SExpr[] {
  return Array.isArray(value)
}

function child(node: SExpr[], name: string): SExpr[] | undefined {
  return node.find((entry): entry is SExpr[] => isNode(entry) && head(entry) === name)
}

function numberAt(node: SExpr[] | undefined, index: number): number | undefined {
  const value = node?.[index]
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined
}

/** Every `(head x y)` point under one graphic item. */
function pointsOf(node: SExpr[]): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = []
  const visit = (entry: SExpr): void => {
    if (!isNode(entry)) return
    const name = head(entry)
    if (name === 'start' || name === 'end' || name === 'mid' || name === 'center' || name === 'at' || name === 'xy') {
      const x = numberAt(entry, 1)
      const y = numberAt(entry, 2)
      if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
    }
    for (const inner of entry) visit(inner)
  }
  visit(node)
  return points
}

/** The layers/node children of the document root. */
function rootOf(tree: SExpr[]): SExpr[] | undefined {
  return tree.find((node): node is SExpr[] => isNode(node) && head(node) === 'kicad_pcb')
}

function isEdgeCuts(node: SExpr[]): boolean {
  const layer = child(node, 'layer')
  return layer !== undefined && layer[1] === 'Edge.Cuts'
}

/** Snap a copper thickness in mm to the ounce weights the order form offers. */
function snapOz(thicknessMm: number, allowed: readonly number[]): number {
  const oz = (thicknessMm * 1000) / 34.7
  let best = allowed[0] ?? 1
  for (const candidate of allowed) {
    if (Math.abs(oz - candidate) < Math.abs(oz - best)) best = candidate
  }
  return best
}

/**
 * Derive the fabrication facts the order form needs from a saved board.
 *
 * Only values the file actually carries are returned; the caller keeps the
 * reference defaults for anything missing instead of inventing a measurement.
 */
export function readBoardFacts(text: string): BoardFacts {
  const root = rootOf(parseSexpr(text))
  if (root === undefined) throw new Error('not a kicad_pcb document')

  const layersNode = child(root, 'layers')
  const copperLayers = (layersNode ?? []).filter(entry =>
    isNode(entry) && typeof entry[1] === 'string' && entry[1].endsWith('.Cu'))
  const layers = copperLayers.length

  const general = child(root, 'general')
  const thicknessMm = numberAt(child(general ?? [], 'thickness'), 1) ?? 1.6

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let minTrackMm: number | undefined
  let minViaDrillMm: number | undefined
  let smdPads = 0
  let allPads = 0

  for (const node of root) {
    if (!isNode(node)) continue
    const name = head(node)
    if (name === undefined) continue
    if (name.startsWith('gr_') && isEdgeCuts(node)) {
      for (const point of pointsOf(node)) {
        minX = Math.min(minX, point.x)
        minY = Math.min(minY, point.y)
        maxX = Math.max(maxX, point.x)
        maxY = Math.max(maxY, point.y)
      }
      continue
    }
    if (name === 'footprint') {
      const pads = node.filter((entry): entry is SExpr[] => isNode(entry) && head(entry) === 'pad').length
      allPads += pads
      const attr = child(node, 'attr') ?? []
      if (attr.some(entry => entry === 'smd')) smdPads += pads
      continue
    }
    if (name === 'segment' || name === 'arc') {
      const width = numberAt(child(node, 'width'), 1)
      if (width !== undefined && width > 0) minTrackMm = Math.min(minTrackMm ?? width, width)
      continue
    }
    if (name === 'via') {
      const drill = numberAt(child(node, 'drill'), 1)
      if (drill !== undefined && drill > 0) minViaDrillMm = Math.min(minViaDrillMm ?? drill, drill)
    }
  }

  const widthMm = Number.isFinite(minX) ? maxX - minX : 0
  const heightMm = Number.isFinite(minY) ? maxY - minY : 0

  const stackup = child(child(root, 'setup') ?? [], 'stackup')
  let outerThickness: number | undefined
  let innerThickness: number | undefined
  for (const entry of stackup ?? []) {
    if (!isNode(entry) || head(entry) !== 'layer') continue
    const name = typeof entry[1] === 'string' ? entry[1] : ''
    if (child(entry, 'type')?.[1] !== 'copper') continue
    const thickness = numberAt(child(entry, 'thickness'), 1)
    if (thickness === undefined || thickness <= 0) continue
    if (name === 'F.Cu' || name === 'B.Cu') outerThickness = Math.max(outerThickness ?? 0, thickness)
    else if (name.endsWith('.Cu')) innerThickness = Math.max(innerThickness ?? 0, thickness)
  }

  return {
    layers: layers > 0 ? layers : 2,
    widthMm,
    heightMm,
    thicknessMm,
    ...(minTrackMm === undefined ? {} : { minTrackMm }),
    ...(minViaDrillMm === undefined ? {} : { minViaDrillMm }),
    ...(outerThickness === undefined ? {} : { outerOz: snapOz(outerThickness, [1, 2, 3, 4]) }),
    ...(innerThickness === undefined ? {} : { innerOz: snapOz(innerThickness, [0.5, 1, 2, 3, 4]) }),
    ...(allPads === 0 ? {} : { padCount: smdPads > 0 ? smdPads : allPads }),
  }
}

// ---------------------------------------------------------------------------
// Order form (PCB_FORM / SMT_FORM wire shape)
// ---------------------------------------------------------------------------

const THICKNESS_TIERS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  1: [0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
  2: [0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
  4: [0.6, 0.8, 1.0, 1.2, 1.6, 2.0],
  6: [0.8, 1.0, 1.2, 1.6, 2.0, 2.5],
  8: [1.0, 1.2, 1.6, 2.0, 2.5],
  10: [1.2, 1.6, 2.0, 2.5],
  12: [1.6, 2.0, 2.5],
  14: [1.6, 2.0, 2.5, 3.0],
  16: [2.0, 2.5, 3.0],
  18: [2.0, 2.5, 3.0, 3.2],
  20: [2.0, 2.5, 3.0, 3.2],
})

const TRACE_TIERS = [4, 5, 6, 8, 10] as const

/** Snap a board thickness onto the tier list for its layer count. */
export function snapThickness(layers: number, thicknessMm: number): string {
  const tiers = THICKNESS_TIERS[layers] ?? THICKNESS_TIERS[20] ?? [1.6]
  for (const nominal of tiers) {
    if (thicknessMm >= nominal * 0.9 && thicknessMm <= nominal * 1.1) return nominal.toFixed(1)
  }
  for (const nominal of tiers) {
    if (nominal >= thicknessMm) return nominal.toFixed(1)
  }
  return (tiers[tiers.length - 1] ?? 3.2).toFixed(1)
}

/** Snap a measured minimum trace/space (mm) onto the mil tier list. */
export function snapTraceTier(minTrackMm: number | undefined): string {
  if (minTrackMm === undefined || !Number.isFinite(minTrackMm) || minTrackMm <= 0) return '6'
  const mils = minTrackMm / 0.0254
  for (const tier of TRACE_TIERS) {
    if (mils <= tier + 1e-9) return String(tier)
  }
  return String(TRACE_TIERS[TRACE_TIERS.length - 1])
}

/** Snap a measured hole (mm) onto the drill tiers the form accepts. */
export function snapHoleTier(minHoleMm: number | undefined, thicknessMm: number): string {
  const all = thicknessMm <= 1.2 ? ['0.15', '0.2', '0.25', '0.3'] : ['0.2', '0.25', '0.3']
  if (minHoleMm === undefined || !Number.isFinite(minHoleMm) || minHoleMm <= 0) return all[0] ?? '0.3'
  const first = Number(all[0])
  const last = Number(all[all.length - 1])
  if (minHoleMm <= first) return all[0] ?? '0.3'
  if (minHoleMm >= last) return all[all.length - 1] ?? '0.3'
  for (const tier of all) {
    if (minHoleMm <= Number(tier) + 1e-9) return tier
  }
  return all[all.length - 1] ?? '0.3'
}

export interface PcbFormOverrides {
  /** Production quantity (the form's `bcount`). */
  readonly quantity?: number
  readonly solderMaskColor?: string
  readonly surfaceFinish?: string
  readonly thicknessMm?: number
}

/**
 * The PCB order form exactly as the reference client posts it.
 *
 * Every field of `PCB_FORM` is present, including empty optionals, because the
 * endpoint validates the full base/process/special/personalized blocks. Only
 * geometry and process ability are derived from the board; everything else
 * keeps the reference default rather than inventing a preference.
 */
export function pcbOrderForm(facts: BoardFacts, overrides: PcbFormOverrides = {}): Record<string, string> {
  const thickness = overrides.thicknessMm ?? facts.thicknessMm
  return {
    // BaseInfoModel
    blayer: String(facts.layers),
    blength: (facts.heightMm / 10).toFixed(2),
    bwidth: (facts.widthMm / 10).toFixed(2),
    bcount: String(overrides.quantity ?? 5),
    sidedirection: '无',
    plate_type: 'FR-4',
    units: '1',
    layoutx: '0',
    layouty: '0',
    sidewidth: '0',
    testpoint: '0',
    pbnum: '1',
    board_tg: facts.layers >= 4 ? 'TG150' : '',
    // ProcessInfoModel
    bheight: snapThickness(facts.layers, thickness),
    copper: String(facts.outerOz ?? 1),
    lineweight: snapTraceTier(facts.minTrackMm),
    vias: snapHoleTier(facts.minViaDrillMm, thickness),
    color: overrides.solderMaskColor ?? '绿色',
    charcolor: '白色',
    cover: '过孔盖油',
    spray: overrides.surfaceFinish ?? '无铅喷锡',
    insidecopper: String(facts.innerOz ?? (facts.layers >= 4 ? 0.5 : 0)),
    // SpecialProcessModel
    impendance: '0',
    bankong: '0',
    blind: '0',
    via_in_pad: '无',
    beveledge: '0',
    pressing: '',
    baobian: '0',
    bga: '',
    zknum: '',
    // PersonalizedInfoModel
    test: 'Sample Test Free',
    shipment_report: '0',
    slice_report: '0',
    report_type: '0',
    review_file: '0',
    has_period: '2',
    period_format: '',
    film_report: '0',
    pcb_note: '',
    cross_board: '1',
    paper: '1',
    user_stamp: '1',
    hq_pack: '1',
    // Transport
    service: '',
    region_id: 'cn',
    country: 'CN',
    express: '',
    type: '',
  }
}

export interface SmtFormOverrides {
  readonly quantity?: number
  readonly bomFileName: string
  readonly coordFileName: string
  readonly materialTypes: number
  readonly padCount?: number
}

/** The `smt_order` half of `PCB_SMT_FORM`, with file names attached. */
export function smtOrderForm(facts: BoardFacts, overrides: SmtFormOverrides): Record<string, string | number> {
  return {
    bom_file_name: overrides.bomFileName,
    bom_file_path: '',
    coord_file_name: overrides.coordFileName,
    coord_file_path: '',
    // The reference copies `pcb_form.bheight` and `pcb_form.blength` verbatim,
    // so the assembly form and the board form always describe one panel size.
    pcb_ban_height: snapThickness(facts.layers, facts.thicknessMm),
    pcb_ban_width: (facts.heightMm / 10).toFixed(2),
    bom_material_type_number: String(overrides.materialTypes),
    is_plug: '1',
    number: String(overrides.quantity ?? 5),
    // KiCad ships 1133 as the form default; the board's own pad count is used
    // when it can be read, so a small board is never quoted as a dense one.
    patch_pad_number: String(overrides.padCount ?? facts.padCount ?? 1133),
    plug_number: '64',
    single_or_double_technique: '1',
    plug_material_type: '',
    buy_bom: 4,
  }
}

// ---------------------------------------------------------------------------
// Positions and BOM CSVs the assembly endpoint expects
// ---------------------------------------------------------------------------

export interface PositionRow {
  readonly designator: string
  readonly footprint: string
  readonly x: string
  readonly y: string
  readonly layer: 'T' | 'B'
  readonly rotation: string
  readonly comment: string
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',') {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells
}

/**
 * Convert `kicad-cli pcb export pos --format csv` rows into the
 * `Designator,Footprint,PosX,PosY,Layer,Rotation,Comment` table the assembly
 * endpoint parses (see `write_positions_to_csv` in the reference).
 */
export function parsePositions(csv: string): PositionRow[] {
  const lines = csv.split(/\r?\n/u).filter(line => line.trim() !== '')
  const header = lines.shift()
  if (header === undefined) return []
  const columns = splitCsvLine(header).map(cell => cell.trim().toLowerCase())
  const column = (name: string): number => columns.indexOf(name)
  const refIndex = column('ref')
  const valueIndex = column('val')
  const packageIndex = column('package')
  const xIndex = column('posx')
  const yIndex = column('posy')
  const rotationIndex = column('rot')
  const sideIndex = column('side')
  if (refIndex === -1 || xIndex === -1 || yIndex === -1) return []

  const rows: PositionRow[] = []
  for (const line of lines) {
    const cells = splitCsvLine(line)
    const designator = (cells[refIndex] ?? '').trim()
    if (designator === '') continue
    const side = (cells[sideIndex] ?? '').trim().toLowerCase()
    rows.push({
      designator,
      footprint: (cells[packageIndex] ?? '').trim(),
      x: `${(cells[xIndex] ?? '').trim()}mm`,
      y: `${(cells[yIndex] ?? '').trim()}mm`,
      layer: side.startsWith('b') ? 'B' : 'T',
      rotation: (cells[rotationIndex] ?? '0').trim(),
      comment: (cells[valueIndex] ?? '').trim(),
    })
  }
  return rows
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/** The positions table, with the UTF-8 BOM the reference writes. */
export function positionsCsv(rows: readonly PositionRow[]): string {
  const header = 'Designator,Footprint,PosX,PosY,Layer,Rotation,Comment'
  const body = rows.map(row =>
    [row.designator, row.footprint, row.x, row.y, row.layer, row.rotation, row.comment].map(csvCell).join(','))
  return `\uFEFF${[header, ...body].join('\n')}\n`
}

export interface OrderBomRow {
  readonly designators: readonly string[]
  readonly mpn: string
  readonly description: string
  readonly footprint: string
  readonly quantity: number
}

/**
 * Group placed designators into assembly lines.
 *
 * Positions are the board truth for what will be placed, so they drive the
 * grouping; the schematic BOM only supplies value/MPN for a designator. A
 * designator with no BOM entry keeps its position data instead of being
 * dropped, which is what the reference does (it never consults the schematic).
 */
export function orderBomRows(
  positions: readonly PositionRow[],
  bom: readonly BomRow[] | undefined,
): OrderBomRow[] {
  const byReference = new Map<string, BomRow>()
  for (const row of bom ?? []) {
    for (const reference of row.references) byReference.set(reference.trim(), row)
  }
  const groups = new Map<string, { designators: string[]; row: OrderBomRow }>()
  for (const position of positions) {
    const entry = byReference.get(position.designator)
    const mpnField = entry === undefined
      ? ''
      : (entry.fields.MPN ?? entry.fields.Mpn ?? entry.fields.mpn ?? '')
    const mpn = mpnField !== '' ? mpnField : (entry?.value ?? position.comment)
    const description = entry?.value ?? position.comment
    const footprint = entry?.footprint !== undefined && entry.footprint !== ''
      ? entry.footprint
      : position.footprint
    const key = JSON.stringify([mpn, description, footprint])
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, {
        designators: [position.designator],
        row: { designators: [], mpn, description, footprint, quantity: 1 },
      })
      continue
    }
    group.designators.push(position.designator)
  }
  return [...groups.values()].map(group => ({ ...group.row, designators: group.designators }))
}

/** The assembly BOM table (`序号,型号,规格参数,封装,品牌,位号,单机用量`). */
export function orderBomCsv(rows: readonly OrderBomRow[]): string {
  const header = '序号,型号,规格参数,封装,品牌,位号,单机用量'
  const body = rows.map((row, index) => [
    String(index + 1),
    csvCell(row.mpn),
    csvCell(row.description),
    csvCell(row.footprint),
    '',
    csvCell(row.designators.join(',')),
    String(row.designators.length),
  ].join(','))
  return `\uFEFF${[header, ...body].join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Packaging and transport
// ---------------------------------------------------------------------------

/** Zip a directory listing of already-read files. */
export function zipPackage(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const file of files) entries[file.name] = file.data
  return zipSync(entries, { level: 6 })
}

/** Read every file a `kicad-cli` export wrote into one directory. */
export function readExportDirectory(directory: string, names: readonly string[]): { name: string; data: Uint8Array }[] {
  return names.map(name => ({ name, data: new Uint8Array(readFileSync(`${directory}/${name}`)) }))
}

export interface MultipartPart {
  readonly name: string
  readonly value: string
}

export interface MultipartFile {
  readonly field: string
  readonly name: string
  readonly type: string
  readonly data: Uint8Array
}

/** Build `multipart/form-data` without a runtime dependency. */
export function multipartBody(
  parts: readonly MultipartPart[],
  files: readonly MultipartFile[],
  boundary: string,
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\nContent-Type: text/plain\r\n\r\n${part.value}\r\n`,
      'utf8',
    ))
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      'utf8',
    ))
    chunks.push(Buffer.from(file.data))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/** Read `id` / `guid` out of the redirect URL the PCB endpoint returns. */
export function orderIdsFromUrl(url: string): { id?: string; guid?: string } {
  const parsed = ((): URL | undefined => {
    try {
      return new URL(url)
    } catch {
      return undefined
    }
  })()
  const query = parsed?.searchParams
  const id = query?.get('id') ?? /[?&]id=([^&]+)/u.exec(url)?.[1]
  const guid = query?.get('guid') ?? /[?&]guid=([^&]+)/u.exec(url)?.[1]
  return {
    ...(id === undefined || id === '' ? {} : { id: decodeURIComponent(id) }),
    ...(guid === undefined || guid === '' ? {} : { guid: decodeURIComponent(guid) }),
  }
}

/** Set query parameters without dropping empty strings, preserving insertion order. */
function withParams(url: string, params: readonly (readonly [string, string])[]): string | undefined {
  try {
    const parsed = new URL(url)
    for (const [name, value] of params) parsed.searchParams.set(name, value)
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * The final PCB page KiCad loads into its order webview.
 *
 * Mirrors `place_order_for_pcb.h` exactly:
 * `<page>/mycenter/orders/pcb/quote?type=PCB&id=…&guid=…&tid=354&token=…`.
 * Values are query-encoded, which is the only deviation from the C++ string
 * concatenation — a token with `+` or `/` must not corrupt the query.
 */
export function pcbOrderUrl(
  pageBase: string,
  ids: { id?: string; guid?: string },
  token: string | undefined,
): string | undefined {
  if (ids.id === undefined && ids.guid === undefined) return undefined
  const base = pageBase.replace(/\/+$/u, '')
  const params: [string, string][] = [['type', 'PCB']]
  if (ids.id !== undefined) params.push(['id', ids.id])
  if (ids.guid !== undefined) params.push(['guid', ids.guid])
  params.push(['tid', ORDER_SOURCE_TID])
  if (token !== undefined && token !== '') params.push(['token', token])
  return withParams(`${base}/mycenter/orders/pcb/quote`, params)
}

/**
 * The final assembly page KiCad loads into its order webview.
 *
 * Mirrors `place_order_for_smt.h`: the backend's URL plus `token` and
 * `source=bom` (the latter switches the page into BOM matching).
 */
export function smtOrderUrl(orderUrl: string, token: string | undefined): string | undefined {
  const params: [string, string][] = []
  if (token !== undefined && token !== '') params.push(['token', token])
  params.push(['source', 'bom'])
  return withParams(orderUrl, params)
}

/** File name a package is uploaded under: `<board>.zip`, like the reference. */
export function packageName(boardPath: string): string {
  return basename(boardPath).replace(/\.kicad_pcb$/iu, '')
}
