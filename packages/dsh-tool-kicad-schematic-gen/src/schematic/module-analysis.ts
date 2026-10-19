/** KiCad-owned electrical extraction, separate from ERC and expected-net assertions. */
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, dirname, isAbsolute, join, resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {ToolRunContext} from '@deepseek-ai/dsh-tools'
import {getKiCadPaths} from '../runtime-paths.ts'
import {collectPreviewSources, readWorkspaceSchematic, readWorkspaceProject, resolvePreviewOutputDir} from './tools.ts'
import {runProcess} from './preview.ts'
import {parseNetlist} from './verify.ts'
import {applyEdits, children, parse, quote, required, value} from './sexpr.ts'

const version = 2
const maxBytes = 20 * 1024 * 1024
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
type Runner = typeof runProcess
export interface AnalysisConfig {kicadCliPath: string; maxSchematicBytes: number; previewTimeoutMs: number}
export interface AnalysisComponent {
  reference: string; value: string | null; footprint: string | null; sheetPath: string | null
  fields: Record<string, string>; dnp: boolean; excludeFromBom: boolean; excludeFromBoard: boolean
  /** Actual inclusion in the CLI BOM; null means BOM export was unavailable. */
  bomIncluded?: boolean | null
}
export interface AnalysisData {
  components: AnalysisComponent[] | null
  nets: ReturnType<typeof parseNetlist> | null
  bomAvailable: boolean
  inventoryScope: 'netlist' | 'bom_only' | 'unavailable'
}
export interface AnalysisResult {
  status: 'ready' | 'partial' | 'unavailable'; cached: boolean; revision?: string
  files?: {components: string; connectivity: string}
  counts?: {components?: number; nets?: number; dnp?: number; bom?: number}
  inventoryScope?: AnalysisData['inventoryScope']
  failure?: {code: 'CLI_START_FAILED' | 'CLI_PROBE_TIMEOUT' | 'CLI_CAPABILITY_UNSUPPORTED' | 'CLI_PROBE_FAILED'; executable: string}
  diagnostics: string[]; nextAction: string
}
export const cliRecoveryHint = 'Reuse get_eda_host_info installation.executables entry named kicad-cli (query host info only if absent). Call analyze_kicad_module with schematicPath, view:summary and kicadCliPath set to that absolute path. Do not download again or scan configuration directories.'
export type AnalyzeModule = (path: string, exec: ToolRunContext, options?: {sourceProjectPath?: string; kicadCliPath?: string; reusePartial?: boolean}) => Promise<{analysis: AnalysisResult; data?: AnalysisData}>

/** RFC-style quoted CSV cells, including escaped quotes, embedded commas and line breaks. */
export function parseBomCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  text = text.replace(/^\uFEFF/u, '')
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {cell += '"'; i++} else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell); cell = ''
      if (char !== ',') {if (row.some(c => c.length)) rows.push(row); row = []; if (char === '\r' && text[i + 1] === '\n') i++}
    } else cell += char
  }
  if (quoted) throw new Error('BOM CSV contains an unterminated quoted cell')
  row.push(cell); if (row.some(c => c.length)) rows.push(row)
  const headers = rows.shift()
  if (!headers || new Set(headers).size !== headers.length) throw new Error('BOM CSV lacks unique column headers')
  return rows.map(cells => {
    if (cells.length !== headers.length) throw new Error('BOM CSV column count mismatch')
    return Object.fromEntries(headers.map((name, i) => [name, cells[i]!]))
  })
}

/** Merge export membership once; do not persist a second, redundant BOM inventory. */
export function mergeAnalysisBom(data: AnalysisData, rows: Array<Record<string, string>>): void {
  const references = new Set<string>()
  for (const row of rows) {
    if (!row.Reference || references.has(row.Reference) || row.Quantity !== '1') {
      throw new Error('BOM must contain unique, ungrouped references with quantity 1')
    }
    references.add(row.Reference)
  }
  const flag = (text: string | undefined) => Boolean(text && !['0', 'false', 'no'].includes(text.toLowerCase()))
  const original = data.components
  const components = (original ?? []).map(c => ({...c, bomIncluded: references.has(c.reference)}))
  for (const row of rows) {
    const matching = components.filter(c => c.reference === row.Reference)
    if (matching.length > 1) throw new Error(`Ambiguous BOM reference: ${row.Reference}`)
    if (matching.length === 0) components.push({reference: row.Reference!, value: row.Value ?? null,
      footprint: row.Footprint ?? null, sheetPath: null, fields: {}, dnp: flag(row.DNP),
      excludeFromBom: flag(row.ExcludeFromBom), excludeFromBoard: flag(row.ExcludeFromBoard), bomIncluded: true})
  }
  data.components = components
  data.bomAvailable = true
  if (original === null) data.inventoryScope = 'bom_only'
}

/** An ungrouped BOM view derived from the single component inventory. */
export function analysisBomRows(data: AnalysisData): Array<Record<string, string>> {
  if (!data.bomAvailable) return []
  return (data.components ?? []).filter(c => c.bomIncluded).map(c => ({Reference: c.reference,
    Value: c.value ?? '', Footprint: c.footprint ?? '', Quantity: '1', DNP: c.dnp ? 'DNP' : '',
    ExcludeFromBom: c.excludeFromBom ? 'yes' : '', ExcludeFromBoard: c.excludeFromBoard ? 'yes' : ''}))
}

/** Preserve raw properties; missing MPNs are never inferred from Value or model names. */
export function parseAnalysisNetlist(text: string): {components: AnalysisComponent[]; nets: ReturnType<typeof parseNetlist>} {
  const root = parse(text)
  const container = children(root, 'components')[0]
  const components = (container ? children(container, 'comp') : []).map(comp => {
    const optional = (head: string) => {const f = children(comp, head)[0]; return f ? value(f) : null}
    const fields: Record<string, string> = Object.create(null)
    for (const group of children(comp, 'fields')) for (const field of children(group, 'field')) {
      fields[value(required(field, 'name'))] = field.items[2] === undefined ? '' : value(field, 2)
    }
    const properties = children(comp, 'property')
    const flag = (name: string) => properties.some(p => value(required(p, 'name')) === name)
    const sheet = children(comp, 'sheetpath')[0]
    return {reference: value(required(comp, 'ref')), value: optional('value'), footprint: optional('footprint'),
      fields, sheetPath: sheet ? value(required(sheet, 'names')) : null,
      dnp: flag('dnp'), excludeFromBom: flag('exclude_from_bom'), excludeFromBoard: flag('exclude_from_board')}
  })
  return {components, nets: parseNetlist(text)}
}

async function boundedFile(path: string): Promise<string> {
  if ((await stat(path)).size > maxBytes) throw new Error('KiCad analysis output exceeds 20 MiB')
  const bytes = await readFile(path)
  if (bytes.byteLength > maxBytes) throw new Error('KiCad analysis output exceeds 20 MiB')
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes)
}

/** All durable output goes through the harness filesystem and session write policy. */
export function createModuleAnalyzer(ctx: Pick<Context, 'fs' | 'sandboxPolicy'>, config: AnalysisConfig, runner: Runner = runProcess): AnalyzeModule {
  const capabilities = new Map<string, {until: number; netlist: boolean; bom: boolean; signature: string}>()
  const locks = new Map<string, Promise<unknown>>()
  // Download callers supply environment details once; queries use the same canonical source.
  const environments = new Map<string, {sourceProjectPath?: string; kicadCliPath?: string}>()
  const run = async (cli: string, args: string[], signal: AbortSignal) => {
    signal.throwIfAborted()
    const result = await runner(cli, args, signal, config.previewTimeoutMs)
    if (result.timedOut || result.exitCode !== 0) throw Object.assign(new Error(`KiCad ${args.slice(0, 3).join(' ')} failed: ${result.timedOut ? 'timeout' : result.stderr.slice(-1200) || result.stdout.slice(-1200) || result.exitCode}`),
      {code: result.timedOut ? 'CLI_TIMEOUT' : 'CLI_COMMAND_FAILED'})
    return result.stdout
  }
  return async (path, exec, options = {}) => {
    const signal = exec.signal
    const cwd = exec.agent?.session.header.cwd
    if (!cwd) throw new Error('Module analysis requires an agent workspace')
    const source = await readWorkspaceSchematic(ctx.fs, cwd, path, config.maxSchematicBytes, signal)
    const workspace = await ctx.fs.resolve(cwd, {signal})
    const environmentKey = JSON.stringify([workspace.displayPath, source.path])
    const environment = {...environments.get(environmentKey),
      ...(options.sourceProjectPath === undefined ? {} : {sourceProjectPath: options.sourceProjectPath}),
      ...(options.kicadCliPath === undefined ? {} : {kicadCliPath: options.kicadCliPath})}
    // Recover the conventional matching project after restart, without adopting another project's config.
    if (!environment.sourceProjectPath) {
      const stem = source.path.slice(0, -'.kicad_sch'.length)
      const candidates = basename(stem).startsWith('HQ_EDA_')
        ? [stem + '.source.kicad_pro', stem + '.kicad_pro'] : [stem + '.kicad_pro']
      for (const candidate of candidates) {
        const target = await ctx.fs.resolve(candidate, {signal})
        if (!ctx.fs.contains(workspace, target)) throw new Error('Matching project escaped the agent workspace')
        if ((await ctx.fs.stat(target, signal))?.type === 'file') {environment.sourceProjectPath = target.displayPath; break}
      }
    }
    // Validate child paths and cycles before KiCad is allowed to open any sheet.
    const sources = await collectPreviewSources(ctx.fs, cwd, source, config.maxSchematicBytes, signal)
    const texts = new Map<string, string>()
    let totalBytes = 0
    for (const sheet of sources) {
      if (texts.has(sheet.schematicPath)) continue
      const item = await readWorkspaceSchematic(ctx.fs, cwd, sheet.schematicPath, config.maxSchematicBytes, signal)
      if (digest(item.text) !== sheet.sha256) throw new Error('Module changed while collecting analysis sources; retry analysis')
      totalBytes += Buffer.byteLength(item.text)
      if (totalBytes > maxBytes) throw new Error('Module analysis source tree exceeds 20 MiB')
      texts.set(item.path, item.text)
    }
    const project = environment.sourceProjectPath
      ? await readWorkspaceProject(ctx.fs, cwd, environment.sourceProjectPath, config.maxSchematicBytes, signal) : undefined
    if (project) environment.sourceProjectPath = project.path
    if (environments.size >= 512 && !environments.has(environmentKey)) environments.delete(environments.keys().next().value!)
    environments.set(environmentKey, environment)
    const cli = getKiCadPaths(environment.kicadCliPath ?? config.kicadCliPath).kicadCliPath
    let cap = capabilities.get(cli)
    let failureCode: NonNullable<AnalysisResult['failure']>['code'] = 'CLI_PROBE_FAILED'
    try {
      if (!isAbsolute(cli) && !['kicad-cli', 'kicad-cli.exe'].includes(cli)) {
        failureCode = 'CLI_START_FAILED'
        throw new Error('KiCad CLI must be an absolute path or the kicad-cli PATH command')
      }
      if (!cap || cap.until < Date.now()) {
        const [netlist, bom] = await Promise.allSettled([
          run(cli, ['sch', 'export', 'netlist', '--help'], signal), run(cli, ['sch', 'export', 'bom', '--help'], signal),
        ])
        signal.throwIfAborted()
        const netHelp = netlist.status === 'fulfilled' ? netlist.value : ''
        const bomHelp = bom.status === 'fulfilled' ? bom.value : ''
        cap = {until: Date.now() + 60000, netlist: netHelp.includes('kicadsexpr'),
          bom: ['--fields', '--labels', '--group-by', '--filter'].every(flag => bomHelp.includes(flag)), signature: digest(netHelp + bomHelp)}
        if (!cap.netlist && !cap.bom) {
          const errors = [netlist, bom].flatMap(r => r.status === 'rejected' ? [r.reason] : [])
          if (errors.some(e => ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'EINVAL'].includes(e?.code))) failureCode = 'CLI_START_FAILED'
          else if (errors.some(e => e?.code === 'CLI_TIMEOUT')) failureCode = 'CLI_PROBE_TIMEOUT'
          else failureCode = errors.length ? 'CLI_PROBE_FAILED' : 'CLI_CAPABILITY_UNSUPPORTED'
          throw new Error(errors.length ? [...new Set(errors.map(String))].join('; ')
            : 'KiCad CLI started but required netlist/BOM export options are unsupported')
        }
        if (capabilities.size >= 16) capabilities.clear()
        capabilities.set(cli, cap)
      }
    } catch (error) {
      signal.throwIfAborted()
      // A failed download override must not prevent recovery via corrected configuration.
      delete environment.kicadCliPath
      return {analysis: {status: 'unavailable', cached: false, failure: {code: failureCode, executable: cli},
        diagnostics: [String(error).slice(0, 1600)], nextAction: failureCode === 'CLI_START_FAILED' ? cliRecoveryHint
          : failureCode === 'CLI_CAPABILITY_UNSUPPORTED' ? 'CLI started but export capabilities are unsupported. Check KiCad version/options; do not download again.'
          : 'CLI probe failed or timed out. Inspect diagnostics, then retry analyze_kicad_module with view:summary; do not download again.'}}
    }
    let binaryIdentity = ''
    if (isAbsolute(cli)) {try {const info = await stat(cli); binaryIdentity = `${info.size}:${info.mtimeMs}`} catch { /* command reports the actual error */ }}
    const revision = digest(JSON.stringify({version, cli, binaryIdentity, capability: cap.signature, sources,
      project: project ? digest(project.text) : null, variant: 'default'}))
    const directory = await resolvePreviewOutputDir(ctx.fs, cwd, join(dirname(source.path), 'analysis', basename(source.path, '.kicad_sch'), revision), signal)
    const files = {components: join(directory, 'components.json'), connectivity: join(directory, 'connectivity.json')}
    const summarize = (data: AnalysisData, diagnostics: string[], cached: boolean): AnalysisResult => {
      const status = data.components !== null && data.nets !== null && data.bomAvailable ? 'ready'
        : data.components !== null || data.nets !== null ? 'partial' : 'unavailable'
      return {status, cached, revision, files, inventoryScope: data.inventoryScope, counts: {
        ...(data.components === null ? {} : {components: data.components.length, dnp: data.components.filter(c => c.dnp).length}),
        ...(data.nets === null ? {} : {nets: data.nets.length}),
        ...(data.bomAvailable ? {bom: data.components!.filter(c => c.bomIncluded).length} : {}),
      }, diagnostics, nextAction: status === 'ready' ? 'Query only needed components, nets or bom; no summary call needed.'
        : 'Query available data; after fixing diagnostics, use view:summary to retry analysis.'}
    }
    const previous = locks.get(directory)
    const task = (async () => {
      await previous?.catch(() => {})
      signal.throwIfAborted()
      const read = async (path: string) => {
        const target = await ctx.fs.resolve(path, {signal})
        return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await ctx.fs.readBytes(target, signal, maxBytes)))
      }
      try {
        const componentFile = await read(files.components), netFile = await read(files.connectivity)
        const metadata = componentFile.metadata
        if (metadata.version === version && metadata.revision === revision
          && (metadata.status === 'ready' || options.reusePartial && ['partial', 'unavailable'].includes(metadata.status))
          && (Array.isArray(componentFile.data.components) || componentFile.data.components === null)
          && typeof componentFile.data.bomAvailable === 'boolean'
          && (!componentFile.data.bomAvailable || Array.isArray(componentFile.data.components))
          && (Array.isArray(netFile.data.nets) || netFile.data.nets === null)
          && JSON.stringify(metadata) === JSON.stringify(netFile.metadata)
          && digest(JSON.stringify(componentFile.data)) === metadata.hashes.components
          && digest(JSON.stringify(netFile.data)) === metadata.hashes.connectivity) {
          const data: AnalysisData = {...componentFile.data, nets: netFile.data.nets}
          return {analysis: summarize(data, metadata.diagnostics, true), data}
        }
      } catch {signal.throwIfAborted() /* absent, old or damaged caches are rebuilt */}
      const temporary = await mkdtemp(join(tmpdir(), 'dsh-module-analysis-'))
      const diagnostics: string[] = []
      const data: AnalysisData = {components: null, nets: null, bomAvailable: false, inventoryScope: 'unavailable'}
      try {
        const names = new Map<string, string>([[source.path, basename(source.path)]])
        for (const name of texts.keys()) {
          if (names.has(name)) continue
          let filename = `child-${names.size}.kicad_sch`
          while ([...names.values()].includes(filename)) filename = `child-${filename}`
          names.set(name, filename)
        }
        for (const [original, text] of texts) {
          const root = parse(text)
          const edits = []
          for (const sheet of children(root, 'sheet')) {
            const file = children(sheet, 'property').find(p => value(p) === 'Sheetfile')!
            const requested = value(file, 2)
            const target = await ctx.fs.resolve(isAbsolute(requested) ? requested : join(dirname(original), requested), {signal})
            const name = names.get(target.displayPath)
            if (!name) throw new Error('Child sheet changed or escaped the validated source snapshot')
            edits.push({start: file.start, end: file.end, text: `(property "Sheetfile" ${quote(name)})`})
          }
          await writeFile(join(temporary, names.get(original)!), applyEdits(text, edits), 'utf8')
        }
        const input = join(temporary, basename(source.path))
        if (project) await writeFile(join(temporary, basename(source.path, '.kicad_sch') + '.kicad_pro'), project.text, 'utf8')
        if (cap.netlist) {
          try {
            await run(cli, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '--output', join(temporary, 'netlist.net'), input], signal)
            Object.assign(data, parseAnalysisNetlist(await boundedFile(join(temporary, 'netlist.net'))))
            data.inventoryScope = 'netlist'
          } catch (error) {signal.throwIfAborted(); diagnostics.push(String(error).slice(0, 1600))}
        } else diagnostics.push('CLI does not support kicadsexpr netlist export')
        if (cap.bom) {
          try {
            const fields = 'Reference,Value,Footprint,QUANTITY,DNP,EXCLUDE_FROM_BOM,EXCLUDE_FROM_BOARD'
            await run(cli, ['sch', 'export', 'bom', '--fields', fields, '--labels', 'Reference,Value,Footprint,Quantity,DNP,ExcludeFromBom,ExcludeFromBoard',
              '--group-by', '', '--filter', '', '--output', join(temporary, 'bom.csv'), input], signal)
            const bom = parseBomCsv(await boundedFile(join(temporary, 'bom.csv')))
            mergeAnalysisBom(data, bom)
          } catch (error) {signal.throwIfAborted(); diagnostics.push(String(error).slice(0, 1600))}
        } else diagnostics.push('CLI does not support the required BOM export options')
        if (!data.bomAvailable) for (const comp of data.components ?? []) comp.bomIncluded = null
        const analysis = summarize(data, diagnostics, false)
        const componentData = {components: data.components, bomAvailable: data.bomAvailable, inventoryScope: data.inventoryScope}
        const netData = {nets: data.nets}
        const metadata = {version, revision, status: analysis.status, sources, variant: 'default', diagnostics,
          hashes: {components: digest(JSON.stringify(componentData)), connectivity: digest(JSON.stringify(netData))}}
        const artifacts = {components: JSON.stringify({metadata, data: componentData}),
          connectivity: JSON.stringify({metadata, data: netData})}
        const policy = ctx.sandboxPolicy.resolve({session: exec.agent!.session})
        for (const key of ['components', 'connectivity'] as const) {
          const text = artifacts[key]
          if (Buffer.byteLength(text!) > maxBytes) throw new Error('Analysis artifact exceeds 20 MiB')
          const target = await ctx.fs.resolve(files[key], {signal})
          const root = await ctx.fs.resolve(directory, {signal})
          if (!ctx.fs.contains(root, target)) throw new Error('Analysis output escaped its cache directory')
          const exists = await ctx.fs.stat(target, signal)
          // A revision directory is generated cache only; failed/corrupt artifacts can be repaired.
          await ctx.fs.writeText(target, text!, exists ? {kind: 'replaceIfVersion', version: exists.version} : {kind: 'createIfAbsent'}, signal, policy)
        }
        return {analysis, data}
      } finally {
        if (dirname(resolve(temporary)) !== resolve(tmpdir())) throw new Error('Analysis temporary directory escaped')
        await rm(temporary, {recursive: true, force: true})
      }
    })()
    locks.set(directory, task)
    try {return await task} finally {if (locks.get(directory) === task) locks.delete(directory)}
  }
}
