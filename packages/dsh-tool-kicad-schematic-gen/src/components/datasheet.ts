import { PartNotFoundError } from '@huaqiu/part-search'
import { componentSource } from './service.ts'
/** Read bounded datasheet material for one manufacturer-specific IC. */

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Node's built-in fetch fixes connection setup at 10 seconds. Some datasheet
// CDNs on this network need longer, while each call remains bounded by its
// configured AbortSignal.
const HTTP_AGENT = new Agent({ connectTimeout: 60_000 })
const runtimeFetch: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  undiciFetch(input as string | URL,
    { ...init, dispatcher: HTTP_AGENT } as unknown as UndiciRequestInit) as unknown as Promise<Response>) as typeof fetch

type BinaryDataOptions = { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }

/** Load PDF.js support files from its installed package instead of fetching file URLs. */
class LocalBinaryDataFactory {
  private readonly roots: Record<string, string | null>

  constructor({ cMapUrl = null, standardFontDataUrl = null, wasmUrl = null }: BinaryDataOptions) {
    this.roots = { cMapUrl, standardFontDataUrl, wasmUrl }
  }

  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const root = this.roots[kind]
    if (!root) throw new Error(`PDF.js support path is not configured: ${kind}`)
    const data = await readFile(fileURLToPath(new URL(filename, root)))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
}

/** Deployment limits for upstream requests and model-visible results. */
export interface DatasheetOptions {
  structuredApiBaseUrl: string
  requestTimeoutMs: number
  maxPdfBytes: number
  maxPdfPages: number
  maxTextChars: number
  maxImages: number
  allowedPdfHosts: string[]
}

export interface DatasheetSection {
  contentType: number
  title: string
  text: string
  imageUrls: string[]
}

export interface DatasheetResult {
  part: string
  status: 'found' | 'missing'
  source: 'structured' | 'pdf' | 'none'
  datasheetUrl: string | null
  sections: DatasheetSection[]
  truncated: boolean
}

const SECTION_NAMES: Record<number, string> = {
  1: 'General description',
  6: 'Pin description',
  7: 'Absolute maximum ratings',
  8: 'DC electrical characteristics',
  11: 'Application information',
  12: 'Typical application circuits',
  14: 'Features',
}
const CONTENT_TYPES = Object.keys(SECTION_NAMES).join(',')

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

async function requestJson(url: URL, options: DatasheetOptions, signal: AbortSignal, fetcher: typeof fetch,
  body?: object): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: body ? 'POST' : 'GET',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: requestSignal(signal, options.requestTimeoutMs),
  })
  if (!response.ok) throw new Error(`datasheet ${url.pathname}: HTTP ${response.status}`)
  const payload = record(await response.json())
  if (payload === null) throw new Error(`datasheet ${url.pathname}: invalid JSON response`)
  return payload
}

function structuredSections(payload: Record<string, unknown>, options: DatasheetOptions): {
  sections: DatasheetSection[]; truncated: boolean
} {
  if (!Array.isArray(payload.records)) throw new Error('datasheet structured-content: invalid records')
  const rows = payload.records.map((value: unknown) => {
    const row = record(value)
    if (row === null || typeof row.contentType !== 'number') {
      throw new Error('datasheet structured-content: invalid record')
    }
    return row
  }).sort((a, b) => Number(a.pageNo) - Number(b.pageNo) || Number(a.readingOrder) - Number(b.readingOrder))
  const sections = new Map<number, { texts: string[]; images: string[] }>()
  for (const row of rows) {
    const type = row.contentType as number
    if (!(type in SECTION_NAMES)) continue
    const entry = sections.get(type) ?? { texts: [], images: [] }
    const text = [row.content, row.html].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n')
    if (text) entry.texts.push(text)
    if (row.blockType === 'image') {
      const imageUrl = httpsUrl(row.imageLink)
      if (imageUrl) entry.images.push(imageUrl)
    }
    sections.set(type, entry)
  }
  let remainingText = options.maxTextChars
  let remainingImages = options.maxImages
  let truncated = false
  const result = [...sections.entries()].map(([contentType, entry]): DatasheetSection => {
    const fullText = entry.texts.join('\n')
    const text = fullText.slice(0, remainingText)
    const imageUrls = entry.images.slice(0, remainingImages)
    remainingText -= text.length
    remainingImages -= imageUrls.length
    if (text.length < fullText.length || imageUrls.length < entry.images.length) truncated = true
    return { contentType, title: SECTION_NAMES[contentType]!, text, imageUrls }
  }).filter(section => section.text || section.imageUrls.length)
  return { sections: result, truncated }
}

async function searchPdfUrl(mfgId: string, mpn: string, options: DatasheetOptions, signal: AbortSignal,
  fetcher: typeof fetch): Promise<string | null> {
  try {
    const part = await componentSource(options, signal, fetcher).getPart({ manufacturerId: mfgId, mpn })
    const urls = part.documents.filter(document => /datasheet/i.test(document.type))
      .map(document => httpsUrl(document.url)).filter((url): url is string => url !== null)
    return urls.find(url => options.allowedPdfHosts.includes(new URL(url).hostname.toLowerCase())) ?? null
  } catch (error) {
    if (error instanceof PartNotFoundError) return null
    throw error
  }
}

async function readPdf(url: string, options: DatasheetOptions, signal: AbortSignal,
  fetcher: typeof fetch): Promise<{ text: string; truncated: boolean }> {
  const host = new URL(url).hostname.toLowerCase()
  if (!options.allowedPdfHosts.includes(host)) {
    throw new Error(`datasheet PDF host ${host} is not in allowedPdfHosts`)
  }
  const response = await fetcher(url, { redirect: 'error', signal: requestSignal(signal, options.requestTimeoutMs) })
  if (!response.ok) throw new Error(`datasheet PDF: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > options.maxPdfBytes) {
    await response.body?.cancel()
    throw new Error(`datasheet PDF exceeds ${options.maxPdfBytes} bytes`)
  }
  if (response.body === null) throw new Error('datasheet PDF: empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > options.maxPdfBytes) {
        await reader.cancel()
        throw new Error(`datasheet PDF exceeds ${options.maxPdfBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(bytesRead)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('datasheet PDF: invalid PDF header')
  }
  const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // The bundled parser still needs the version-matched worker from the package.
  GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  const pdfPackageUrl = import.meta.resolve('pdfjs-dist/package.json')
  const loading = getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
    cMapUrl: new URL('./cmaps/', pdfPackageUrl).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./standard_fonts/', pdfPackageUrl).href,
    useWorkerFetch: false,
    BinaryDataFactory: LocalBinaryDataFactory,
  })
  try {
    const document = await loading.promise
    let text = ''
    const pageCount = Math.min(document.numPages, options.maxPdfPages)
    for (let pageNumber = 1; pageNumber <= pageCount && text.length < options.maxTextChars; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      text += `\n[page ${pageNumber}]\n` + content.items.map(item => 'str' in item ? item.str : '').join(' ')
      page.cleanup()
    }
    return { text: text.trim().slice(0, options.maxTextChars),
      truncated: document.numPages > pageCount || text.length > options.maxTextChars }
  } finally {
    await loading.destroy()
  }
}

/**
 * Read one selected IC's datasheet without writing files. Structured sections
 * and HTTPS image links take precedence; PDF text is a bounded fallback only
 * when no structured text exists. Missing sources return `status: missing`.
 */
export async function getDatasheet(mfgId: string, mpn: string, options: DatasheetOptions,
  signal: AbortSignal, fetcher: typeof fetch = runtimeFetch): Promise<DatasheetResult> {
  const part = `${mfgId}:${mpn}`
  const base = new URL(options.structuredApiBaseUrl)
  const countUrl = new URL('structured-content/count', base)
  countUrl.searchParams.set('mfgId', mfgId)
  countUrl.searchParams.set('mpn', mpn)
  const count = await requestJson(countUrl, options, signal, fetcher)
  const datasheetUrl = httpsUrl(count.datasheetUrl)
  if (count.hasLabelData === true) {
    const contentUrl = new URL('structured-content', base)
    contentUrl.searchParams.set('mfgId', mfgId)
    contentUrl.searchParams.set('mpn', mpn)
    contentUrl.searchParams.set('contentTypes', CONTENT_TYPES)
    const content = await requestJson(contentUrl, options, signal, fetcher)
    const result = structuredSections(content, options)
    if (result.sections.some(section => section.text.length > 0)) {
      return { part, status: 'found', source: 'structured', datasheetUrl,
        sections: result.sections, truncated: result.truncated }
    }
  }
  // The exact structured lookup may supply the PDF even when no parsed text exists.
  // Reuse it to avoid a slower, less reliable second lookup against the search API.
  const pdfUrl = datasheetUrl ?? await searchPdfUrl(mfgId, mpn, options, signal, fetcher)
  if (pdfUrl === null) {
    return { part, status: 'missing', source: 'none', datasheetUrl,
      sections: [], truncated: false }
  }
  const pdf = await readPdf(pdfUrl, options, signal, fetcher)
  if (!pdf.text) {
    return { part, status: 'missing', source: 'none', datasheetUrl: pdfUrl,
      sections: [], truncated: pdf.truncated }
  }
  return { part, status: 'found', source: 'pdf', datasheetUrl: pdfUrl,
    sections: [{ contentType: 0, title: 'PDF extracted text', text: pdf.text, imageUrls: [] }],
    truncated: pdf.truncated }
}
