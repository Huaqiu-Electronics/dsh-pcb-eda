/** Download one selected HQ EDA module's KiCad schematic into the agent workspace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import Schema from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateDownloadOptions, validateModuleId, type DownloadOptions } from './download.ts'
import { downloadIntoWorkspace } from './save.ts'

export const name = 'hq-eda-schematic-download'
export const inject = ['tools', 'fs', 'sandboxPolicy']

/** Registry origin and limits for detail, ZIP, and schematic content. */
export type Config = DownloadOptions

export const Config: Schema<Config> = Schema.object({
  apiBaseUrl: Schema.string().required(),
  requestTimeoutMs: Schema.number().required(),
  maxDetailBytes: Schema.number().required(),
  maxZipBytes: Schema.number().required(),
  maxSchematicBytes: Schema.number().required(),
  maxProjectBytes: Schema.number().required(),
  maxArchiveEntries: Schema.number().required(),
})

/** Register the workspace-scoped schematic download tool. */
export function apply(ctx: Pick<Context, 'effect' | 'fs' | 'sandboxPolicy'> & {
  tools: Pick<Context['tools'], 'register'>
}, config: Config): void {
  validateDownloadOptions(config)
  const tool: ToolDefinition = {
    name: 'download_eda_module_schematic',
    description: 'Download the selected HQ EDA module ZIP by catalog ID, save its sole KiCad .kicad_sch and an optional matching source .kicad_pro inside the current agent workspace, and report every archive entry. The source project is evidence, not an active project. The target directory must already exist. Existing different content is never overwritten. This does not open or modify the current KiCad project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        moduleId: { type: 'string', description: 'Exact module ID from an HQ EDA catalog search result.' },
        targetDir: { type: 'string', description: 'Optional existing directory inside this agent workspace; defaults to the workspace root.' },
      },
      required: ['moduleId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          moduleId: { type: 'string' },
          moduleName: { type: 'string' },
          schematicPath: { type: 'string' },
          sourceUrl: { type: 'string' },
          archiveEntry: { type: 'string' },
          archiveEntries: { type: 'array', items: { type: 'string' } },
          footprints:{type:'array',items:{type:'object',properties:{archiveEntry:{type:'string'},footprintPath:{type:'string'},footprintName:{type:'string'},sha256:{type:'string'}},required:['archiveEntry','footprintPath','footprintName','sha256']}},
          sha256: { type: 'string' },
          bytes: { type: 'integer' },
          status: { type: 'string', enum: ['created', 'existing'] },
          originalProjectPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          originalProjectArchiveEntry: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          originalProjectSha256: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          originalProjectBytes: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          originalProjectStatus: { type: 'string', enum: ['created', 'existing', 'absent'] },
        },
        required: ['moduleId', 'moduleName', 'schematicPath', 'sourceUrl', 'archiveEntry', 'archiveEntries',
          'sha256', 'bytes', 'status', 'originalProjectPath', 'originalProjectArchiveEntry',
          'originalProjectSha256', 'originalProjectBytes', 'originalProjectStatus'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('download_eda_module_schematic arguments must be an object')
      }
      const input = args as Record<string, unknown>
      if (Object.keys(input).some(key => key !== 'moduleId' && key !== 'targetDir')) {
        throw new Error('download_eda_module_schematic accepts only moduleId and targetDir')
      }
      const moduleId = validateModuleId(input.moduleId)
      const targetDir = input.targetDir
      if (targetDir !== undefined && (typeof targetDir !== 'string' || !targetDir.trim())) {
        throw new Error('targetDir must be a non-empty path when supplied')
      }
      const agent = exec.agent
      if (agent === undefined) throw new Error('download_eda_module_schematic requires an agent session workspace')
      const workspaceRoot = agent.session.header.cwd
      if (workspaceRoot === undefined) throw new Error('download_eda_module_schematic requires an agent session workspace')
      return downloadIntoWorkspace(moduleId, targetDir as string | undefined, workspaceRoot,
        config, ctx.fs, ctx.sandboxPolicy.resolve({ session: agent.session }), exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'Download EDA KiCad schematic', kind: 'edit', rawInput: args }),
  }
  ctx.effect(() => ctx.tools.register(tool))
}
