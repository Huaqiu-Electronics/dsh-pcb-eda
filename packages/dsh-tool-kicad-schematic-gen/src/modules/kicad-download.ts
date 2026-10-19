/** KiCad project checks and compact results for the shared HQ module downloader. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SavedSchematic } from './download-core/save.ts'
import { realpath } from 'node:fs/promises'
import { apply as applyDownload, Config } from './download-core/index.ts'
import type {AnalyzeModule, AnalysisResult} from '../schematic/module-analysis.ts'

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
export function adaptTool(tool: ToolDefinition, hqEdge: HqEdge | (() => HqEdge | undefined), analyze?: AnalyzeModule): ToolDefinition {
  return {
    ...tool,
    description: 'Download an HQ EDA module KiCad schematic by catalog ID into the active KiCad project directory or an existing subdirectory. The current schematic and PCB are not modified. A matching source project is saved as a separate reference file when present. Automatically extracts local netlist/BOM analysis when available; inspect analysis status, then query analyze_kicad_module instead of reading entire files or guessing connections from images. Analysis failure preserves the successful download; retry analysis alone. No ERC.',
    parameters: {
      ...tool.parameters,
      properties: {
        moduleId: { type: 'string', description: 'Exact module ID from an HQ EDA catalog search result.' },
        targetDir: { type: 'string', description: 'Optional existing subdirectory of the active KiCad project.' },
        kicadCliPath: {type: 'string', description: 'Optional known host CLI path; otherwise plugin configuration/discovery is used.'},
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
          sourceProjectPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          schematicStatus: { type: 'string', enum: ['created', 'existing'] },
          sourceProjectStatus: { type: 'string', enum: ['created', 'existing', 'absent'] },
          analysis: {type: 'object'},
          footprints:{type:'array',items:{type:'object',properties:{archiveEntry:{type:'string'},footprintPath:{type:'string'},footprintName:{type:'string'},sha256:{type:'string'}},required:['archiveEntry','footprintPath','footprintName','sha256']}},
        },
        required: ['moduleId', 'moduleName', 'schematicPath', 'sourceProjectPath', 'schematicStatus', 'sourceProjectStatus'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
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
        const input = args as Record<string, unknown>
        const kicadCliPath = input?.kicadCliPath
        if (kicadCliPath !== undefined && (typeof kicadCliPath !== 'string' || !kicadCliPath.trim())) throw new Error('kicadCliPath must be a non-empty string')
        const downloadArgs = input && typeof input === 'object' && !Array.isArray(input) ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'kicadCliPath')) : args
        const result = await tool.execute(downloadArgs, combined) as SavedSchematic
        let analysis: AnalysisResult | undefined
        if (analyze) {
          try {analysis = (await analyze(result.schematicPath, combined, {sourceProjectPath: result.originalProjectPath ?? undefined, kicadCliPath: kicadCliPath as string | undefined})).analysis}
          catch (error) {
            combined.signal.throwIfAborted()
            analysis = {status: 'unavailable', cached: false, diagnostics: [String(error).slice(0, 1600)],
              nextAction: 'Download succeeded. Correct diagnostics, then call analyze_kicad_module with schematicPath and view:summary; do not download again.'}
          }
        }
        return {
          moduleId: result.moduleId,
          moduleName: result.moduleName,
          schematicPath: result.schematicPath,
          sourceProjectPath: result.originalProjectPath,
          schematicStatus: result.status,
          sourceProjectStatus: result.originalProjectStatus,
          footprints: result.footprints,
          ...(analysis ? {analysis} : {}),
        }
      } finally {
        unsubscribe()
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Download schematic for KiCad project', kind: 'edit', rawInput: args }),
  }
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
  applyDownload({
    effect: callback => ctx.effect(callback),
    fs: ctx.fs,
    sandboxPolicy: ctx.sandboxPolicy,
    tools: { register: tool => ctx.tools.register(adaptTool(tool, hqEdge)) },
  }, config)
}
