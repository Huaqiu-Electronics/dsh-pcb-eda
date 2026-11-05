/** Persist one selected upstream Symbol in a KiCad project's own library table. */

import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { fetchSymbolSource, inspectBuilderCompatibility, type BuilderCompatibility, type ModelFetchOptions } from './models.ts'
import { normalizeCommonUnits } from '../schematic/symbol-units.ts'
import { mergeSymbolProperties, assignSymbolFootprint } from './symbol-properties.ts'

export type ProjectFileSystem = Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'readText' | 'writeText'>
type WritePolicy = Parameters<FileSystem['writeText']>[4]

export interface ImportedSymbol {
  part: string
  libId: string
  libraryPath: string
  tablePath: string
  sourceUrl: string
  sha256: string
  pinCount: number
  symbolTextRepaired: boolean
  builderCompatibility: BuilderCompatibility
  library: 'created' | 'existing'
  table: 'created' | 'updated' | 'existing'
}

/** Compact public response; the paired importer retains the full internal result. */
export function summarizeImportedSymbol(result:ImportedSymbol) {
  const compatibility=result.builderCompatibility
  return {
    part:result.part,libId:result.libId,libraryPath:result.libraryPath,
    units:compatibility.availableUnits,library:result.library,table:result.table,
    ...(result.symbolTextRepaired?{symbolTextRepaired:true}:{}),
    ...(compatibility.normalization?{normalization:compatibility.normalization}:{}),
    ...(compatibility.status==='unsupported_units'
      ?{error:{code:'SYMBOL_UNITS_UNSUPPORTED',nextAction:compatibility.nextAction}}:{}),
  }
}

/** Save provenance beside the local library, keeping verbose metadata out of tool output. */
export async function saveSymbolImportRecord(result:ImportedSymbol,workspaceRoot:string,
  fs:ProjectFileSystem,policy:WritePolicy,signal:AbortSignal):Promise<void> {
  const workspace=await fs.resolve(workspaceRoot,{signal})
  const target=await fs.resolve(`${result.libraryPath}.import.json`,{signal})
  if(!fs.contains(workspace,target))throw new Error('Symbol import record must stay inside workspace')
  const info=await fs.stat(target,signal)
  if(info&&info.type!=='file')throw new Error(`Symbol import record is not a file: ${target.displayPath}`)
  const text=JSON.stringify({version:1,...result},null,2)+'\n'
  if(info&&await fs.readText(target,signal)===text)return
  try {
    await fs.writeText(target,text,info?{kind:'replaceIfVersion',version:info.version}:{kind:'createIfAbsent'},signal,policy)
  }catch(error){
    throw new Error(`Symbol imported at ${result.libraryPath}, but import record could not be saved at ${target.displayPath}. Inspect existing files before retrying.`,{cause:error})
  }
}

export function libraryName(mfgId: string, mpn: string): string {
  const readable = mpn.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'part'
  const suffix = createHash('sha256').update(mpn).digest('hex').slice(0, 12)
  return `kicad_lib_${mfgId}_${readable}_${suffix}`
}

function rootClose(text: string): number {
  if (!/^\s*\(sym_lib_table(?=\s|\()/.test(text)) throw new Error('sym-lib-table has no sym_lib_table root')
  let depth = 0
  let quoted = false
  let escaped = false
  let comment = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (comment) {
      if (char === '\n') comment = false
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '#' || char === ';') {
      comment = true
      continue
    }
    if (char === '"') quoted = true
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth < 0) break
      if (depth === 0) {
        if (text.slice(index + 1).trim() !== '') break
        return index
      }
    }
  }
  throw new Error('sym-lib-table contains unbalanced or trailing content')
}

function updatedTable(text: string | null, nickname: string, uri: string): string | null {
  const entry = `  (lib (name "${nickname}")(type "KiCad")(uri "${uri}")(options "")(descr ""))`
  if (text === null) return `(sym_lib_table\n  (version 7)\n${entry}\n)\n`
  const close = rootClose(text)
  if (text.includes(`(name "${nickname}")`)) {
    if (text.includes(entry)) return null
    throw new Error(`sym-lib-table already defines ${nickname} with different metadata`)
  }
  return `${text.slice(0, close)}${text.slice(0, close).endsWith('\n') ? '' : '\n'}${entry}\n${text.slice(close)}`
}

/** Count S-expression nesting depth; a negative result means too many closing parentheses. */
function symbolDepth(text: string): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
  }
  return depth
}

/**
 * Upstream Symbol libraries are not always balanced; a served sample carried one
 * extra trailing ")". The strict KiCad parser used downstream rejects such a file
 * outright, so the single provable shape (exactly one extra ")" at end of file) is
 * repaired here, and every other imbalance is refused rather than written out.
 */
function balancedSymbolText(text: string, part: string): string {
  const diff = symbolDepth(text)
  if (diff === 0) return text
  if (diff === -1) {
    const trimmed = text.replace(/\s+$/u, '')
    if (!trimmed.endsWith(')')) {
      throw new Error(`upstream Symbol for ${part} is unbalanced and cannot be safely repaired`)
    }
    return `${trimmed.slice(0, -1).replace(/\s+$/u, '')}\n`
  }
  throw new Error(`upstream Symbol for ${part} is unbalanced (missing ${diff} ')'); refusing to import`)
}

/**
 * Write only within the active session workspace and an existing project directory.
 * Different existing libraries are refused. Paired import may bind the verified
 * footprint on an otherwise identical unbound library using version checks.
 * A failed table write can leave a new
 * unregistered library file, whose path is included in the error for recovery.
 */
export async function importSymbol(
  mfgId: string,
  mpn: string,
  projectDir: string | undefined,
  workspaceRoot: string,
  options: ModelFetchOptions,
  fs: ProjectFileSystem,
  policy: WritePolicy,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  preparedSource?: Awaited<ReturnType<typeof fetchSymbolSource>>,
  defaultFootprintId?: string,
): Promise<ImportedSymbol> {
  const workspace = await fs.resolve(workspaceRoot, { signal })
  const project = await fs.resolve(projectDir ?? workspaceRoot, { cwd: workspaceRoot, signal })
  const projectInfo = await fs.stat(project, signal)
  if (!fs.contains(workspace, project) || projectInfo?.type !== 'directory') {
    throw new Error('projectDir must be an existing directory inside the current session workspace')
  }
  if (!isAbsolute(project.displayPath)) throw new Error('projectDir must resolve to a local absolute path')

  const source = preparedSource ?? await fetchSymbolSource(mfgId, mpn, options, signal, fetcher)
  if (source.symbol.name.length === 0 || source.symbol.name.includes(':')) {
    throw new Error('upstream Symbol name must be non-empty and must not contain a colon')
  }
  const nickname = libraryName(mfgId, mpn)
  const library = await fs.resolve(join(project.displayPath, 'libraries', 'symbols', `${nickname}.kicad_sym`), { signal })
  const uri = `\${KIPRJMOD}/libraries/symbols/${nickname}.kicad_sym`
  const table = await fs.resolve(join(project.displayPath, 'sym-lib-table'), { signal })
  if (!fs.contains(project, library) || !fs.contains(project, table)) {
    throw new Error('project library targets must stay inside projectDir')
  }

  const rawText = source.text.endsWith('\n') ? source.text : `${source.text}\n`
  const balancedText = balancedSymbolText(rawText, `${mfgId}:${mpn}`)
  const enrichedText = normalizeCommonUnits(mergeSymbolProperties(balancedText, source.part))
  let normalizedText = defaultFootprintId ? assignSymbolFootprint(enrichedText,defaultFootprintId) : enrichedText
  if (Buffer.byteLength(normalizedText)>options.maxModelBytes)throw new Error('Enriched symbol exceeds maxModelBytes')
  const symbolTextRepaired = balancedText !== rawText
  const libraryInfo = await fs.stat(library, signal)
  const existingText=libraryInfo?.type==='file'?await fs.readText(library,signal):undefined
  // A later symbol-only call must retain a verified binding made by paired import.
  if(!defaultFootprintId && existingText && !/[:\r\n]/u.test(mpn)
    && assignSymbolFootprint(enrichedText,`kicad_api_lib:${mpn}`)===existingText)normalizedText=existingText
  // Upgrade an otherwise identical unbound symbol (e.g. a prior symbol-only import).
  const bindExisting=!!defaultFootprintId && existingText===enrichedText && existingText!==normalizedText
  if (libraryInfo !== undefined && (libraryInfo.type !== 'file' || (existingText !== normalizedText && !bindExisting))) {
    throw new Error(`Symbol library already exists with different content: ${library.displayPath}`)
  }
  const tableInfo = await fs.stat(table, signal)
  if (tableInfo !== undefined && tableInfo.type !== 'file') throw new Error(`sym-lib-table is not a file: ${table.displayPath}`)
  const tableText = tableInfo === undefined ? null : await fs.readText(table, signal)
  const nextTable = updatedTable(tableText, nickname, uri)

  signal.throwIfAborted()
  if (libraryInfo === undefined) await fs.writeText(library, normalizedText, { kind: 'createIfAbsent' }, signal, policy)
  else if(bindExisting)await fs.writeText(library,normalizedText,{kind:'replaceIfVersion',version:libraryInfo.version},signal,policy)
  let tableOperation: ImportedSymbol['table'] = 'existing'
  if (nextTable !== null) {
    try {
      signal.throwIfAborted()
      await fs.writeText(table, nextTable, tableInfo === undefined
        ? { kind: 'createIfAbsent' }
        : { kind: 'replaceIfVersion', version: tableInfo.version }, signal, policy)
      tableOperation = tableInfo === undefined ? 'created' : 'updated'
    } catch (error) {
      throw new Error(`Symbol library ${library.displayPath} may be unregistered; sym-lib-table update failed`, { cause: error })
    }
  }
  const pins = (symbol: typeof source.symbol): number => (symbol.pins?.length ?? 0)
    + (symbol.children ?? []).reduce((count, child) => count + pins(child), 0)
  return {
    part: `${mfgId}:${mpn}`,
    libId: `${nickname}:${source.symbol.name}`,
    libraryPath: library.displayPath,
    tablePath: table.displayPath,
    sourceUrl: source.sourceUrl,
    sha256: createHash('sha256').update(normalizedText).digest('hex'),
    pinCount: pins(source.symbol),
    library: libraryInfo === undefined ? 'created' : 'existing',
    table: tableOperation,
    symbolTextRepaired,
    builderCompatibility: inspectBuilderCompatibility(source.symbol, balancedText),
  }
}
