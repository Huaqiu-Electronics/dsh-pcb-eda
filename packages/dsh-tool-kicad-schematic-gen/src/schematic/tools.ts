/** Read, preview, and generate KiCad schematic copies through workspace-scoped DSH tools. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
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
import {createOverview,registerOverview} from './overview.ts'
import {previewConfig} from './preview-config.ts'
import {assertSchematicGrid} from './grid-check.ts'
import {designPlanReference,matchDesignPlan,DESIGN_PLAN_MAX_BYTES} from './design-plan.ts'

import type { Config } from './config.ts'

type WorkspaceFileSystem = Pick<FileSystem, 'resolve' | 'contains' | 'stat' | 'writeText'> & {
  readBytes(target: Parameters<FileSystem['readText']>[0], signal: AbortSignal, maxBytes: number): Promise<Uint8Array>
}
type WritePolicy = Parameters<FileSystem['writeText']>[4]
type WorkspacePath = Awaited<ReturnType<WorkspaceFileSystem['resolve']>>

const designPlanSchema:JsonSchemaNode={type:'object',description:'Required saved hardware design document and exact version returned by run-design.mjs --read-plan. Read and implement this plan before generation.',additionalProperties:false,properties:{path:{type:'string'},sha256:{type:'string'}},required:['path','sha256']}

/** Read the exact plan version through workspace policy before any generation writes. */
export async function readWorkspaceDesignPlan(fs:WorkspaceFileSystem,workspace:string,input:unknown,signal:AbortSignal){
 const reference=designPlanReference(input)
 const root=await fs.resolve(workspace,{signal}),target=await fs.resolve(reference.path,{cwd:workspace,signal})
 if(!fs.contains(root,target)||(await fs.stat(target,signal))?.type!=='file')throw new Error('DESIGN_PLAN_UNAVAILABLE: designPlan.path must be an existing document inside the workspace')
 const text=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readBytes(target,signal,DESIGN_PLAN_MAX_BYTES))
 return matchDesignPlan({...reference,path:target.displayPath},text)
}

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
  record?: { designPlan: {path: string; sha256: string}; sheets: Array<{
    sourcePath: string; connections: Array<{port: string; net: string}>; unconnectedPorts: string[]
  }> },
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
  const paths = {
    childPaths: targets.slice(0, files.children.length).map(item => item.target.displayPath),
    symbolLibraryPath: targets[files.children.length]!.target.displayPath,
    symbolTablePath: targets[files.children.length + 1]!.target.displayPath,
    projectPath: targets[files.children.length + 2]!.target.displayPath,
    rootPath: targets[files.children.length + 3]!.target.displayPath,
  }
  if (record !== undefined) {
    const target = await fs.resolve(join(directory.displayPath, `${projectName}.assembly.json`), {signal})
    if (!fs.contains(directory, target)) throw new Error('assembly record escapes targetDir')
    if (await fs.stat(target, signal) !== undefined) throw new Error(`assembly output already exists: ${target.displayPath}; use a fresh empty targetDir`)
    const detail = {version: 1, designPlan: record.designPlan, ...paths, warnings: files.warnings,
      sheets: files.children.map((child, index) => {
        const source = record.sheets[index]!
        return {name: child.name, ...source, schematicPath: paths.childPaths[index]!,
          portCount: source.connections.length + source.unconnectedPorts.length,
          unconnectedPortCount: source.unconnectedPorts.length, directionConflicts: child.directionConflicts,
          referenceCount: Object.keys(child.references).length, references: child.references}
      })}
    targets.push({target, content: JSON.stringify(detail, null, 2) + '\n'})
  }
  await writeOutputs(fs, targets, policy, signal)
  return paths
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

/** Register workspace-scoped module port, preview, and hierarchy tools. */
export function registerSchematicTools(ctx: Context, config: Config): void {
  const overviewAvailable = registerOverview(ctx)
  if (!isAbsolute(config.flatTemplateDir)) throw new Error('flatTemplateDir must be absolute')
  positiveInteger(config.flatListLimit, 'flatListLimit', 1000)
  if (!Number.isInteger(config.maxSchematicBytes) || config.maxSchematicBytes < 1 || config.maxSchematicBytes > 50000000) {
    throw new Error('kicad-schematic-tools: maxSchematicBytes must be 1 to 50000000')
  }
  if (!isAbsolute(config.kicadCliPath) && !['kicad-cli', 'kicad-cli.exe'].includes(config.kicadCliPath)) throw new Error('kicad-schematic-tools: kicadCliPath must be absolute or the kicad-cli PATH command')
  positiveInteger(config.previewDensity, 'previewDensity', 1200)
  positiveInteger(config.previewMaxWidth, 'previewMaxWidth', 4096)
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
    description: 'Preview all schematic pages by default, or only exact pageNames. Read rootImagePath for layout and regionImages[].pngPath for details; only returned PNG paths exist. Annotated root-sheet rectangles produce automatic crops; regions overrides them in millimetres and [] disables crops. manifestPath preserves full source mappings and diagnostics. delivery:true snapshots the project and enables the overview card. No footprint, grid or electrical checks; images are not connectivity evidence. Inspect failures before retrying.',
    parameters: { type: 'object', additionalProperties: false,
      properties: {
        schematicPath: { type: 'string' },
        delivery: { type: 'boolean', description: 'True only for final saved project delivery: show an overview card and snapshot a downloadable project ZIP. Omit during layout review.' },
        kicadCliPath: {type:'string',description:'Optional absolute kicad-cli path already returned by get_eda_host_info. Reuse known host information; omit to use plugin configuration.'},
        projectDir: { type: 'string', description: 'Archive root for delivery:true; defaults to the schematic folder and must contain all sheets. Must be an existing workspace directory. Unused during ordinary previews; no footprint validation.' },
        regions: { type: 'array', items: regionSchema, description: 'Optional module crops in schematic millimetres; defaults to annotated root-sheet rectangles. [] disables region crops.' },
        pageNames: { type: 'array', items: { type: 'string' }, description: 'Optional exact exported page names; omit or use [] to render all pages, root first. A nonempty list renders only those pages. Invalid names report available pages.' },
        outputDir: { type: 'string', description: 'Optional preview folder inside the workspace; defaults to a previews folder beside the schematic.' },
      }, required: ['schematicPath'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      revision: { type: 'string' }, manifestPath: { type: 'string' },
      overview: {type:'object', properties: {
        title:{type:'string'},revision:{type:'string'},downloadUrl:{type:'string'},filename:{type:'string'},fileCount:{type:'integer'},size:{type:'integer'},
        projectKey:{type:'string'},createdAt:{type:'number'},
        pages:{type:'array',items:{type:'object',properties:{name:{type:'string'},imageUrl:{type:'string'}},required:['name','imageUrl']}},
      },required:['title','revision','downloadUrl','filename','fileCount','size','pages']},
      overviewError: {type:'string'},
      status: {type:'string',enum:['ok','partial','error']},
      renderStatus: {type:'string',enum:['ok','partial','error']},
      deliveryStatus: {type:'string',enum:['not_requested','ready','blocked']},
      rootImagePath: {type:'string'}, pageCount: {type:'integer'},
      pages: {type:'array',items:{type:'object',additionalProperties:false,properties:{
        exportedPageName:{type:'string'},pngPath:{type:'string'},
      },required:['exportedPageName','pngPath']}},
      regionImages: {type:'array',items:{type:'object',additionalProperties:false,properties:{
        name:{type:'string'},pageName:{type:'string'},pngPath:{type:'string'},
      },required:['name','pageName','pngPath']}},
      failures: {type:'array',items:{type:'object',additionalProperties:false,properties:{
        code:{type:'string'},page:{type:'string'},svgPath:{type:'string'},stage:{type:'string'},
        message:{type:'string'},retryUnchanged:{type:'boolean'},nextAction:{type:'string'},
      },required:['code','page','svgPath','stage','message','retryUnchanged','nextAction']}},
    }, required: ['revision','manifestPath','status','renderStatus','deliveryStatus','pageCount','pages'] },
    render: (_args, output) => [{ type: 'text', text: JSON.stringify(output, null, 2) }] },
    async execute(args, exec) {
      const input = validateKeys(args, ['schematicPath', 'outputDir', 'pageNames', 'regions', 'delivery', 'projectDir','kicadCliPath'], 'render_kicad_module_preview')
      const renderConfig=previewConfig(config,input.kicadCliPath)
      if(input.delivery !== undefined && typeof input.delivery !== 'boolean')throw new Error('delivery must be boolean')
      const workspace = workspaceRoot(exec.agent)
      const source = await readWorkspaceSchematic(ctx.fs, workspace,
        requiredString(input, 'schematicPath'), config.maxSchematicBytes, exec.signal)
      const requestedDir = input.outputDir === undefined
        ? join(dirname(source.path), 'previews') : requiredString(input, 'outputDir')
      const outputDir = await resolvePreviewOutputDir(ctx.fs, workspace, requestedDir, exec.signal)
      const sources = await collectPreviewSources(ctx.fs, workspace, source, config.maxSchematicBytes, exec.signal)
      const revision = createHash('sha256').update(JSON.stringify(sources)).digest('hex')
      const pageNames = input.pageNames === undefined ? [] : parseUnconnectedPorts(input.pageNames, 'pageNames')
      const regions = resolvePreviewRegions(input.regions, source.text, basename(source.path, '.kicad_sch'), config.flatListLimit)
      const rendered = await renderModulePreview(outputDir, source.path, revision, renderConfig, exec.signal, sources, undefined, pageNames)
      const selectedRegions = input.regions === undefined ? regions.filter(r => rendered.pages.some(p => p.exportedPageName === r.pageName)) : regions
      const crops = await renderPreviewRegions(rendered.pages, selectedRegions, revision, rendered.manifestPath, config, exec.signal)
      const failures = [...rendered.failures, ...crops.failures]
      let overview = null, overviewError = null
      if(input.delivery === true){
        if(!overviewAvailable)overviewError='Preview card service unavailable; use returned local preview paths.'
        else if(!rendered.pages.length)overviewError='No rendered pages available for the overview.'
        else try {
          const project = input.projectDir === undefined ? dirname(source.path) : requiredString(input,'projectDir')
          const resolved = await ctx.fs.resolve(project,{cwd:workspace,signal:exec.signal})
          overview = await createOverview({workspace,projectDir:resolved.displayPath,schematicPath:source.path,revision,pages:rendered.pages,sources})
        }catch(error){exec.signal.throwIfAborted();overviewError=error instanceof Error?error.message:String(error)}
      }
      const renderStatus=rendered.pages.length===0?'error':failures.length>0?'partial':'ok'
      const deliveryStatus=input.delivery!==true?'not_requested':overview?'ready':'blocked'
      const status = deliveryStatus==='blocked'?'error':renderStatus
      // One public manifest entry point, with full source/page/region diagnostics.
      // Keep it separate from the renderer cache so different region selections cannot collide.
      const manifestKey = createHash('sha256').update(JSON.stringify({regions:selectedRegions,delivery:input.delivery===true,projectDir:input.projectDir})).digest('hex').slice(0,20)
      const manifestPath = join(dirname(rendered.manifestPath),`preview-${manifestKey}.json`)
      await writeFile(manifestPath,JSON.stringify({schematicPath:source.path,revision,outputDir,sources,
        pageManifestPath:rendered.manifestPath,regionManifestPath:crops.regionManifestPath,
        cached:rendered.cached,pageCount:rendered.pageCount,pages:rendered.pages,regionImages:crops.regionImages,
        failures,status,renderStatus,deliveryStatus,overview,overviewError},null,2)+'\n','utf8')
      const rootImagePath = rendered.pages.find(page => page.pageSchematicPath===source.path || page.exportedPageName===basename(source.path,'.kicad_sch'))?.pngPath
      return {
        status,renderStatus,deliveryStatus,revision,manifestPath,pageCount:rendered.pageCount,
        pages:rendered.pages.map(({exportedPageName,pngPath})=>({exportedPageName,pngPath})),
        ...(rootImagePath?{rootImagePath}:{}),
        ...(crops.regionImages.length?{regionImages:crops.regionImages.map(({name,pageName,pngPath})=>({name,pageName,pngPath}))}:{}),
        ...(failures.length?{failures}:{}),
        ...(overview?{overview}:{}),...(overviewError?{overviewError}:{}),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Render KiCad module preview', kind: 'read', rawInput: args }),
  }
  const hierarchy: ToolDefinition = {
    name: 'create_kicad_hierarchy',
    description: 'Create a KiCad 10 hierarchical schematic from 1-9 single-sheet modules with explicit hierarchy ports. Connect by port name and root net; all generated hierarchy pins and copied labels are passive. For every port, supply a connection or list it in unconnectedPorts. Preflight reports port and symbol problems across all sheets before writing. The tool does not choose electrical connections, add ports, export a netlist, or run ERC. targetDir is an existing design root, for example designs/alarm_clock (not its schematic subfolder). The schematic subfolder is created during publication; output filenames must be unused. Returns project/root and child paths; warnings and direction conflicts appear only when nonempty. Full assembly details are saved to targetDir/<projectName>.assembly.json.',
    parameters: { type: 'object', additionalProperties: false,
      properties: {
        designPlan:designPlanSchema,
        projectName: { type: 'string', description: 'ASCII filename stem: letters, digits, underscores, and hyphens; starts with a letter.' },
        title: { type: 'string' }, targetDir: { type: 'string', description: 'Existing design root, e.g. designs/alarm_clock. Children go into targetDir/schematic, created automatically. Do not pass designs/alarm_clock/schematic.' },
        sheets: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string' }, sourcePath: { type: 'string' },
            connections: { type: 'array', items: { type: 'object', additionalProperties: false,
              properties: { port: { type: 'string' }, net: { type: 'string' } }, required: ['port', 'net'] } },
            unconnectedPorts: { type: 'array', items: { type: 'string' }, description: 'Explicit hierarchy ports intentionally left without a root net.' },
          }, required: ['name', 'sourcePath', 'connections'] } },
      }, required: ['projectName', 'title', 'targetDir', 'sheets','designPlan'] },
    output: { schema: { type: 'object', additionalProperties: false,
      properties: {
        projectPath: { type: 'string' }, rootPath: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        sheets: { type: 'array', items: { type: 'object', additionalProperties: false,
          properties: { name: { type: 'string' }, schematicPath: { type: 'string' },
            directionConflicts: { type: 'array', items: { type: 'object', additionalProperties: false,
              properties: { name: { type: 'string' }, sourceDirections: { type: 'array', items: { type: 'string' } } },
              required: ['name', 'sourceDirections'] } } },
          required: ['name', 'schematicPath'] } },
      }, required: ['projectPath', 'rootPath', 'sheets'] },
      render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }] },
    async execute(args, exec) {
      const input = validateKeys(args, ['projectName', 'title', 'targetDir', 'sheets','designPlan'], 'create_kicad_hierarchy')
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
      const designPlan=await readWorkspaceDesignPlan(ctx.fs,workspace,input.designPlan,exec.signal)
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
      assertSchematicGrid(files.root)
      for(const child of files.children)assertSchematicGrid(child.text)
      const paths = await publishAssembly(ctx.fs, workspace, targetDir, projectName, files,
        undefined, exec.signal, {designPlan: {path: designPlan.path, sha256: designPlan.sha256},
          sheets: sheets.map(({sourcePath, connections, unconnectedPorts}) => ({sourcePath, connections, unconnectedPorts}))})
      return {projectPath: paths.projectPath, rootPath: paths.rootPath,
        ...(files.warnings.length > 0 ? {warnings: files.warnings} : {}),
        sheets: sheets.map((sheet, index) => ({name: sheet.name, schematicPath: paths.childPaths[index]!,
          ...(files.children[index]!.directionConflicts.length > 0
            ? {directionConflicts: files.children[index]!.directionConflicts} : {})}))}
    },
    presentCall: args => ({ card: 'generic', title: 'Create KiCad hierarchy', kind: 'edit', rawInput: args }),
  }
  for (const tool of [ports, preview, hierarchy]) ctx.effect(() => ctx.tools.register(tool))
}
