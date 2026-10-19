/** Render KiCad schematics into project-local, revision-keyed PNG previews. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { previewExportError, PreviewError } from './preview-diagnostics.ts'

/** Deployment-owned rendering limits and executable path. */
export interface PreviewConfig {
  kicadCliPath: string
  previewDensity: number
  previewMaxWidth: number
  previewMaxPages: number
  previewPadding: number
  previewTimeoutMs: number
  previewTrimThreshold: number
}

/** One KiCad SVG page and the PNG rendered from that exact export. */
export interface PreviewPage {
  pageIndex: number
  exportedPageName: string
  pageSchematicPath: string | null
  svgPath: string
  pngPath: string
}

/** Source sheet used to identify an exported page and invalidate the preview cache. */
export interface PreviewSource {
  exportedPageName: string
  schematicPath: string
  sha256: string
}

/** A failed page with a correction that does not require recreating the schematic. */
export interface PreviewFailure {
  code: string
  page: string
  svgPath: string
  stage: string
  message: string
  retryUnchanged: boolean
  nextAction: string
}

/** Complete preview result for one exact source revision. */
export interface ModulePreview {
  manifestPath: string
  cached: boolean
  pageCount: number
  truncated: boolean
  pages: PreviewPage[]
  failures: PreviewFailure[]
}

interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

interface PreviewManifest {
  failures: PreviewFailure[]
  sourceSchematicPath: string
  revision: string
  sources: PreviewSource[]
  density: number
  maxWidth: number
  maxPages: number
  padding: number
  trimThreshold: number
  pageCount: number
  truncated: boolean
  pages: Array<{ pageIndex: number; svg: string; png: string; pageSchematicPath: string | null }>
}

type ProcessRunner = (
  file: string, args: readonly string[], signal: AbortSignal, timeoutMs: number,
) => Promise<ProcessResult>

/** Run a fixed executable without a shell and wait until it exits. */
export const runProcess: ProcessRunner = async (file, args, signal, timeoutMs) => await new Promise((resolve, reject) => {
  const child = spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const limit = 2 * 1024 * 1024
  const append = (current: string, chunk: unknown) => (current + String(chunk)).slice(-limit)
  const abort = () => child.kill()
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
  child.on('error', (error) => {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    reject(error)
  })
  child.on('close', code => {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    if (signal.aborted) return reject(signal.reason ?? new Error('KiCad preview was cancelled'))
    resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
  })
})

function manifest(value: unknown, schematicPath: string, revision: string,
  sources: PreviewSource[], config: PreviewConfig): PreviewManifest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.sourceSchematicPath !== schematicPath || item.revision !== revision || item.density !== config.previewDensity
    || item.maxWidth !== config.previewMaxWidth || item.maxPages !== config.previewMaxPages
    || item.padding !== config.previewPadding || item.trimThreshold !== config.previewTrimThreshold
    || !Array.isArray(item.failures) || item.failures.length > 0
    || typeof item.pageCount !== 'number'
    || typeof item.truncated !== 'boolean' || !Array.isArray(item.pages)
    || JSON.stringify(item.sources) !== JSON.stringify(sources)) return undefined
  const pages: PreviewManifest['pages'] = []
  for (const [index, page] of item.pages.entries()) {
    if (typeof page !== 'object' || page === null || Array.isArray(page)) return undefined
    const entry = page as Record<string, unknown>
    if (entry.pageIndex !== index + 1 || typeof entry.svg !== 'string' || typeof entry.png !== 'string') return undefined
    if (basename(entry.svg) !== entry.svg || basename(entry.png) !== entry.png) return undefined
    if (entry.pageSchematicPath !== null && typeof entry.pageSchematicPath !== 'string') return undefined
    pages.push({ pageIndex: index + 1, svg: entry.svg, png: entry.png,
      pageSchematicPath: entry.pageSchematicPath })
  }
  return { failures: [], sourceSchematicPath: schematicPath, revision, sources,
    density: config.previewDensity, maxWidth: config.previewMaxWidth,
    maxPages: config.previewMaxPages, padding: config.previewPadding,
    trimThreshold: config.previewTrimThreshold,
    pageCount: item.pageCount, truncated: item.truncated, pages }
}

async function cachedPreview(directory: string, schematicPath: string, revision: string,
  sources: PreviewSource[], config: PreviewConfig): Promise<ModulePreview | undefined> {
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as unknown }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
  const saved = manifest(parsed, schematicPath, revision, sources, config)
  if (saved === undefined) return undefined
  try {
    const pages = await Promise.all(saved.pages.map(async page => {
      const svgPath = join(directory, page.svg)
      const pngPath = join(directory, page.png)
      await Promise.all([stat(svgPath), stat(pngPath)])
      return { pageIndex: page.pageIndex, exportedPageName: basename(page.svg, '.svg'),
        pageSchematicPath: page.pageSchematicPath, svgPath, pngPath }
    }))
    return { manifestPath: join(directory, 'manifest.json'), cached: true,
      pageCount: saved.pageCount, truncated: saved.truncated, pages, failures: [] }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function numericAttribute(tag: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name}="([^"]+)"`, 'u').exec(tag)
  if (match?.[1] === undefined) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** Remove KiCad's full-page background rectangle so transparent-edge trimming sees the drawing content. */
export function removePageBackground(svg: string): string {
  const viewBox = /\bviewBox="([^"]+)"/u.exec(svg)?.[1]?.trim().split(/\s+/u).map(Number)
  if (viewBox?.length !== 4 || viewBox.some(value => !Number.isFinite(value))) return svg
  const [x, y, width, height] = viewBox as [number, number, number, number]
  let removed = false
  return svg.replace(/<rect\b[^>]*\/>/gu, (tag) => {
    if (removed) return tag
    const values = [numericAttribute(tag, 'x'), numericAttribute(tag, 'y'),
      numericAttribute(tag, 'width'), numericAttribute(tag, 'height')]
    if (values.some(value => value === undefined)) return tag
    const [rectX, rectY, rectWidth, rectHeight] = values as [number, number, number, number]
    const matches = Math.abs(rectX - x) < 0.01 && Math.abs(rectY - y) < 0.01
      && Math.abs(rectWidth - width) < 0.01 && Math.abs(rectHeight - height) < 0.01
    if (!matches) return tag
    removed = true
    return ''
  })
}

/** Render a full exported SVG or an exact viewBox crop at the configured bounded resolution.
 * @param svgPath KiCad-exported page.
 * @param config Deployment rendering limits.
 * @param viewBox Optional crop in SVG coordinates.
 * @returns PNG bytes; cropped regions retain their full requested extent.
 */
export async function rasterizePage(svgPath: string, config: PreviewConfig, viewBox?: [number, number, number, number]): Promise<Buffer> {
  let svg = removePageBackground(await readFile(svgPath, 'utf8'))
  if (viewBox) svg = svg.replace(/\bviewBox="[^"]+"/u, `viewBox="${viewBox.join(' ')}"`)
  const innerWidth = config.previewMaxWidth - config.previewPadding * 2
  const tag = /<svg\b[^>]*>/u.exec(svg)?.[0]
  const box = tag === undefined ? undefined : /\bviewBox="([^"]+)"/u.exec(tag)?.[1]?.trim().split(/\s+/u).map(Number)
  if (tag === undefined || box?.length !== 4 || box.some(number => !Number.isFinite(number)) || box[2]! <= 0 || box[3]! <= 0) {
    throw new Error('SVG needs a positive viewBox width and height for bounded rasterization')
  }
  // SVG dimensions at 72 DPI are scaled by the configured input density.
  const scale = innerWidth / Math.max(box[2]!, box[3]!) * 72 / config.previewDensity
  const boundedTag = tag.replace(/\s(?:width|height)="[^"]*"/gu, '')
    .replace(/>$/u, ` width="${box[2]! * scale}px" height="${box[3]! * scale}px">`)
  svg = svg.replace(tag, boundedTag)
  const image = sharp(Buffer.from(svg), { density: config.previewDensity })
  if (!viewBox) image.trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: config.previewTrimThreshold })
  return await image
    .resize({ width: innerWidth, withoutEnlargement: true })
    .extend({ top: config.previewPadding, bottom: config.previewPadding,
      left: config.previewPadding, right: config.previewPadding, background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer()
}

/** Export each KiCad page into a project directory keyed by source path, content, and render settings. */
export async function renderModulePreview(
  outputDir: string, schematicPath: string, revision: string, config: PreviewConfig,
  signal: AbortSignal, sources: PreviewSource[] = [], runner: ProcessRunner = runProcess, pageNames: string[] = [],
): Promise<ModulePreview> {
  const sourceKey = createHash('sha256').update(schematicPath).digest('hex').slice(0, 12)
  const renderKey = createHash('sha256').update(JSON.stringify({ revision, sources, pageNames,
    density: config.previewDensity, width: config.previewMaxWidth, trim: config.previewTrimThreshold,
    padding: config.previewPadding, pages: config.previewMaxPages, format: 'bounded-v3' })).digest('hex').slice(0, 24)
  const directory = join(outputDir, sourceKey, renderKey)
  const exportNames = new Set([basename(schematicPath, '.kicad_sch'), ...sources.map(s => s.exportedPageName), ...pageNames])
  const longPath = [...exportNames].map(name => join(directory, `${name}.svg`)).find(path => path.length >= 260)
  // The Windows KiCad exporter can reject MAX_PATH even when Node can create the directory.
  if (process.platform === 'win32' && longPath) {
    throw new PreviewError({ status: 'error', code: 'PREVIEW_OUTPUT_PATH_TOO_LONG', stage: 'svg_export', schematicPath,
      message: `The planned KiCad SVG path has ${longPath.length} characters and reaches the Windows MAX_PATH limit.`,
      diagnostics: [{ field: 'outputDir', actual: longPath, message: 'KiCad cannot reliably write this SVG output path.',
        suggestion: 'Choose a shorter project-local preview directory inside the current workspace.' }],
      retryUnchanged: false, nextAction: 'Retry with a shorter outputDir inside the workspace. Keep the schematic unchanged; do not repair its format, change paper size, or guess a PNG path.' })
  }
  const cached = await cachedPreview(directory, schematicPath, revision, sources, config)
  if (cached !== undefined) return cached

  await mkdir(directory, { recursive: true })
  const result = await runner(config.kicadCliPath,
    ['sch', 'export', 'svg', '--output', directory, '--exclude-drawing-sheet', schematicPath],
    signal, config.previewTimeoutMs)
  if (result.timedOut) throw new Error(`KiCad SVG export timed out after ${config.previewTimeoutMs} ms`)
  if (result.exitCode !== 0) {
    throw previewExportError(schematicPath, result)
  }
  const svgFiles = (await readdir(directory)).filter(file => file.toLowerCase().endsWith('.svg')).sort()
  if (svgFiles.length === 0) throw new Error('KiCad SVG export completed without producing an SVG')
  const rootSvg = `${basename(schematicPath, '.kicad_sch')}.svg`
  const requested = pageNames.map(name => `${name}.svg`)
  const missing = requested.filter(name => !svgFiles.includes(name))
  if (missing.length > 0) throw new Error(`code=PREVIEW_PAGE_NOT_FOUND; retryUnchanged=false; missingPages=${JSON.stringify(missing)}; availablePages=${JSON.stringify(svgFiles.map(file => basename(file, '.svg')))}. Use an exact available page name.`)
  const ordered = pageNames.length > 0 ? requested
    : [...svgFiles.filter(file => file === rootSvg), ...svgFiles.filter(file => file !== rootSvg)]
  const selected = ordered.slice(0, config.previewMaxPages)
  const pages: PreviewPage[] = []
  const failures: PreviewFailure[] = []
  for (const svg of selected) {
    signal.throwIfAborted()
    const svgPath = join(directory, svg)
    const pngPath = join(directory, `${basename(svg, '.svg')}.png`)
    const exportedPageName = basename(svg, '.svg')
    let stage = 'svg_rasterization'
    try {
      const data = await rasterizePage(svgPath, config)
      signal.throwIfAborted()
      stage = 'png_write'
      await writeFile(pngPath, data)
      const matches = sources.filter(source => source.exportedPageName === exportedPageName)
      pages.push({ pageIndex: pages.length + 1, exportedPageName,
        pageSchematicPath: matches.length === 1 ? matches[0]!.schematicPath : null, svgPath, pngPath })
    } catch (error) {
      signal.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ code: message.includes('pixel limit') ? 'PREVIEW_PIXEL_LIMIT' : 'PREVIEW_PAGE_FAILED',
        page: exportedPageName, svgPath, stage, message, retryUnchanged: false,
        nextAction: 'Read successful pages[].pngPath. This page has no returned PNG. Keep the generated schematic; report the failed preview or inspect the schematic in KiCad. Do not repeat the same request, change paper size, or export a netlist to repair a preview.' })
    }
  }
  const saved: PreviewManifest = {
    failures, sourceSchematicPath: schematicPath, revision, sources,
    density: config.previewDensity,
    maxWidth: config.previewMaxWidth,
    maxPages: config.previewMaxPages,
    padding: config.previewPadding,
    trimThreshold: config.previewTrimThreshold,
    pageCount: svgFiles.length,
    truncated: svgFiles.length > pages.length,
    pages: pages.map(page => ({ pageIndex: page.pageIndex,
      svg: basename(page.svgPath), png: basename(page.pngPath),
      pageSchematicPath: page.pageSchematicPath })),
  }
  const manifestPath = join(directory, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(saved, null, 2) + '\n', 'utf8')
  return { manifestPath, cached: false, pageCount: saved.pageCount, truncated: saved.truncated, pages, failures }
}
