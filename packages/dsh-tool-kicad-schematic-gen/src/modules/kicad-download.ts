/** KiCad project checks and compact results for the shared HQ module downloader. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SavedSchematic } from './download-core/save.ts'
import { realpath } from 'node:fs/promises'
import { apply as applyDownload, Config } from './download-core/index.ts'

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
export function adaptTool(tool: ToolDefinition, hqEdge: HqEdge | (() => HqEdge | undefined)): ToolDefinition {
  return {
    ...tool,
    description: 'Download an HQ EDA module into the active KiCad project or an existing subdirectory without modifying the current schematic or PCB. Returns the schematic path and write status, sourceProject reference or null, and footprints with names and local paths or null when none were extracted. Both fields are always present. Does not analyze the circuit or require KiCad CLI; query analyze_kicad_module only when components, BOM or electrical nets are needed.',
    parameters: {
      ...tool.parameters,
      properties: {
        moduleId: { type: 'string', description: 'Exact module ID from an HQ EDA catalog search result.' },
        targetDir: { type: 'string', description: 'Optional existing subdirectory of the active KiCad project.' },
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
        },
        required: ['moduleId', 'moduleName', 'schematicPath', 'schematicStatus', 'sourceProject', 'footprints'],
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
        const result = await tool.execute(args, combined) as SavedSchematic
        return {
          moduleId: result.moduleId,
          moduleName: result.moduleName,
          schematicPath: result.schematicPath,
          schematicStatus: result.status,
          sourceProject: result.originalProjectPath && result.originalProjectStatus !== 'absent'
            ? {path:result.originalProjectPath,status:result.originalProjectStatus} : null,
          footprints: result.footprints.length ? result.footprints.map(({footprintName,footprintPath})=>({footprintName,footprintPath})) : null,
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
