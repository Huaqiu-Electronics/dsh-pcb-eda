/** KiCad project checks and compact results for the shared HQ module downloader. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SavedSchematic } from './download-core/save.ts'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { apply as applyDownload, Config } from './download-core/index.ts'
import { validateModuleId } from './download-core/download.ts'
import { createModuleAnalyzer, type AnalysisConfig, type AnalyzeModule } from '../schematic/module-analysis.ts'
import { readModulePorts } from '../schematic/ports.ts'
import { parse } from '../schematic/sexpr.ts'
import { readWorkspaceSchematic } from '../schematic/tools.ts'
import { resolveConfig } from '../config.ts'

export const name = 'kicad-hq-schematic-download'
export const inject = ['tools', 'fs', 'sandboxPolicy', 'hqEdge']
export { Config }

/** HQ Edge project service consumed by the KiCad adapter. */
export interface HqEdge {
  context?: { getTargetHost(): string }
  project: {
    getCurrent(): { projectId: string } | undefined
    onChanged(listener: (project: { projectId: string } | undefined) => void): () => void
  }
}

/** Harness services and the installed HQ Edge extension. */
export type KiCadContext = Pick<Context, 'effect' | 'fs' | 'sandboxPolicy' | 'tools'> & { hqEdge: HqEdge }


function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

async function requireCurrentProject(hqEdge: HqEdge, exec: ToolRunContext): Promise<string> {
  if (hqEdge.context?.getTargetHost() !== 'kicad') {
    throw new Error('This download tool is available only in KiCad')
  }
  const projectId = hqEdge.project?.getCurrent()?.projectId
  const sessionDir = exec.agent?.session?.header?.cwd
  if (typeof projectId !== 'string' || typeof sessionDir !== 'string') {
    throw new Error('Open a KiCad project and start a DSH conversation in that project')
  }
  const [projectPath, workspacePath] = await Promise.all([realpath(projectId), realpath(sessionDir)])
  if (!samePath(projectPath, workspacePath)) {
    throw new Error('The conversation workspace is not the active KiCad project')
  }
  return projectId
}

/** Adapt the shared downloader to the active KiCad project.
 * @param tool - shared download definition.
 * @param hqEdge - installed project service.
 * @returns a compact project-scoped tool definition.
 */
export function adaptTool(tool: ToolDefinition, hqEdge: HqEdge | (() => HqEdge | undefined),
  analyze: AnalyzeModule, readSource: (path: string, exec: ToolRunContext) => Promise<string>): ToolDefinition {
  // A retry reuses a recent receipt scoped to the active project and destination.
  const receipts = new Map<string, SavedSchematic>()
  return {
    ...tool,
    description: 'Download an HQ EDA module and packaged footprints into the active KiCad project. If footprints is null, choose another module; export is skipped. Otherwise read analysis.files for the BOM, components and connectivity, and analysis.ports for explicit hierarchy ports. Empty ports do not rule out connector interfaces. CLI export failure preserves the download. After fixing export, use refreshAnalysis:true with the same moduleId and targetDir to reuse the local download.',
    parameters: {
      ...tool.parameters,
      properties: {
        moduleId: { type: 'string', description: 'Exact module ID from an HQ EDA catalog search result.' },
        targetDir: { type: 'string', description: 'Optional existing subdirectory of the active KiCad project.' },
        refreshAnalysis: {type:'boolean', description:'Retry analysis of a recent download in this plugin process without fetching it again.'},
        kicadCliPath: {type:'string', description:'Optional absolute kicad-cli path from get_eda_host_info, for analysis recovery.'},
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          moduleId: { type: 'string' },
          moduleName: { type: 'string' },
          schematicPath: { type: 'string' },
          schematicStatus: { type: 'string', enum: ['created', 'existing'] },
          sourceProject: {oneOf:[{type:'object',additionalProperties:false,properties:{path:{type:'string'},status:{type:'string',enum:['created','existing']}},required:['path','status']},{type:'null'}]},
          footprints:{oneOf:[{type:'array',items:{type:'object',additionalProperties:false,properties:{footprintPath:{type:'string'},footprintName:{type:'string'}},required:['footprintPath','footprintName']}},{type:'null'}]},
          nextAction: {type:'string'},
          analysis: {type:'object', additionalProperties:true},
        },
        required: ['moduleId', 'moduleName', 'schematicPath', 'schematicStatus', 'sourceProject', 'footprints', 'analysis'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const input = args as Record<string, unknown>
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['moduleId','targetDir','refreshAnalysis','kicadCliPath'].includes(key))) throw new Error('Invalid module download arguments')
      const moduleId = validateModuleId(input.moduleId)
      const {targetDir, refreshAnalysis, kicadCliPath} = input
      if (targetDir !== undefined && (typeof targetDir !== 'string' || !targetDir.trim())) throw new Error('targetDir must be a non-empty path')
      if (refreshAnalysis !== undefined && typeof refreshAnalysis !== 'boolean') throw new Error('refreshAnalysis must be boolean')
      if (kicadCliPath !== undefined && (typeof kicadCliPath !== 'string' || !isAbsolute(kicadCliPath) || !/^kicad-cli(?:\.exe)?$/i.test(basename(kicadCliPath)))) throw new Error('kicadCliPath must be an absolute kicad-cli executable path')
      const host = typeof hqEdge === 'function' ? hqEdge() : hqEdge
      if (!host) throw new Error('Open KiCad with HQ Edge before downloading a schematic module')
      const projectId = await requireCurrentProject(host, exec)
      const changed = new AbortController()
      const unsubscribe = host.project.onChanged((project) => {
        if (project?.projectId !== projectId) {
          changed.abort(new Error('Active KiCad project changed during download'))
        }
      })
      try {
        const combined = {...exec, signal: AbortSignal.any([exec.signal, changed.signal])}
        const key = JSON.stringify([projectId, resolve(projectId, targetDir?.trim() ?? '.'), moduleId])
        const previous = refreshAnalysis ? receipts.get(key) : undefined
        if (refreshAnalysis && !previous) throw new Error('No recent local download receipt. Download this module first.')
        const result = previous ?? await tool.execute({moduleId, ...(targetDir === undefined ? {} : {targetDir})}, combined) as SavedSchematic
        receipts.delete(key)
        receipts.set(key, result)
        if (receipts.size > 32) receipts.delete(receipts.keys().next().value!)
        const analysis = result.footprints.length
          ? await analyzeDownload(result, combined, analyze, readSource, refreshAnalysis === true, kicadCliPath)
          : {status:'skipped', reason:'no_packaged_footprints'}
        combined.signal.throwIfAborted()
        return {
          moduleId: result.moduleId,
          moduleName: result.moduleName,
          schematicPath: result.schematicPath,
          schematicStatus: previous ? 'existing' : result.status,
          sourceProject: result.originalProjectPath && result.originalProjectStatus !== 'absent'
            ? {path:result.originalProjectPath,status:result.originalProjectStatus} : null,
          footprints: result.footprints.length ? result.footprints.map(({footprintName,footprintPath})=>({footprintName,footprintPath})) : null,
          analysis,
          ...(result.footprints.length ? {} : {nextAction:'The module download package contains no footprint files. Select another module.'}),
        }
      } finally {
        unsubscribe()
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Download schematic for KiCad project', kind: 'edit', rawInput: args }),
  }
}

async function analyzeDownload(result: SavedSchematic, exec: ToolRunContext, analyze: AnalyzeModule,
  readSource: (path: string, exec: ToolRunContext) => Promise<string>, refresh: boolean, kicadCliPath?: string) {
  const ports = await (async () => {
    try {
      const parsed = readModulePorts(parse(await readSource(result.schematicPath, exec)))
      return {status:'ready', count:parsed.ports.length, items:parsed.ports.slice(0, 60).map(port => port.name.slice(0, 200)),
        directionConflicts:parsed.directionConflicts.slice(0, 60).map(conflict => ({...conflict, name:conflict.name.slice(0, 200)})),
        ...(parsed.ports.length > 60 || parsed.ports.some(port => port.name.length > 200) ? {
          truncated:true,
          nextAction:'The port summary is truncated. Call list_kicad_hierarchical_ports with the returned schematicPath for the full port names.',
        } : {})}
    } catch (error) {
      exec.signal.throwIfAborted()
      return {status:'unavailable', message:String(error).slice(0, 400)}
    }
  })()
  try {
    const {analysis} = await analyze(result.schematicPath, exec, {view:'summary', refresh,
      ...(result.originalProjectPath ? {sourceProjectPath:result.originalProjectPath} : {}), ...(kicadCliPath ? {kicadCliPath} : {})})
    const files = {...(analysis.counts?.components === undefined ? {} : {components:analysis.files?.components}),
      ...(analysis.stages?.netlist?.status === 'ready' ? {connectivity:analysis.files?.connectivity} : {}),
      ...(analysis.files?.bom ? {bom:analysis.files.bom} : {})}
    return {status: ports.status === 'unavailable' && analysis.status === 'ready' ? 'partial' : analysis.status,
      ports, ...(analysis.counts ? {counts:analysis.counts} : {}),
      ...(Object.values(files).some(Boolean) ? {files, filesHint:'Read the relevant file under analysis.files for component, BOM or connectivity details.'} : {}),
      ...(analysis.stages ? {stages:analysis.stages} : {}),
      ...(analysis.failure ? {failure:analysis.failure} : {}),
      ...(analysis.status === 'ready' ? {} : {diagnostics:analysis.diagnostics, nextAction:analysis.nextAction})}
  } catch (error) {
    exec.signal.throwIfAborted()
    return {status:'unavailable', ports, diagnostics:[String(error).slice(0, 400)], nextAction:'Fix the export problem and retry with refreshAnalysis:true.'}
  }
}

export function createDownloadAdapter(ctx: Pick<Context,'fs'|'sandboxPolicy'>, config: AnalysisConfig) {
  const analyze = createModuleAnalyzer(ctx, config)
  return (tool: ToolDefinition, host: Parameters<typeof adaptTool>[1]) => adaptTool(tool, host, analyze,
    async (path, exec) => (await readWorkspaceSchematic(ctx.fs, exec.agent!.session.header.cwd!, path, config.maxSchematicBytes, exec.signal)).text)
}

/** Register the shared download tool with KiCad project checks.
 * @param ctx - harness services with the HQ Edge project extension.
 * @param config - download origin and resource limits.
 */
export function apply(ctx: KiCadContext, config: Parameters<typeof applyDownload>[1]): void {
  const hqEdge = ctx.hqEdge
  if (hqEdge?.context?.getTargetHost() !== 'kicad') {
    throw new Error('kicad-hq-schematic-download requires a KiCad HQ Edge host')
  }
  const adapt = createDownloadAdapter(ctx, resolveConfig().schematic)
  applyDownload({
    effect: callback => ctx.effect(callback),
    fs: ctx.fs,
    sandboxPolicy: ctx.sandboxPolicy,
    tools: { register: tool => ctx.tools.register(adapt(tool, hqEdge)) },
  }, config)
}
