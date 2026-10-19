/** Produce revision-mapped module images from schematic coordinates, without cropping a resized PNG. */
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { children, parse, value } from './sexpr.ts'
import { rasterizePage, type PreviewConfig, type PreviewFailure, type PreviewPage } from './preview.ts'

/** Rectangle coordinates in schematic millimetres on a named exported page. */
export interface PreviewRegion { name: string; pageName: string; start: [number, number]; end: [number, number] }
/** A region image and its exact source mapping. */
export interface RegionImage extends PreviewRegion { pngPath: string; schematicPath: string | null; revision: string }

function point(input: unknown): [number, number] {
  if (!Array.isArray(input) || input.length !== 2 || input.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error('code=PREVIEW_REGION_INVALID; retryUnchanged=false; start/end must be two finite millimetre coordinates')
  }
  return input as [number, number]
}

/** Resolve explicit crops or discover annotated top-level rectangles on the root sheet.
 * @param input Model JSON; omission selects automatic annotated frames, an empty list disables crops.
 * @param source Root schematic text.
 * @param rootName Exact exported root page name.
 * @param limit Maximum region count accepted by the deployment.
 * @returns Validated region rectangles; these do not establish electrical module membership.
 */
export function resolvePreviewRegions(input: unknown, source: string, rootName: string, limit: number): PreviewRegion[] {
  if (input === undefined) {
    const root = parse(source)
    const texts = children(root, 'text').flatMap(text => {
      const at = children(text, 'at')[0]
      return at ? [{ name: value(text).split('\n')[0]!, at: [Number(value(at, 1)), Number(value(at, 2))] }] : []
    })
    input = children(root, 'rectangle').flatMap(rectangle => {
      const a = children(rectangle, 'start')[0], b = children(rectangle, 'end')[0]
      if (!a || !b) return []
      const start = [Math.min(Number(value(a, 1)), Number(value(b, 1))), Math.min(Number(value(a, 2)), Number(value(b, 2)))]
      const end = [Math.max(Number(value(a, 1)), Number(value(b, 1))), Math.max(Number(value(a, 2)), Number(value(b, 2)))]
      const title = texts.filter(t => t.name.trim() && t.at[0]! >= start[0]! && t.at[0]! <= end[0]!
        && t.at[1]! >= start[1]! && t.at[1]! <= end[1]!).sort((x, y) => x.at[1]! - y.at[1]! || x.at[0]! - y.at[0]!)[0]
      return title ? [{ name: title.name, pageName: rootName, start, end }] : []
    })
  }
  if (!Array.isArray(input) || input.length > limit) throw new Error(`code=PREVIEW_REGION_INVALID; retryUnchanged=false; regions must be an array of at most ${limit} rectangles`)
  return input.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('code=PREVIEW_REGION_INVALID; regions must contain objects')
    const item = entry as Record<string, unknown>
    if (Object.keys(item).some(k => !['name', 'pageName', 'start', 'end'].includes(k))
      || typeof item.name !== 'string' || !item.name.trim() || (item.pageName !== undefined && (typeof item.pageName !== 'string' || !item.pageName.trim()))) {
      throw new Error('code=PREVIEW_REGION_INVALID; retryUnchanged=false; each region needs name, start, end and optional pageName')
    }
    const start = point(item.start), end = point(item.end)
    if (start[0] >= end[0] || start[1] >= end[1]) throw new Error('code=PREVIEW_REGION_INVALID; retryUnchanged=false; end must lie below and right of start')
    return { name: item.name, pageName: item.pageName as string | undefined ?? rootName, start, end }
  })
}

function millimetres(tag: string, dimension: string): number {
  const match = new RegExp(`\\b${dimension}="([0-9.+-]+)(mm|cm|in)"`, 'u').exec(tag)
  if (!match) throw new Error('SVG physical width/height must use mm, cm or in to map schematic coordinates')
  const size = Number(match[1]) * (match[2] === 'cm' ? 10 : match[2] === 'in' ? 25.4 : 1)
  if (!Number.isFinite(size) || size <= 0) throw new Error('SVG physical dimensions must be positive')
  return size
}

/** Render region crops from successful page exports and record the source revision in a manifest.
 * @param pages Successful page previews only.
 * @param regions Validated millimetre rectangles.
 * @param revision Source revision shared with the page manifest.
 * @param manifestPath Existing page manifest path.
 * @param config Rendering limits.
 * @param signal Cancellation from the tool call.
 * @returns Only existing region images, plus failures and the region manifest path.
 */
export async function renderPreviewRegions(pages: PreviewPage[], regions: PreviewRegion[], revision: string,
  manifestPath: string, config: PreviewConfig, signal: AbortSignal): Promise<{
    regionImages: RegionImage[]; regionManifestPath: string; failures: PreviewFailure[]
  }> {
  const regionImages: RegionImage[] = [], failures: PreviewFailure[] = []
  for (const region of regions) {
    signal.throwIfAborted()
    const page = pages.find(p => p.exportedPageName === region.pageName)
    try {
      if (!page) throw new Error('Requested page has no successful preview; select a successful page or render it by pageNames first')
      const svg = await readFile(page.svgPath, 'utf8')
      const tag = /<svg\b[^>]*>/u.exec(svg)?.[0] ?? ''
      const box = /\bviewBox="([^"]+)"/u.exec(tag)?.[1]?.trim().split(/\s+/u).map(Number)
      const w = millimetres(tag, 'width'), h = millimetres(tag, 'height')
      if (box?.length !== 4 || box.some(n => !Number.isFinite(n)) || box[2]! <= 0 || box[3]! <= 0) throw new Error('SVG lacks a positive viewBox')
      if (region.start[0] < 0 || region.start[1] < 0 || region.end[0] > w || region.end[1] > h) throw new Error('Region bounds lie outside the exported paper; use in-page schematic coordinates')
      const crop: [number, number, number, number] = [box[0]! + region.start[0] * box[2]! / w,
        box[1]! + region.start[1] * box[3]! / h, (region.end[0] - region.start[0]) * box[2]! / w,
        (region.end[1] - region.start[1]) * box[3]! / h]
      const key = createHash('sha256').update(JSON.stringify({ revision, region })).digest('hex').slice(0, 20)
      const pngPath = join(dirname(page.pngPath), `region-${key}.png`)
      try { await stat(pngPath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await writeFile(pngPath, await rasterizePage(page.svgPath, config, crop))
      }
      regionImages.push({ ...region, pngPath, schematicPath: page.pageSchematicPath, revision })
    } catch (error) {
      signal.throwIfAborted()
      failures.push({ code: 'PREVIEW_REGION_FAILED', page: region.pageName, svgPath: page?.svgPath ?? '',
        stage: 'region_rasterization', message: `${region.name}: ${error instanceof Error ? error.message : String(error)}`,
        retryUnchanged: false, nextAction: 'Use successful pages[].pngPath or regionImages[].pngPath. Correct region coordinates/pageName; do not rewrite the schematic or invent an image path.' })
    }
  }
  const key = createHash('sha256').update(JSON.stringify(regions)).digest('hex').slice(0, 20)
  const regionManifestPath = join(dirname(manifestPath), `regions-${key}.json`)
  await writeFile(regionManifestPath, JSON.stringify({ revision, pageManifestPath: manifestPath, regionImages, failures }, null, 2) + '\n')
  return { regionImages, regionManifestPath, failures }
}
