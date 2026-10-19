/** Import a verified symbol/footprint pair into project-local KiCad libraries. */
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { parse, children, value, quote } from '../schematic/sexpr.ts'
import { importSymbol, libraryName, type ProjectFileSystem } from './import-symbol.ts'
import { collectPins, fetchModelText, fetchSymbolSource, inspectBuilderCompatibility, summarizeFootprint, type ModelFetchOptions } from './models.ts'
import { getModelUrls } from './service.ts'

type Policy = Parameters<ProjectFileSystem['writeText']>[4]

export async function importComponent(mfgId: string, mpn: string, projectDir: string | undefined,
  workspaceRoot: string, options: ModelFetchOptions, fs: ProjectFileSystem, policy: Policy,
  signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const workspace = await fs.resolve(workspaceRoot, { signal })
  const project = await fs.resolve(projectDir ?? workspaceRoot, { cwd: workspaceRoot, signal })
  if (!fs.contains(workspace, project) || (await fs.stat(project, signal))?.type !== 'directory' || !isAbsolute(project.displayPath)) {
    throw new Error('projectDir must be an existing directory inside the current session workspace')
  }
  // Invocation-local metadata snapshot. Do not clone/cache streamed model files:
  // an unread tee branch would interfere with bounded readers and cancellation.
  const responses = new Map<string, Promise<Response>>()
  const cachedFetch: typeof fetch = async (input, init) => {
    if (!String(input).endsWith('/productDetail')) return fetcher(input, init)
    const key = `${String(input)}:${init?.method ?? 'GET'}:${String(init?.body ?? '')}`
    let pending = responses.get(key)
    if (!pending) {
      pending = fetcher(input, init).then(response => {
        if (!response.ok) responses.delete(key)
        return response
      }).catch(error => { responses.delete(key); throw error })
      responses.set(key, pending)
    }
    return (await pending).clone()
  }
  const urls = await getModelUrls(mfgId, mpn, options, signal, cachedFetch)
  if (!urls.symbol || !urls.footprint) throw new Error('COMPONENT_MODELS_REQUIRED: both symbol and footprint URLs are required')
  const [source, rawFootprint] = await Promise.all([
    fetchSymbolSource(mfgId, mpn, options, signal, cachedFetch),
    fetchModelText(urls.footprint, 'footprint', options, signal, cachedFetch),
  ])
  const form = parse(rawFootprint)
  if (!['footprint', 'module'].includes(form.head)) throw new Error('Downloaded footprint is not a KiCad footprint')
  const footprintName = value(form)
  if (!footprintName || /[<>:"/\\|?*\x00-\x1f]/u.test(footprintName) || /[. ]$/u.test(footprintName)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(footprintName)) throw new Error('Footprint name is not a safe local filename')
  const summary = summarizeFootprint(rawFootprint)
  if (summary.status !== 'parsed' || !summary.padCount) throw new Error('Footprint must have parsed pads')
  const pins = [...new Set(collectPins(source.symbol).map(pin => pin.number))].sort()
  const pads = [...new Set(summary.pads.map(pad => pad.number).filter(Boolean))].sort()
  const missingPads = pins.filter(pin => !pads.includes(pin))
  const extraPads = pads.filter(pad => !pins.includes(pad))
  if (!pins.length || pins.some(pin => !pin) || missingPads.length || extraPads.length) {
    throw new Error(`PIN_PAD_MISMATCH: missing pads [${missingPads.join(',')}], extra numbered pads [${extraPads.join(',')}]`)
  }
  const compatibility = inspectBuilderCompatibility(source.symbol, source.text)
  if (compatibility.status !== 'ready') throw new Error(`SYMBOL_UNITS_UNSUPPORTED: ${mfgId}:${mpn}; symbol ${source.symbol.name}; sections [${(source.symbol.children ?? []).map(child => child.name).join(', ')}]; source ${source.sourceUrl}; ${compatibility.nextAction}`)
  const nickname = libraryName(mfgId, mpn)
  const footprintText = rawFootprint.endsWith('\n') ? rawFootprint : `${rawFootprint}\n`
  const legacy = await fs.resolve(join(project.displayPath, `${nickname}.pretty`), { signal })
  const legacyExists = await fs.stat(legacy, signal) !== undefined
  const footprint = await fs.resolve(join(project.displayPath, ...(legacyExists ? [] : ['libraries', 'footprints']), `${nickname}.pretty`, `${footprintName}.kicad_mod`), { signal })
  const table = await fs.resolve(join(project.displayPath, 'fp-lib-table'), { signal })
  if (!fs.contains(project, footprint) || !fs.contains(project, table)) throw new Error('Footprint targets must stay inside projectDir')
  const info = await fs.stat(footprint, signal)
  if (info && (info.type !== 'file' || await fs.readText(footprint, signal) !== footprintText)) throw new Error('Footprint already exists with different content')
  const tableInfo = await fs.stat(table, signal)
  if (tableInfo && tableInfo.type !== 'file') throw new Error('fp-lib-table must be a regular file')
  const oldTable = tableInfo ? await fs.readText(table, signal) : null
  const uri = `\${KIPRJMOD}/${legacyExists ? '' : 'libraries/footprints/'}${nickname}.pretty`
  const entry = `  (lib (name ${quote(nickname)})(type "KiCad")(uri ${quote(uri)})(options "")(descr ""))`
  let nextTable: string | null
  if (oldTable === null) nextTable = `(fp_lib_table\n  (version 7)\n${entry}\n)\n`
  else {
    const root = parse(oldTable)
    if (root.head !== 'fp_lib_table') throw new Error('fp-lib-table has no fp_lib_table root')
    const existing = children(root, 'lib').filter(lib => children(lib, 'name').some(name => value(name) === nickname))
    if (existing.length > 1 || existing.some(lib =>
      children(lib, 'uri').length !== 1 || value(children(lib, 'uri')[0]!) !== uri
      || children(lib, 'type').length !== 1 || value(children(lib, 'type')[0]!) !== 'KiCad'
      || children(lib, 'options').length !== 1 || value(children(lib, 'options')[0]!) !== '')) throw new Error('fp-lib-table has a conflicting registration')
    nextTable = existing.length ? null : `${oldTable.slice(0, root.end - 1)}\n${entry}\n${oldTable.slice(root.end - 1)}`
  }
  // All model and footprint-target checks precede mutation. Writes are guarded individually,
  // not a filesystem transaction; report partial paths for recovery on any later failure.
  let symbol: Awaited<ReturnType<typeof importSymbol>>
  try {
    symbol = await importSymbol(mfgId, mpn, projectDir, workspaceRoot, options, fs, policy, signal, cachedFetch, source)
    signal.throwIfAborted()
    if (!info) await fs.writeText(footprint, footprintText, { kind: 'createIfAbsent' }, signal, policy)
    if (nextTable !== null) await fs.writeText(table, nextTable, tableInfo
      ? { kind: 'replaceIfVersion', version: tableInfo.version } : { kind: 'createIfAbsent' }, signal, policy)
  } catch (error) {
    throw new Error(`Component import failed; inspect project libraries and tables in ${project.displayPath}, footprint ${footprint.displayPath}. Some files may already have been written.`, { cause: error })
  }
  return {
    ...symbol, hasSymbol: true, hasFootprint: true,
    footprintId: `${nickname}:${footprintName}`, footprintPath: footprint.displayPath,
    footprintTablePath: table.displayPath, footprintSourceUrl: urls.footprint.href,
    footprintSha256: createHash('sha256').update(footprintText).digest('hex'),
    footprintLibrary: info ? 'existing' : 'created',
    footprintTable: nextTable === null ? 'existing' : tableInfo ? 'updated' : 'created',
    padCount: summary.padCount,
    validation: { pinPadMatch: 'number_sets_match', pinNumbers: pins, padNumbers: pads,
      electricalCompatibility: 'not_checked', packageDimensions: 'not_checked' },
    nextAction: 'Place with addSymbol({libraryPath, libId, footprint: footprintId, ...}). Confirm exact part, physical package dimensions and pin functions against the datasheet before PCB layout.',
  }
}
