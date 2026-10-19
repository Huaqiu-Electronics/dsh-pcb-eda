/** Read schematic geometry and PNG headers for frame placement without rasterizing pixels. */
import { children, required, value, type Form } from './sexpr.ts'

/** Axis-aligned range in schematic millimetres. Text ranges are conservative estimates. */
export interface FlatBounds { left: number; top: number; right: number; bottom: number }
/** PNG placement metadata; image data is never returned to the model. */
export interface FlatImage { pixels: [number, number]; ppi: number; scale: number; size: [number, number] }
/** Template-controlled margins, grid, and conservative text metrics. */
export interface FlatLayoutStyle { contentPadding: number; grid: number; textWidthFactor: number; textHeightFactor: number }

type Point = [number, number]
function xy(form: Form): Point { return [Number(value(form, 1)), Number(value(form, 2))] }
function box(points: Point[]): FlatBounds {
  if (points.length === 0 || points.some(point => point.some(item => !Number.isFinite(item)))) throw new Error('layout has missing or invalid coordinates')
  const round = (number: number) => Number(number.toFixed(6))
  return { left: round(Math.min(...points.map(point => point[0]))), top: round(Math.min(...points.map(point => point[1]))),
    right: round(Math.max(...points.map(point => point[0]))), bottom: round(Math.max(...points.map(point => point[1]))) }
}

/** Union non-empty object ranges.
 * @param bounds Ranges in the same schematic coordinate system.
 * @returns The enclosing range, or null for no visible content.
 */
export function unionFlatBounds(bounds: FlatBounds[]): FlatBounds | null {
  if (bounds.length === 0) return null
  return box(bounds.flatMap(item => [[item.left, item.top], [item.right, item.bottom]] as Point[]))
}
function inflate(bounds: FlatBounds, amount: number): FlatBounds {
  return { left: bounds.left - amount, top: bounds.top - amount, right: bounds.right + amount, bottom: bounds.bottom + amount }
}
function transform(point: Point, origin: Point, angle: number, library = false, mirror = ''): Point {
  const radians = angle * Math.PI / 180
  let x = point[0] * Math.cos(radians) - point[1] * Math.sin(radians)
  let y = point[0] * Math.sin(radians) + point[1] * Math.cos(radians)
  if (mirror === 'y') x = -x
  if (mirror === 'x') y = -y
  return [origin[0] + x, origin[1] + (library ? -y : y)]
}
function corners(bounds: FlatBounds): Point[] {
  return [[bounds.left, bounds.top], [bounds.right, bounds.top], [bounds.left, bounds.bottom], [bounds.right, bounds.bottom]]
}
function hidden(form: Form): boolean {
  const effects = children(form, 'effects')[0]
  return effects !== undefined && (effects.items.includes('hide') || children(effects, 'hide').some(item => value(item) === 'yes'))
}

/** Estimate a text block's span using deployment-selected font allowances.
 * @param text Visible text, including line breaks.
 * @param size KiCad font width and height.
 * @param style Conservative character and line multipliers.
 * @returns Width and height in millimetres; this is not KiCad font shaping.
 */
export function flatTextSize(text: string, size: Point, style: FlatLayoutStyle): Point {
  const lines = text.split('\n')
  return [Math.max(1, ...lines.map(line => [...line].length)) * size[0] * style.textWidthFactor,
    lines.length * size[1] * style.textHeightFactor]
}
function textBounds(form: Form, text: string, style: FlatLayoutStyle): FlatBounds | null {
  if (hidden(form)) return null
  const at = children(form, 'at')[0]
  if (at === undefined) return null
  const effects = children(form, 'effects')[0]
  const font = effects && children(effects, 'font')[0]
  const size = font && children(font, 'size')[0]
  // Absent font sizes in imported drawings use KiCad's schematic text size.
  const dimensions = flatTextSize(text, size ? xy(size) : [1.27, 1.27], style)
  const justify = effects && children(effects, 'justify')[0]
  const left = justify?.items.includes('left') ? 0 : justify?.items.includes('right') ? -dimensions[0] : -dimensions[0] / 2
  const top = justify?.items.includes('top') ? 0 : justify?.items.includes('bottom') ? -dimensions[1] : -dimensions[1] / 2
  const local = { left, top, right: left + dimensions[0], bottom: top + dimensions[1] }
  const origin = xy(at), angle = Number(at.items[3] ?? 0)
  if (['label', 'global_label', 'hierarchical_label'].includes(form.head)) {
    // Label anchors and shape tips differ from plain-text alignment; cover both sides.
    return box(corners({ left: -dimensions[0] - dimensions[1], top: -dimensions[1],
      right: dimensions[0] + dimensions[1], bottom: dimensions[1] }).map(point => transform(point, origin, -angle)))
  }
  return box(corners(local).map(point => transform(point, origin, -angle)))
}

/** Read a PNG's physical placement using KiCad 10's wxWidgets resolution rules.
 * @param root Schematic root, including its file version.
 * @param form Embedded image form containing base64 PNG data.
 * @returns Header dimensions and centred bounds; unsupported encodings require manual bounds.
 */
export function flatImageBounds(root: Form, form: Form): { image: FlatImage; bounds: FlatBounds } {
  const data = required(form, 'data')
  const encoded = data.items.slice(1).map((_item, index) => value(data, index + 1)).join('')
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('image data must be base64 PNG for automatic bounds; use manual frame bounds')
  const png = Buffer.from(encoded, 'base64')
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(8) !== 13) {
    throw new Error('automatic image bounds support PNG headers only; use manual frame bounds for this image')
  }
  const pixels: Point = [png.readUInt32BE(16), png.readUInt32BE(20)]
  if (pixels.some(item => item === 0)) throw new Error('PNG image has an empty dimension')
  let ppi = 300
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset), end = offset + length + 12
    if (end > png.length) throw new Error('PNG chunk exceeds image data; use a valid source image')
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'pHYs') {
      if (length !== 9) throw new Error('invalid PNG pHYs length')
      const resolution = png.readUInt32BE(offset + 8), unit = png[offset + 16]
      // wxPNG converts pixels/metre to integer pixels/cm before KiCad rounds to PPI.
      const dpiX = unit === 1 ? Math.floor(resolution / 100) : resolution
      if (dpiX > 1) ppi = unit === 1 ? Math.round(dpiX * 2.54) : dpiX
    }
    if (type === 'IDAT' || type === 'IEND') break
    offset = end
  }
  const scaleForm = children(form, 'scale')[0]
  const scale = scaleForm === undefined ? 1 : Number(value(scaleForm))
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('image scale must be positive for automatic bounds')
  const version = Number(value(required(root, 'version')))
  const placementPpi = version <= 20230121 ? 300 : ppi
  // KiCad schematic coordinates have 10000 internal units per mm; round size as GetSize does.
  const size = pixels.map(number => Math.round(number * 25.4 * scale / placementPpi * 10000) / 10000) as Point
  const [x, y] = xy(required(form, 'at'))
  return { image: { pixels, ppi, scale, size }, bounds: {
    left: x - size[0] / 2, top: y - size[1] / 2, right: x + size[0] / 2, bottom: y + size[1] / 2 } }
}

function shapeBounds(form: Form): FlatBounds | null {
  const points: Point[] = []
  for (const key of ['start', 'end', 'mid']) for (const field of children(form, key)) points.push(xy(field))
  for (const pts of children(form, 'pts')) for (const field of children(pts, 'xy')) points.push(xy(field))
  if (form.head === 'circle') {
    const [x, y] = xy(required(form, 'center')), radius = Number(value(required(form, 'radius')))
    points.push([x - radius, y - radius], [x + radius, y + radius])
  }
  if (form.head === 'arc' && points.length === 3) {
    const [a, b, c] = points as [Point, Point, Point]
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
    if (Math.abs(d) > 1e-9) {
      const squares = points.map(([x, y]) => x * x + y * y)
      const x = (squares[0]! * (b[1] - c[1]) + squares[1]! * (c[1] - a[1]) + squares[2]! * (a[1] - b[1])) / d
      const y = (squares[0]! * (c[0] - b[0]) + squares[1]! * (a[0] - c[0]) + squares[2]! * (b[0] - a[0])) / d
      const radius = Math.hypot(x - a[0], y - a[1])
      points.push([x - radius, y - radius], [x + radius, y + radius])
    }
  }
  return points.length === 0 ? null : box(points)
}

/** Estimate one object's visible range, including the selected cache body and properties.
 * @param root Schematic with already aligned symbol IDs.
 * @param form Top-level object to measure.
 * @param style Template-controlled text allowances.
 * @returns The visible range, or null for a hidden object; unsupported geometry throws.
 */
export function flatObjectBounds(root: Form, form: Form, style: FlatLayoutStyle): FlatBounds | null {
  if (form.head === 'image') return flatImageBounds(root, form).bounds
  if (['text', 'label', 'global_label', 'hierarchical_label'].includes(form.head)) return textBounds(form, value(form), style)
  if (form.head === 'text_box') {
    const at = xy(required(form, 'at')), size = xy(required(form, 'size'))
    const field = required(form, 'at'), angle = Number(field.items[3] ?? 0)
    return box(corners({ left: 0, top: 0, right: size[0], bottom: size[1] }).map(point => transform(point, at, -angle)))
  }
  if (form.head === 'symbol') {
    const definition = children(required(root, 'lib_symbols'), 'symbol').find(item => value(item) === value(required(form, 'lib_id')))
    if (!definition || children(definition, 'extends').length > 0) throw new Error('automatic bounds require an expanded symbol cache; use manual frame bounds')
    const at = required(form, 'at'), origin = xy(at), angle = Number(value(at, 3))
    const mirror = children(form, 'mirror')[0], axis = mirror ? value(mirror) : ''
    if (![0, 90, 180, 270].includes(angle) || !['', 'x', 'y'].includes(axis)) throw new Error('unsupported symbol transform for automatic bounds')
    const ranges: FlatBounds[] = []
    const unit = Number(value(required(form, 'unit'))), convert = children(form, 'convert')[0]
    const body = convert === undefined ? 1 : Number(value(convert))
    for (const section of children(definition, 'symbol')) {
      const suffix = /_(\d+)_(\d+)$/u.exec(value(section))
      if (!suffix) throw new Error('unsupported cache unit name for automatic bounds')
      if ((Number(suffix[1]) !== 0 && Number(suffix[1]) !== unit) || (Number(suffix[2]) !== 0 && Number(suffix[2]) !== body)) continue
      for (const item of section.items) {
        if (typeof item === 'string') continue
        let local: FlatBounds | null
        if (item.head === 'pin') {
          const at = required(item, 'at'), start = xy(at), length = Number(value(required(item, 'length')))
          local = box([start, transform([length, 0], start, Number(value(at, 3)))])
          const text = [children(item, 'name')[0], children(item, 'number')[0]].filter((field): field is Form => field !== undefined)
          const allowance = Math.max(0, ...text.map(field => {
            const effects = children(field, 'effects')[0], font = effects && children(effects, 'font')[0]
            const size = font && children(font, 'size')[0]
            return size ? xy(size)[1] * style.textHeightFactor : 0
          }))
          local = inflate(local, allowance)
        } else if (item.head === 'text') local = textBounds(item, value(item), style)
        else {
          local = shapeBounds(item)
          if (local === null) throw new Error(`unsupported symbol graphic ${item.head}; use manual frame bounds`)
        }
        if (local) ranges.push(box(corners(local).map(point => transform(point, origin, angle, true, axis))))
      }
    }
    for (const field of children(form, 'property')) {
      const bounds = textBounds(field, value(field, 2), style)
      if (bounds) ranges.push(bounds)
    }
    return unionFlatBounds(ranges.length === 0 ? [box([origin])] : ranges)
  }
  const shape = shapeBounds(form)
  if (shape) return shape
  const at = children(form, 'at')[0]
  if (at && ['junction', 'no_connect'].includes(form.head)) return box([xy(at)])
  throw new Error(`unsupported automatic layout object ${form.head}; use manual frame bounds`)
}
