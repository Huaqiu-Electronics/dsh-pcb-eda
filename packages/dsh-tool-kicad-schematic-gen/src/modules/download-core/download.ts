/** Download one module ZIP and read its sole KiCad schematic without extracting paths to disk. */
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'

/** Deployment-owned host and limits for one module download. */
export interface DownloadOptions {
  apiBaseUrl: string
  requestTimeoutMs: number
  maxDetailBytes: number
  maxZipBytes: number
  maxSchematicBytes: number
  maxProjectBytes: number
  maxArchiveEntries: number
}

/** Optional source project retained as evidence but never activated directly. */
export interface DownloadedProject {
  archiveEntry: string
  text: string
  bytes: number
  sha256: string
}

/** Verified content from the module registry and archive. */
export interface DownloadedSchematic {
  moduleId: string
  moduleName: string
  sourceUrl: string
  archiveEntry: string
  archiveEntries: string[]
  text: string
  bytes: number
  sha256: string
  project?: DownloadedProject
  footprints?: {archiveEntry:string;text:string;sha256:string}[]
}

/** Reject invalid deployment settings before the plugin registers a tool. */
export function validateDownloadOptions(options: DownloadOptions): URL {
  const base = new URL(options.apiBaseUrl)
  if (base.protocol !== 'https:' || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('hq-eda-schematic-download: apiBaseUrl must be an HTTPS origin without credentials, path, query, or fragment')
  }
  for (const [field, value, max] of [
    ['requestTimeoutMs', options.requestTimeoutMs, 120000],
    ['maxDetailBytes', options.maxDetailBytes, 10000000],
    ['maxZipBytes', options.maxZipBytes, 100000000],
    ['maxSchematicBytes', options.maxSchematicBytes, 50000000],
    ['maxProjectBytes', options.maxProjectBytes, 50000000],
    ['maxArchiveEntries', options.maxArchiveEntries, 10000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`hq-eda-schematic-download: ${field} must be an integer from 1 to ${max}`)
    }
  }
  return base
}

/** Module IDs are used only in requests and a deterministic output filename. */
export function validateModuleId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('moduleId must contain 1 to 128 letters, digits, underscores, or hyphens')
  }
  return value
}

function archiveUrl(base: URL, fileZip: unknown): URL {
  if (typeof fileZip !== 'string' || !fileZip.startsWith('/') || fileZip.startsWith('//')
    || !fileZip.toLowerCase().endsWith('.zip')
    || fileZip.slice(1).split('/').some(segment => !/^[A-Za-z0-9._-]+$/.test(segment)
      || segment === '.' || segment === '..')) {
    throw new Error('module detail has an invalid file_zip path')
  }
  return new URL(fileZip, base)
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('module download: empty upstream response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new Error('module download: upstream response exceeds configured byte limit')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
    if (length > maxBytes) await response.body.cancel()
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function fetchBounded(
  url: URL,
  maxBytes: number,
  options: DownloadOptions,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]),
  })
  if (!response.ok) throw new Error(`module download ${url.pathname}: HTTP ${response.status}`)
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader !== null && Number(lengthHeader) > maxBytes) {
    await response.body?.cancel()
    throw new Error(`module download ${url.pathname}: response exceeds configured byte limit`)
  }
  return readBounded(response, maxBytes)
}

function parseDetail(bytes: Uint8Array, moduleId: string): { name: string; fileZip: unknown } {
  const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('module detail response must be an object')
  }
  const result = (payload as Record<string, unknown>).result
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('module detail response lacks result')
  }
  const fields = result as Record<string, unknown>
  if (fields.id !== moduleId || typeof fields.name !== 'string' || !fields.name.trim()) {
    throw new Error('module detail returned a different ID or no name')
  }
  return { name: fields.name, fileZip: fields.file_zip }
}

interface ExtractedArchive {
  archiveEntries: string[]
  schematic: { entry: string; bytes: Uint8Array }
  project?: { entry: string; bytes: Uint8Array }
  footprints: {entry:string;bytes:Uint8Array}[]
}

function siblingProject(schematic: string, projects: string[]): string | undefined {
  const expected = schematic.replace(/\.kicad_sch$/iu, '.kicad_pro')
  const exact = projects.filter(entry => entry.toLowerCase() === expected.toLowerCase())
  if (exact.length === 1) return exact[0]
  return projects.length === 1 ? projects[0] : undefined
}

function extractArchive(zip: Uint8Array, options: DownloadOptions): ExtractedArchive {
  const archiveEntries: string[] = []
  const schematicEntries: string[] = []
  const projectEntries: string[] = []
  const footprintEntries:string[]=[]
  let footprintBytes=0
  unzipSync(zip, { filter: file => {
    if (file.name.endsWith('/')) return false
    if (file.name.length > 1024 || /[\u0000-\u001f\u007f]/u.test(file.name)) {
      throw new Error('module ZIP contains an invalid entry name')
    }
    archiveEntries.push(file.name)
    if (archiveEntries.length > options.maxArchiveEntries) {
      throw new Error('module ZIP exceeds maxArchiveEntries')
    }
    if(/\.kicad_mod$/iu.test(file.name)){
      if(file.name.includes('\\')||file.name.startsWith('/')||file.name.split('/').some(p=>p==='..'||p==='.'||p.includes(':')))throw new Error('Unsafe footprint archive path');
      footprintBytes+=file.originalSize;
      if(file.originalSize>options.maxSchematicBytes||footprintBytes>options.maxZipBytes)throw new Error('Module footprints exceed configured archive limits');
      if(footprintEntries.includes(file.name))throw new Error('Duplicate footprint archive entry');
      footprintEntries.push(file.name);return false;
    }
    if (/\.kicad_sch$/iu.test(file.name)) {
      if (file.originalSize > options.maxSchematicBytes) throw new Error('KiCad schematic exceeds maxSchematicBytes')
      schematicEntries.push(file.name)
      if (schematicEntries.length > 1) throw new Error('module ZIP contains more than one KiCad schematic')
      return false
    }
    if (/\.kicad_pro$/iu.test(file.name)) {
      if (file.originalSize > options.maxProjectBytes) throw new Error('KiCad project exceeds maxProjectBytes')
      projectEntries.push(file.name)
      return false
    }
    return false
  } })
  const entry = schematicEntries[0]
  if (entry === undefined) throw new Error('module ZIP contains no KiCad schematic')
  const projectEntry = siblingProject(entry, projectEntries)
  const selectedEntries = new Set([entry,...(projectEntry?[projectEntry]:[]),...footprintEntries])
  const files = unzipSync(zip, { filter: file => selectedEntries.has(file.name) })
  let actualFootprintBytes=0;
  for(const entry of footprintEntries){
    const asset=files[entry];if(!asset||asset.byteLength>options.maxSchematicBytes)throw new Error('Footprint entry exceeds configured size');
    actualFootprintBytes+=asset.byteLength;
    if(actualFootprintBytes>options.maxZipBytes)throw new Error('Extracted footprints exceed configured limit');
  }
  const bytes = files[entry]
  if (bytes === undefined) throw new Error('module ZIP contains no KiCad schematic')
  if (bytes.byteLength > options.maxSchematicBytes) throw new Error('KiCad schematic exceeds maxSchematicBytes')
  const projectBytes = projectEntry === undefined ? undefined : files[projectEntry]
  if (projectBytes !== undefined && projectBytes.byteLength > options.maxProjectBytes) {
    throw new Error('KiCad project exceeds maxProjectBytes')
  }
  const result = { archiveEntries: archiveEntries.sort(), schematic: { entry, bytes },footprints:footprintEntries.map(entry=>({entry,bytes:files[entry]!})) }
  return projectEntry === undefined || projectBytes === undefined
    ? result : { ...result, project: { entry: projectEntry, bytes: projectBytes } }
}

/** Fetch and validate the selected module's `.kicad_sch` content; no file is written here. */
export async function downloadSchematic(
  moduleId: string,
  options: DownloadOptions,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DownloadedSchematic> {
  validateModuleId(moduleId)
  const base = validateDownloadOptions(options)
  const detailUrl = new URL('/api_module/module/detail', base)
  detailUrl.searchParams.set('moduleId', moduleId)
  const detail = parseDetail(await fetchBounded(detailUrl, options.maxDetailBytes, options, signal, fetcher), moduleId)
  const sourceUrl = archiveUrl(base, detail.fileZip)
  const zip = await fetchBounded(sourceUrl, options.maxZipBytes, options, signal, fetcher)
  signal.throwIfAborted()
  const archive = extractArchive(zip, options)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(archive.schematic.bytes)
  if (!/^\s*\(kicad_sch(?=\s|\()/.test(text)) {
    throw new Error('archive entry is not a KiCad schematic')
  }
  let project: DownloadedProject | undefined
  if (archive.project !== undefined) {
    const projectText = new TextDecoder('utf-8', { fatal: true }).decode(archive.project.bytes)
    const parsed: unknown = JSON.parse(projectText)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('archive project entry must contain a JSON object')
    }
    project = {
      archiveEntry: archive.project.entry,
      text: projectText,
      bytes: archive.project.bytes.byteLength,
      sha256: createHash('sha256').update(archive.project.bytes).digest('hex'),
    }
  }
  const result = {
    moduleId,
    moduleName: detail.name,
    sourceUrl: sourceUrl.toString(),
    archiveEntry: archive.schematic.entry,
    archiveEntries: archive.archiveEntries,
    text,
    bytes: archive.schematic.bytes.byteLength,
    sha256: createHash('sha256').update(archive.schematic.bytes).digest('hex'),
    footprints:archive.footprints.map(file=>({archiveEntry:file.entry,text:new TextDecoder('utf-8',{fatal:true}).decode(file.bytes),sha256:createHash('sha256').update(file.bytes).digest('hex')})),
  }
  return project === undefined ? result : { ...result, project }
}
