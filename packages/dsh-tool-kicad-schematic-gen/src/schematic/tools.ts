/** Read, preview, and generate KiCad schematic copies through workspace-scoped DSH tools. */
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolDefinition, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { parsePortConnections, parseUnconnectedPorts, requiredString, validateKeys } from './input.ts'
import { readModulePorts } from './ports.ts'
import { buildAssembly, type AssemblyFiles } from './assembly.ts'
import { renderModulePreview, type PreviewSource } from './preview.ts'
import { resolvePreviewRegions, renderPreviewRegions } from './preview-regions.ts'
import { validatePreviewSchematic } from './preview-diagnostics.ts'
import { buildProject } from './project.ts'
import { children, parse, value } from './sexpr.ts'
import { buildFlatCopy, listFlatObjects, loadFlatTemplates, summarizeFlatLayout } from './flat.ts'
import { parseFlatRequest } from './flat-input.ts'
import {inspectPinConnections} from './connections.ts'
import {createOverview,registerOverview} from './overview.ts'
import {previewConfig} from './preview-config.ts'
import {auditFootprints} from './footprint-links.ts'

import type { Config } from './config.ts'

type WorkspaceFileSystem = Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'writeText'> & {
  readBytes(target: Parameters<FileSystem['readText']>[0], signal: AbortSignal, maxBytes: number): Promise<Uint8Array>
}
type WritePolicy = Parameters<FileSystem['writeText']>[4]
type WorkspacePath = Awaited<ReturnType<WorkspaceFileSystem['resolve']>>

async function writeOutputs(
  fs: WorkspaceFileSystem, targets: readonly { target: WorkspacePath; content: string }[],
  policy: WritePolicy, signal: AbortSignal,
): Promise<void> {
  const written: string[] = []
  for (const { target, content } of targets) {
    signal.throwIfAborted()
    try {
      await fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, policy)
    } catch (error) {
      if (signal.aborted) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to write ${target.displayPath}: ${reason}. `
        + `${written.length} preceding files were confirmed written: ${JSON.stringify(written)}. `
        + 'The failed path may also exist; inspect targetDir and use a fresh empty directory for a retry.',
      { cause: error })
    }
    written.push(target.displayPath)
  }
}

function workspaceRoot(agent: { session: { header: { cwd?: string } } } | undefined): string {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined) throw new Error('KiCad module tools require an agent session workspace')
  return cwd
}

/** Read a bounded UTF-8 schematic only after checking its canonical workspace path. */
export async function readWorkspaceSchematic(
  fs: WorkspaceFileSystem, workspace: string, requested: string,
  maxBytes: number, signal: AbortSignal,
): Promise<{ text: string; path: string }> {
  const root = await fs.resolve(workspace, { signal })
  const target = await fs.resolve(requested, { cwd: workspace, signal })
  if (!fs.contains(root, target) || !target.displayPath.toLowerCase().endsWith('.kicad_sch')) {
    throw new Error('schematicPath must name a .kicad_sch inside the agent workspace')
  }
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file') throw new Error('schematicPath must name an existing file')
  const bytes = await fs.readBytes(target, signal, maxBytes)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return { text, path: target.displayPath }
}

/** Read an optional source project after checking its canonical workspace path and configured limit. */
export async function readWorkspaceProject(
  fs: WorkspaceFileSystem, workspace: string, requested: string,
  maxBytes: number, signal: AbortSignal,
): Promise<{ text: string; path: string }> {
  const root = await fs.resolve(workspace, { signal })
  const target = await fs.resolve(requested, { cwd: workspace, signal })
  if (!fs.contains(root, target) || !target.displayPath.toLowerCase().endsWith('.kicad_pro')) {
    throw new Error('sourceProjectPath must name a .kicad_pro inside the agent workspace')
  }
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file') throw new Error('sourceProjectPath must name an existing file')
  const bytes = await fs.readBytes(target, signal, maxBytes)
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), path: target.displayPath }
}

/** Publish only new project files through the DSH filesystem policy. */
export async function publishProject(
  fs: WorkspaceFileSystem, workspace: string, targetDir: string, projectName: string,
  files: ReturnType<typeof buildProject>, policy: WritePolicy, signal: AbortSignal,
): Promise<{ rootPath: string; childPath: string; projectPath: string; symbolLibraryPath: string; symbolTablePath: string }> {
  const root = await fs.resolve(workspace, { signal })
  const directory = await fs.resolve(targetDir, { cwd: workspace, signal })
  if (!fs.contains(root, directory) || !isAbsolute(directory.displayPath)) {
    throw new Error('targetDir must stay inside the agent workspace')
  }
  const info = await fs.stat(directory, signal)
  if (info?.type !== 'directory') throw new Error('targetDir must be an existing directory')
  const outputs = [
    ['childPath', `${projectName}_module.kicad_sch`, files.child],
    ['symbolLibraryPath', `${projectName}.kicad_sym`, files.symbolLibrary],
    ['symbolTablePath', 'sym-lib-table', files.symbolTable],
    ['projectPath', `${projectName}.kicad_pro`, files.project],
    ['rootPath', `${projectName}.kicad_sch`, files.root],
  ] as const
  const targets = await Promise.all(outputs.map(async ([key, filename, content]) => {
    const target = await fs.resolve(join(directory.displayPath, filename), { signal })
    if (!fs.contains(directory, target)) throw new Error(`project output escapes targetDir: ${target.displayPath}`)
    if (await fs.stat(target, signal) !== undefined) {
      throw new Error(`project output already exists: ${target.displayPath}; use a fresh empty targetDir`)
    }
    return { key, target, content }
  }))
  await writeOutputs(fs, targets, policy, signal)
  return Object.fromEntries(targets.map(item => [item.key, item.target.displayPath])) as
    { rootPath: string; childPath: string; projectPath: string; symbolLibraryPath: string; symbolTablePath: string }
}

/** Publish a complete assembly only into an existing workspace directory with unused names. */
export async function publishAssembly(
  fs: WorkspaceFileSystem, workspace: string, targetDir: string, projectName: string,
  files: AssemblyFiles, policy: WritePolicy, signal: AbortSignal,
): Promise<{ rootPath: string; projectPath: string; childPaths: string[]; symbolLibraryPath: string; symbolTablePath: string }> {
  const root = await fs.resolve(workspace, { signal })
  const directory = await fs.resolve(targetDir, { cwd: workspace, signal })
  if (!fs.contains(root, directory) || !isAbsolute(directory.displayPath)) {
    throw new Error('targetDir must stay inside the agent workspace')
  }
  if ((await fs.stat(directory, signal))?.type !== 'directory') throw new Error('targetDir must be an existing directory')
  const outputs = [
    ...files.children.map(child => [child.filename, child.text] as const),
    [`${projectName}.kicad_sym`, files.symbolLibrary],
    ['sym-lib-table', files.symbolTable],
    [`${projectName}.kicad_pro`, files.project],
    [`${projectName}.kicad_sch`, files.root],
  ]
  const targets = await Promise.all(outputs.map(async ([filename, content]) => {
    const target = await fs.resolve(join(directory.displayPath, filename), { signal })
    if (!fs.contains(directory, target)) throw new Error(`assembly output escapes targetDir: ${target.displayPath}`)
    if (await fs.stat(target, signal) !== undefined) {
      throw new Error(`assembly output already exists: ${target.displayPath}; use a fresh empty targetDir`)
    }
    return { target, content }
  }))
  await writeOutputs(fs, targets, policy, signal)
  return {
    childPaths: targets.slice(0, files.children.length).map(item => item.target.displayPath),
    symbolLibraryPath: targets[files.children.length]!.target.displayPath,
    symbolTablePath: targets[files.children.length + 1]!.target.displayPath,
    projectPath: targets[files.children.length + 2]!.target.displayPath,
    rootPath: targets[files.children.length + 3]!.target.displayPath,
  }
}

/** Save one verified netlist in an existing workspace directory without replacing prior results. */
export async function publishNetlist(
  fs: WorkspaceFileSystem, workspace: string, outputDir: string, rootPath: string,
  content: string, policy: WritePolicy, signal: AbortSignal,
): Promise<string> {
  const root = await fs.resolve(workspace, { signal })
  const directory = await fs.resolve(outputDir, { cwd: workspace, signal })
  if (!fs.contains(root, directory) || !isAbsolute(directory.displayPath)) {
    throw new Error('outputDir must stay inside the agent workspace')
  }
  if ((await fs.stat(directory, signal))?.type !== 'directory') throw new Error('outputDir must be an existing directory')
  const target = await fs.resolve(join(directory.displayPath, `${basename(rootPath, '.kicad_sch')}.net`), { signal })
  if (!fs.contains(directory, target)) throw new Error('netlist output escapes outputDir')
  if (await fs.stat(target, signal) !== undefined) throw new Error(`netlist output already exists: ${target.displayPath}`)
  await fs.writeText(target, content, { kind: 'createIfAbsent' }, signal, policy)
  return target.displayPath
}

/** Resolve an existing or new preview directory without allowing paths outside the workspace. */
export async function resolvePreviewOutputDir(
  fs: WorkspaceFileSystem, workspace: string, requested: string, signal: AbortSignal,
): Promise<string> {
  const [root, destination] = await Promise.all([
    fs.resolve(workspace, { signal }),
    fs.resolve(requested, { cwd: workspace, signal }),
  ])
  if (!fs.contains(root, destination) || !isAbsolute(destination.displayPath)) {
    throw new Error('outputDir must stay inside the agent workspace')
  }
  const info = await fs.stat(destination, signal)
  if (info !== undefined && info.type !== 'directory') throw new Error('outputDir must be a directory')
  return destination.displayPath
}

/** Map a KiCad root and its child sheets to export names and content hashes. */
export async function collectPreviewSources(
  fs: WorkspaceFileSystem, workspace: string, source: { path: string; text: string },
  maxBytes: number, signal: AbortSignal,
): Promise<PreviewSource[]> {
  const rootName = basename(source.path, '.kicad_sch')
  const result: PreviewSource[] = []
  const visit = async (path: string, text: string, names: string[], ancestry: Set<string>): Promise<void> => {
    signal.throwIfAborted()
    if (result.length >= 64) throw new Error('preview source contains more than 64 sheet instances')
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (ancestry.has(key)) throw new Error(`preview source has a circular child sheet: ${path}`)
    const nextAncestry = new Set(ancestry).add(key)
    const schematic = validatePreviewSchematic(text, path)
    result.push({ exportedPageName: [rootName, ...names].join('-'), schematicPath: path,
      sha256: createHash('sha256').update(text).digest('hex') })
    for (const sheet of children(schematic, 'sheet')) {
      const properties = children(sheet, 'property')
      const sheetName = properties.find(item => value(item) === 'Sheetname')
      const sheetFile = properties.find(item => value(item) === 'Sheetfile')
      if (sheetName === undefined || sheetFile === undefined) {
        throw new Error(`preview source sheet lacks Sheetname or Sheetfile: ${path}`)
      }
      const filename = value(sheetFile, 2)
      const requested = isAbsolute(filename) ? filename : join(dirname(path), filename)
      const child = await readWorkspaceSchematic(fs, workspace, requested, maxBytes, signal)
      await visit(child.path, child.text, [...names, value(sheetName, 2)], nextAncestry)
    }
  }
  await visit(source.path, source.text, [], new Set())
  return result
}


function positiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`kicad-schematic-tools: ${field} must be an integer from 1 to ${maximum}`)
  }
}

/** Register workspace-scoped module port, preview, hierarchy, and flat editing tools. */
export function registerSchematicTools(ctx: Context, config: Config): void {
  const overviewAvailable = registerOverview(ctx)
  if (!isAbsolute(config.flatTemplateDir)) throw new Error('flatTemplateDir must be absolute')
  positiveInteger(config.flatListLimit, 'flatListLimit', 1000)
  const flatTemplates = loadFlatTemplates(config.flatTemplateDir)
  if (!Number.isInteger(config.maxSchematicBytes) || config.maxSchematicBytes < 1 || config.maxSchematicBytes > 50000000) {
    throw new Error('kicad-schematic-tools: maxSchematicBytes must be 1 to 50000000')
  }
  if (!isAbsolute(config.kicadCliPath) && !['kicad-cli', 'kicad-cli.exe'].includes(config.kicadCliPath)) throw new Error('kicad-schematic-tools: kicadCliPath must be absolute or the kicad-cli PATH command')
  positiveInteger(config.previewDensity, 'previewDensity', 1200)
  positiveInteger(config.previewMaxWidth, 'previewMaxWidth', 4096)
  positiveInteger(config.previewMaxPages, 'previewMaxPages', 16)
  if (!Number.isInteger(config.previewPadding) || config.previewPadding < 0
    || config.previewPadding * 2 >= config.previewMaxWidth) {
    throw new Error('kicad-schematic-tools: previewPadding must be a non-negative integer smaller than half previewMaxWidth')
  }
  positiveInteger(config.previewTimeoutMs, 'previewTimeoutMs', 120000)
  if (!Number.isInteger(config.previewTrimThreshold) || config.previewTrimThreshold < 0
    || config.previewTrimThreshold > 255) {
    throw new Error('kicad-schematic-tools: previewTrimThreshold must be an integer from 0 to 255')
  }
  const ports: ToolDefinition = {
    name: 'get_kicad_module_ports',
    description: 'Read distinct explicit hierarchy port names as passive ports for connection planning. Repeated names with conflicting source directions are reported separately. Assembly makes the copied child hierarchy labels passive; source files and component pin types stay unchanged.',
    parameters: { type: 'object', additionalProperties: false,
      properties: { schematicPath: { type: 'string' } }, required: ['schematicPath'] },
    output: { schema: { type: 'object', additionalProperties: false,
      properties: { schematicPath: { type: 'string' }, portCount: { type: 'integer' },
        ports: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { name: { type: 'string' }, direction: { type: 'string' } },
          required: ['name', 'direction'] } },
        directionConflicts: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { name: { type: 'string' }, sourceDirections: { type: 'array', items: { type: 'string' } } },
          required: ['name', 'sourceDirections'] } },
        interpretation: { type: 'string' } },
      required: ['schematicPath', 'portCount', 'ports', 'directionConflicts', 'interpretation'] },
      render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }] },
    async execute(args, exec) {
      const input = validateKeys(args, ['schematicPath'], 'get_kicad_module_ports')
      const workspace = workspaceRoot(exec.agent)
      const source = await readWorkspaceSchematic(ctx.fs, workspace,
        requiredString(input, 'schematicPath'), config.maxSchematicBytes, exec.signal)
      const found = readModulePorts(parse(source.text))
      return { schematicPath: source.path, portCount: found.ports.length, ports: found.ports,
        directionConflicts: found.directionConflicts,
        interpretation: found.ports.length === 0
          ? 'No explicit hierarchical-label ports. Inspect the circuit in KiCad to identify intended external connections.'
          : found.directionConflicts.length > 0
            ? 'All hierarchy ports are passive for connection planning. Repeated source directions are reported; assembly normalizes copied labels and leaves the source unchanged.'
            : 'All explicit hierarchy ports are passive for connection planning. Component pin types and the source file are unchanged.' }
    },
    presentCall: args => ({ card: 'generic', title: 'Get KiCad module ports', kind: 'read', rawInput: args }),
  }
  const regionSchema = { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string' }, pageName: { type: 'string' },
    start: { type: 'array', items: { type: 'number' } },
    end: { type: 'array', items: { type: 'number' } },
  }, required: ['name', 'start', 'end'] } satisfies JsonSchemaNode
  const preview: ToolDefinition = {
    name: 'render_kicad_module_preview',
    description: 'Render a workspace .kicad_sch into a project-local preview directory. Return the source revision, a page-to-PNG manifest, and paths for read_image; call read_image only for pages you need to inspect. Annotated root-sheet rectangles automatically produce regionImages at readable resolution. Optional regions overrides them using millimetre bounds and exact pageName; [] disables crops. Images do not establish electrical connectivity.',
    parameters: { type: 'object', additionalProperties: false,
      properties: {
        schematicPath: { type: 'string' },
        delivery: { type: 'boolean', description: 'True only for final saved project delivery: show an overview card and snapshot a downloadable project ZIP. Omit during layout review.' },
        kicadCliPath: {type:'string',description:'Optional absolute kicad-cli path already returned by get_eda_host_info. Reuse known host information; omit to use plugin configuration.'},
        projectDir: { type: 'string', description: 'With delivery:true, project folder containing the schematic, local symbol/footprint libraries and library tables. Defaults to the schematic folder. Must stay inside workspace.' },
        regions: { type: 'array', items: regionSchema, description: 'Optional module crops in schematic millimetres; defaults to annotated root-sheet rectangles. [] disables region crops.' },
        pageNames: { type: 'array', items: { type: 'string' }, description: 'Optional exact exported page names to render; defaults to root first. Use omittedPages names to request missing pages.' },
        outputDir: { type: 'string', description: 'Optional preview folder inside the workspace; defaults to a previews folder beside the schematic.' },
      }, required: ['schematicPath'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      schematicPath: { type: 'string' }, revision: { type: 'string' }, outputDir: { type: 'string' },
      overview: { oneOf: [{type:'null'}, {type:'object', properties: {
        title:{type:'string'},revision:{type:'string'},downloadUrl:{type:'string'},filename:{type:'string'},fileCount:{type:'integer'},size:{type:'integer'},
        projectKey:{type:'string'},createdAt:{type:'number'},
        pages:{type:'array',items:{type:'object',properties:{name:{type:'string'},imageUrl:{type:'string'}},required:['name','imageUrl']}},
      },required:['title','revision','downloadUrl','filename','fileCount','size','pages']}] },
      overviewError: {oneOf:[{type:'string'},{type:'null'}]},
      manifestPath: { type: 'string' }, cached: { type: 'boolean' },
      regionManifestPath: { type: 'string' },
      regionImages: { type: 'array', items: { ...regionSchema, properties: { ...regionSchema.properties,
        pngPath: { type: 'string' }, schematicPath: { oneOf: [{ type: 'string' }, { type: 'null' }] }, revision: { type: 'string' },
      }, required: ['name', 'pageName', 'start', 'end', 'pngPath', 'schematicPath', 'revision'] } },
      failures: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        code: { type: 'string' }, page: { type: 'string' }, svgPath: { type: 'string' },
        stage: { type: 'string' }, message: { type: 'string' }, retryUnchanged: { type: 'boolean' }, nextAction: { type: 'string' },
      }, required: ['code', 'page', 'svgPath', 'stage', 'message', 'retryUnchanged', 'nextAction'] } },
      status: { type: 'string' }, rootImagePath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      omittedPages: { type: 'array', items: { type: 'string' } },
      pageCount: { type: 'integer' }, truncated: { type: 'boolean' }, readImageInstruction: { type: 'string' },
      pages: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        pageIndex: { type: 'integer' }, exportedPageName: { type: 'string' },
        pageSchematicPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        svgPath: { type: 'string' }, pngPath: { type: 'string' },
      }, required: ['pageIndex', 'exportedPageName', 'pageSchematicPath', 'svgPath', 'pngPath'] } },
    }, required: ['schematicPath', 'revision', 'outputDir', 'manifestPath', 'cached',
      'pageCount', 'truncated', 'pages', 'failures', 'status', 'rootImagePath', 'omittedPages', 'readImageInstruction', 'regionImages', 'regionManifestPath'] },
    render: (_args, output) => [{ type: 'text', text: JSON.stringify(output, null, 2) }] },
    async execute(args, exec) {
      const input = validateKeys(args, ['schematicPath', 'outputDir', 'pageNames', 'regions', 'delivery', 'projectDir','kicadCliPath'], 'render_kicad_module_preview')
      const renderConfig=previewConfig(config,input.kicadCliPath)
      if(input.delivery !== undefined && typeof input.delivery !== 'boolean')throw new Error('delivery must be boolean')
      if(input.projectDir !== undefined && input.delivery !== true)throw new Error('projectDir requires delivery:true')
      const workspace = workspaceRoot(exec.agent)
      const source = await readWorkspaceSchematic(ctx.fs, workspace,
        requiredString(input, 'schematicPath'), config.maxSchematicBytes, exec.signal)
      const requestedDir = input.outputDir === undefined
        ? join(dirname(source.path), 'previews') : requiredString(input, 'outputDir')
      const outputDir = await resolvePreviewOutputDir(ctx.fs, workspace, requestedDir, exec.signal)
      const sources = await collectPreviewSources(ctx.fs, workspace, source, config.maxSchematicBytes, exec.signal)
      const revision = createHash('sha256').update(JSON.stringify(sources)).digest('hex')
      const pageNames = input.pageNames === undefined ? [] : parseUnconnectedPorts(input.pageNames, 'pageNames')
      if (pageNames.length > config.previewMaxPages) throw new Error(`code=PREVIEW_PAGE_LIMIT; retryUnchanged=false; request at most ${config.previewMaxPages} pageNames per call.`)
      const regions = resolvePreviewRegions(input.regions, source.text, basename(source.path, '.kicad_sch'), config.flatListLimit)
      const rendered = await renderModulePreview(outputDir, source.path, revision, renderConfig, exec.signal, sources, undefined, pageNames)
      const selectedRegions = input.regions === undefined ? regions.filter(r => rendered.pages.some(p => p.exportedPageName === r.pageName)) : regions
      const crops = await renderPreviewRegions(rendered.pages, selectedRegions, revision, rendered.manifestPath, config, exec.signal)
      const failures = [...rendered.failures, ...crops.failures]
      const omittedPages = sources.filter(item => !rendered.pages.some(page => page.exportedPageName === item.exportedPageName)).map(item => item.exportedPageName)
      let overview = null, overviewError = null
      if(input.delivery === true){
        if(!overviewAvailable)overviewError='Preview card service unavailable; use returned local preview paths.'
        else if(!rendered.pages.length)overviewError='No rendered pages available for the overview.'
        else try {
          const project = input.projectDir === undefined ? dirname(source.path) : requiredString(input,'projectDir')
          const resolved = await ctx.fs.resolve(project,{cwd:workspace,signal:exec.signal})
          for(const item of sources){
            const sheet=item.schematicPath===source.path?source:await readWorkspaceSchematic(ctx.fs,workspace,item.schematicPath,config.maxSchematicBytes,exec.signal);
            const footprints=await auditFootprints(sheet.text,resolved.displayPath,ctx.fs,exec.signal)
            if(footprints.status!=='ready')throw new Error(`FOOTPRINTS_UNRESOLVED: ${footprints.unresolved.length} of ${footprints.total} physical instances in ${item.schematicPath} lack project-local footprints. Run localize_kicad_module_footprints check/import and persist script mappings before delivery.`)
          }
          overview = await createOverview({workspace,projectDir:resolved.displayPath,schematicPath:source.path,revision,pages:rendered.pages,sources})
        }catch(error){overviewError=error instanceof Error?error.message:String(error)}
      }
      return {
        overview, overviewError,
        schematicPath: source.path, revision, outputDir,
        manifestPath: rendered.manifestPath, cached: rendered.cached,
        pageCount: rendered.pageCount, truncated: rendered.truncated,
        pages: rendered.pages, failures, regionImages: crops.regionImages, regionManifestPath: crops.regionManifestPath,
        status: rendered.pages.length === 0 ? 'error' : rendered.truncated || failures.length > 0 ? 'partial' : 'ok',
        rootImagePath: rendered.pages.find(page => page.pageSchematicPath === source.path || page.exportedPageName === basename(source.path, '.kicad_sch'))?.pngPath ?? null,
        omittedPages,
        readImageInstruction: 'For module detail read exact regionImages[].pngPath first; each image includes millimetre bounds, source and revision in regionManifestPath. Read rootImagePath for overall layout, or an exact pages[].pngPath. Do not write crop/zoom scripts for existing region images. Only listed PNGs exist; never replace an SVG extension or construct a PNG path. Check failures first: do not repeat failed pages unchanged or export a netlist to repair a preview. For unrendered pages not listed in failures, call render_kicad_module_preview with the same schematicPath and pageNames from omittedPages. Match the image to revision and its pageSchematicPath using manifestPath, pageIndex, and exportedPageName. A null pageSchematicPath means the page name could not be matched; do not infer its child file. A preview is not netlist evidence.',
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Render KiCad module preview', kind: 'read', rawInput: args }),
  }
  const hierarchy: ToolDefinition = {
    name: 'create_kicad_hierarchy',
    description: 'Create a KiCad 10 hierarchical schematic from 1-9 single-sheet modules with explicit hierarchy ports. Connect by port name and root net; all generated hierarchy pins and copied labels are passive. For every port, supply a connection or list it in unconnectedPorts. Preflight reports port and symbol problems across all sheets before writing. The tool does not choose electrical connections, add ports, export a netlist, or run ERC. targetDir is an existing design root, for example designs/alarm_clock (not its schematic subfolder). The schematic subfolder is created during publication; output filenames must be unused.',
    parameters: { type: 'object', additionalProperties: false,
      properties: {
        projectName: { type: 'string', description: 'ASCII filename stem: letters, digits, underscores, and hyphens; starts with a letter.' },
        title: { type: 'string' }, targetDir: { type: 'string', description: 'Existing design root, e.g. designs/alarm_clock. Children go into targetDir/schematic, created automatically. Do not pass designs/alarm_clock/schematic.' },
        sheets: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string' }, sourcePath: { type: 'string' },
            connections: { type: 'array', items: { type: 'object', additionalProperties: false,
              properties: { port: { type: 'string' }, net: { type: 'string' } }, required: ['port', 'net'] } },
            unconnectedPorts: { type: 'array', items: { type: 'string' }, description: 'Explicit hierarchy ports intentionally left without a root net.' },
          }, required: ['name', 'sourcePath', 'connections'] } },
      }, required: ['projectName', 'title', 'targetDir', 'sheets'] },
    output: { schema: { type: 'object', additionalProperties: false,
      properties: {
        projectPath: { type: 'string' }, rootPath: { type: 'string' },
        symbolLibraryPath: { type: 'string' }, symbolTablePath: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        sheets: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { name: { type: 'string' }, sourcePath: { type: 'string' },
            schematicPath: { type: 'string' }, portCount: { type: 'integer' },
            unconnectedPortCount: { type: 'integer' },
            directionConflicts: { type: 'array', items: { type: 'object', additionalProperties: false,
              properties: { name: { type: 'string' }, sourceDirections: { type: 'array', items: { type: 'string' } } },
              required: ['name', 'sourceDirections'] } },
            referenceCount: { type: 'integer' } },
          required: ['name', 'sourcePath', 'schematicPath', 'portCount', 'unconnectedPortCount', 'directionConflicts', 'referenceCount'] } },
      }, required: ['projectPath', 'rootPath', 'symbolLibraryPath', 'symbolTablePath', 'sheets'] },
      render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }] },
    async execute(args, exec) {
      const input = validateKeys(args, ['projectName', 'title', 'targetDir', 'sheets'], 'create_kicad_hierarchy')
      const projectName = requiredString(input, 'projectName', 64)
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(projectName)) {
        throw new Error('projectName must start with an ASCII letter and contain only letters, digits, underscores, or hyphens')
      }
      const title = requiredString(input, 'title', 200)
      const targetDir = requiredString(input, 'targetDir')
      if (!Array.isArray(input.sheets) || input.sheets.length < 1 || input.sheets.length > 9) {
        throw new Error('sheets must contain 1 to 9 modules')
      }
      const workspace = workspaceRoot(exec.agent)
      const workspacePath = await ctx.fs.resolve(workspace, { signal: exec.signal })
      const directory = await ctx.fs.resolve(targetDir, { cwd: workspace, signal: exec.signal })
      if (!ctx.fs.contains(workspacePath, directory)) {
        throw new Error('targetDir must stay inside the agent workspace')
      }
      const schematicDir = await ctx.fs.resolve(join(directory.displayPath, 'schematic'), { signal: exec.signal })
      if (!ctx.fs.contains(directory, schematicDir)) {
        throw new Error('targetDir/schematic must stay inside targetDir')
      }
      const schematicInfo = await ctx.fs.stat(schematicDir, exec.signal)
      if (schematicInfo !== undefined && schematicInfo.type !== 'directory') {
        throw new Error(`code=HIERARCHY_OUTPUT_DIRECTORY; retryUnchanged=false; targetDir=${directory.displayPath}; childOutputDir=${schematicDir.displayPath}; child output path is a file. Choose an existing design root with an available schematic subfolder.`)
      }
      const sheets = await Promise.all(input.sheets.map(async (item, index) => {
        const sheet = validateKeys(item, ['name', 'sourcePath', 'connections', 'unconnectedPorts'], `sheets[${index}]`)
        const source = await readWorkspaceSchematic(ctx.fs, workspace,
          requiredString(sheet, 'sourcePath'), config.maxSchematicBytes, exec.signal)
        return { name: requiredString(sheet, 'name', 128), sourcePath: source.path,
          source: source.text, connections: parsePortConnections(sheet.connections, `sheets[${index}].connections`),
          unconnectedPorts: parseUnconnectedPorts(sheet.unconnectedPorts, `sheets[${index}].unconnectedPorts`) }
      }))
      const files = buildAssembly(projectName, title, sheets)
      const paths = await publishAssembly(ctx.fs, workspace, targetDir, projectName, files,
        undefined, exec.signal)
      return { projectPath: paths.projectPath, rootPath: paths.rootPath,
        symbolLibraryPath: paths.symbolLibraryPath, symbolTablePath: paths.symbolTablePath, warnings: files.warnings,
        sheets: sheets.map((sheet, index) => ({ name: sheet.name, sourcePath: sheet.sourcePath,
          schematicPath: paths.childPaths[index]!, portCount: sheet.connections.length + sheet.unconnectedPorts.length,
          unconnectedPortCount: sheet.unconnectedPorts.length,
          directionConflicts: files.children[index]!.directionConflicts,
          referenceCount: Object.keys(files.children[index]!.references).length })) }
    },
    presentCall: args => ({ card: 'generic', title: 'Create KiCad hierarchy', kind: 'edit', rawInput: args }),
  }
  const flat: ToolDefinition = {
    name: 'edit_kicad_flat_schematic',
    description: 'Adapt a single-sheet schematic during implementation: read geometry/UUIDs or create an edited copy. During design planning use analyze_kicad_module for components, BOM and electrical nets; do not routinely call this tool or duplicate available results. Planning reads need a specific unanswered question, such as a missing drawing note; use list with types/references. Defer geometry queries and create until implementation. List/connections are read-only. Connections requires reference and pin number, follows visible wires only, not label aliases, hidden power or hierarchy. List returns objects, pin coordinates, image placement and conservative bounds. Create supports deletions, value/label edits, explicit orthogonal wires and frames; no new/moved symbols or automatic routing. Prefer frames autoBounds:true without start/end; objectUuids selects content, excludeUuids omits retained decoration from bounds. Use manual bounds for unsupported geometry. removeTextUuids only accepts text/text_box; images use removeUuids. Preserve necessary notes; select wires around deleted symbols explicitly. targetDir must exist; new outputs go under schematic/, preserving the source. No ERC or connectivity audit.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['list', 'connections', 'create'] }, sourcePath: { type: 'string' },
      references: {type: 'array', items: {type: 'string'}, description: 'List only selected symbol references.'},
      reference: {type: 'string', description: 'connections: exact placed reference'}, pin: {type: 'string', description: 'connections: pin number, not name'},
      offset: { type: 'integer' }, types: { type: 'array', items: { type: 'string' } },
      targetDir: { type: 'string' }, projectName: { type: 'string' },
      removeReferences: { type: 'array', items: { type: 'string' } },
      removeUuids: { type: 'array', items: { type: 'string' } },
      removeTextUuids: { type: 'array', description: 'UUIDs of selected top-level text/text_box annotations to remove from the project copy; labels and symbol properties are rejected.', items: { type: 'string' } },
      setValues: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { reference: { type: 'string' }, value: { type: 'string' } }, required: ['reference', 'value'] } },
      setLabels: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { uuid: { type: 'string' }, name: { type: 'string' }, at: { type: 'array', items: { type: 'number' } }, angle: { type: 'number', enum: [0, 90, 180, 270] } }, required: ['uuid'] } },
      addWires: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { from: { oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'object', additionalProperties: false, properties: { reference: { type: 'string' }, pin: { type: 'string' } }, required: ['reference', 'pin'] }] },
          to: { oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'object', additionalProperties: false, properties: { reference: { type: 'string' }, pin: { type: 'string' } }, required: ['reference', 'pin'] }] },
          via: { type: 'array', items: { type: 'array', items: { type: 'number' } } } }, required: ['from', 'to'] } },
      frames: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, description: { type: 'string' },
          start: { type: 'array', items: { type: 'number' } }, end: { type: 'array', items: { type: 'number' } },
          autoBounds: { type: 'boolean', description: 'Calculate bounds after edits with configured text space, padding and grid; omit start/end.' },
          objectUuids: { type: 'array', description: 'Optional exact retained objects belonging to this module; omission selects all content except old rectangles.', items: { type: 'string' } },
          excludeUuids: { type: 'array', description: 'Retained decoration omitted from automatic frame bounds; these objects are not deleted.', items: { type: 'string' } } },
        required: ['name', 'description'], oneOf: [{ required: ['start', 'end'], properties: { autoBounds: { const: false } } },
          { required: ['autoBounds'], properties: { autoBounds: { const: true } } }] } },
    }, required: ['action', 'sourcePath'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      sha256: {type: 'string'}, connection: {type: 'object'},
      status: { type: 'string' }, sourcePath: { type: 'string' }, totalObjects: { type: 'integer' },
      nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      objects: { type: 'array', items: { type: 'object' } }, schematicPath: { type: 'string' }, projectPath: { type: 'string' },
      changes: { type: 'object' }, layout: { type: 'object' }, frames: { type: 'array', items: { type: 'object' } }, nextAction: { type: 'string' },
    }, required: ['status', 'sourcePath', 'nextAction'] },
    render: (_args, output) => [{ type: 'text', text: JSON.stringify(output, null, 2) }] },
    async execute(args, exec) {
      let sourcePath = ''
      try {
        const request = parseFlatRequest(args, config.flatListLimit)
        sourcePath = request.sourcePath
        const workspace = workspaceRoot(exec.agent)
        const source = await readWorkspaceSchematic(ctx.fs, workspace, request.sourcePath, config.maxSchematicBytes, exec.signal)
        sourcePath = source.path
        const sha256 = createHash('sha256').update(source.text).digest('hex')
        if (request.action === 'connections') {
          const {objects, ...connection} = inspectPinConnections(listFlatObjects(source.text), request.reference, request.pin)
          const next = request.offset + request.limit
          return {status: 'connected', sourcePath: source.path, sha256, connection,
            objects: objects.slice(request.offset, next), totalObjects: objects.length,
            nextOffset: next < objects.length ? next : null,
            nextAction: 'Reuse this result; inspect limitations/diagnostics. Visible wires only, not complete electrical nets: use analyze_kicad_module for electrical questions. Only when implementing an edit, use target.endpoint or coordinates with explicit via points. Refresh geometry if the source changes. No ERC.'}
        }
        if (request.action === 'list') {
          const allObjects = listFlatObjects(source.text, flatTemplates.style)
          const objects = allObjects.filter(item => request.types.length === 0 || request.types.includes(item.type))
            .filter(item => request.references.length === 0 || (item.reference !== undefined && request.references.includes(item.reference)))
          const next = request.offset + request.limit
          return { status: 'listed', sourcePath: source.path, sha256, totalObjects: objects.length,
            objects: objects.slice(request.offset, next), nextOffset: next < objects.length ? next : null,
            layout: summarizeFlatLayout(allObjects, flatTemplates.style),
            nextAction: 'Reuse the requested information; fetch nextOffset only if needed. Planning reads do not require an edited copy. Only when implementing edits, use these UUIDs/coordinates and prefer frames autoBounds:true. Image sizes are in mm; bounds describe layout, not electrical connectivity.' }
        }
        const files = buildFlatCopy(source.text, request.projectName, request.plan, flatTemplates)
        const directory = await ctx.fs.resolve(request.targetDir, { cwd: workspace, signal: exec.signal })
        const workspaceDirectory = await ctx.fs.resolve(workspace, { signal: exec.signal })
        if (!ctx.fs.contains(workspaceDirectory, directory) || (await ctx.fs.stat(directory, exec.signal))?.type !== 'directory') throw new Error('targetDir must be an existing design directory inside the workspace')
        const targets = await Promise.all([
          [`${request.projectName}.kicad_sch`, files.schematic], [`${request.projectName}.kicad_pro`, files.project],
        ].map(async ([filename, content]) => {
          const target = await ctx.fs.resolve(join(directory.displayPath, 'schematic', filename!), { signal: exec.signal })
          if (!ctx.fs.contains(directory, target) || target.displayPath === source.path) throw new Error('flat output must stay in targetDir and preserve the source')
          if (await ctx.fs.stat(target, exec.signal) !== undefined) throw new Error(`flat output already exists: ${target.displayPath}; use an unused projectName or targetDir`)
          return { target, content: content! }
        }))
        await writeOutputs(ctx.fs, targets, undefined, exec.signal)
        return { status: 'created', sourcePath: source.path, schematicPath: targets[0]!.target.displayPath,
          projectPath: targets[1]!.target.displayPath, changes: files.changes, frames: files.resolvedFrames,
          nextAction: 'Render schematicPath and read a returned PNG. The source is unchanged. No endpoint audit, ERC, or netlist verification was run. Further copies need unused output names.' }
      } catch (error) {
        exec.signal.throwIfAborted()
        throw new Error(JSON.stringify({ code: 'FLAT_EDIT_FAILED', stage: 'flat_edit', sourcePath,
          message: error instanceof Error ? error.message : String(error), retryUnchanged: false,
          nextAction: 'Correct the listed selector, cache, wire path, or output name before retrying. Do not use line-number deletion or write a temporary parser. A publication error may leave preceding files; inspect reported paths.' }), { cause: error })
      }
    },
    presentCall: args => {
      const action = (args as {action?: string})?.action
      return {card: 'generic', title: action === 'list' ? '读取原理图对象'
        : action === 'connections' ? '查询局部导线连接' : '生成原理图修改副本',
      kind: action === 'list' || action === 'connections' ? 'read' : 'edit', rawInput: args}
    },
  }
  for (const tool of [ports, preview, hierarchy, flat]) ctx.effect(() => ctx.tools.register(tool))
}
