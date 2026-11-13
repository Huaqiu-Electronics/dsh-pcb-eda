/** KiCad model and datasheet inspection, and Symbol import. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolDefinition, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { getDatasheet, type DatasheetOptions } from './datasheet.ts'
import { getComponentModels } from './models.ts'

import { partIdentity } from './identity.ts'
import { importComponent } from './import-component.ts'

import type { Config } from './config.ts'

/** Match the public identity contract of @huaqiu/dsh-tool-part-search. */
const componentParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    manufacturer_id: { type: 'string', description: 'Manufacturer ID: use manufacturer.id from search_hqsch_parts.' },
    mpn: { type: 'string', description: 'Exact manufacturer part number from the same candidate.' },
  },
  required: ['manufacturer_id', 'mpn'],
} satisfies JsonSchemaNode

const importParameters = {
  ...componentParameters,
  properties: {
    ...componentParameters.properties,
    projectDir: { type: 'string', description: 'Existing KiCad project directory inside this session workspace; defaults to the workspace root.' },
  },
} satisfies JsonSchemaNode

export function createKicadLibraryTools(ctx: Context, config: Config): ToolDefinition[] {
  const datasheetOptions: DatasheetOptions = {
    structuredApiBaseUrl: config.structuredApiBaseUrl,
    requestTimeoutMs: config.datasheetRequestTimeoutMs,
    maxPdfBytes: config.maxPdfBytes,
    maxPdfPages: config.maxPdfPages,
    maxTextChars: config.maxTextChars,
    maxImages: config.maxImages,
    allowedPdfHosts: config.allowedPdfHosts,
  }

  const modelsTool: ToolDefinition = {
    name: 'get_kicad_component_models',
    description: 'Inspect only the KiCad symbol and pins for an exact manufacturer ID and MPN from search_hqsch_parts. Returns part and symbol: status, name, supported units and pins with numeric unit (0=common, null=unrecognized). Common-only normalization to unit 1 is explicit; unsupported units return error. No footprint fetch, file writes or pin-pad validation; import_kicad_component_symbol_and_footprint prepares and checks both models.',
    parameters: componentParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          part: { type: 'string' },
          symbol: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['missing', 'parsed', 'invalid'] },
              code: { type: 'string', enum: ['MODEL_FORMAT_INVALID', 'MODEL_PARSE_FAILED'] },
              sourceUrl: { type: 'string' }, message: { type: 'string' },
              retryUnchanged: { type: 'boolean', enum: [false] }, nextAction: { type: 'string' },
              name: { type: 'string' },
              units: {type:'array',items:{type:'integer'}},
              normalization: {type:'string',enum:['common_only_to_unit_1']},
              error: {type:'object',additionalProperties:false,properties:{code:{type:'string',enum:['SYMBOL_UNITS_UNSUPPORTED']},nextAction:{type:'string'}},required:['code','nextAction']},
              pins: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    unit: {oneOf:[{type:'integer'},{type:'null'}]},
                    number: { type: 'string' },
                    name: { type: 'string' },
                    type: { type: 'string' },
                  },
                  required: ['unit', 'number', 'name', 'type'],
                },
              },
            },
            required: ['status'],
          },

        },
        required: ['part', 'symbol'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('component arguments must be an object')
      }
      const { mfgId, mpn } = partIdentity(args as Record<string, unknown>)
      return getComponentModels(mfgId, mpn.trim(), config, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'Inspect KiCad models', kind: 'read', rawInput: args }),
  }
  const datasheetTool: ToolDefinition = {
    name: 'get_kicad_datasheet',
    description: 'Read datasheet information for one exact IC selected by search_hqsch_parts. Returns bounded structured sections and original HTTPS application-image links; if structured text is absent, returns bounded PDF text. Image links are not image content, and PDF text may omit tables or diagrams. Do not infer unreported electrical parameters.',
    parameters: componentParameters,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          part: { type: 'string' },
          status: { type: 'string', enum: ['found', 'missing'] },
          source: { type: 'string', enum: ['structured', 'pdf', 'none'] },
          datasheetUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          sections: {
            type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: {
                contentType: { type: 'number' }, title: { type: 'string' },
                text: { type: 'string' }, imageUrls: { type: 'array', items: { type: 'string' } },
              },
              required: ['contentType', 'title', 'text', 'imageUrls'],
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['part', 'status', 'source', 'datasheetUrl', 'sections', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown, exec) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('datasheet arguments must be an object')
      }
      const { mfgId, mpn } = partIdentity(args as Record<string, unknown>)
      return getDatasheet(mfgId, mpn.trim(), datasheetOptions, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: 'Read IC datasheet', kind: 'read', rawInput: args }),
  }
  const componentTool: ToolDefinition = {
    name: 'import_kicad_component_symbol_and_footprint',
    description: 'Import both the symbol and footprint for an exact searched component into project-local libraries. If the part detail lists no footprint, FOOTPRINT_NOT_AVAILABLE identifies the candidate; return to part search and select a suitable alternative. Download, format and pin/pad errors are distinct from missing availability. Verifies symbol units and matching unique pin/pad numbers before writing. Fills missing symbol properties from exact-part detail and binds the symbol default to kicad_api_lib:<exact MPN>. Returns libraryPath, libId, footprintId and units when placement cannot default to the sole unit 1. Number matching does not verify electrical compatibility or package dimensions.',
    parameters: importParameters,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          libId: { type: 'string' },
          libraryPath: { type: 'string' },
          footprintId: { type: 'string' },
          units: { type: 'array', items: { type: 'integer' } },
        },
        required: ['libId', 'libraryPath', 'footprintId'],
      },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    },
    async execute(args: unknown, exec) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('component arguments must be an object')
      const { mfgId, mpn } = partIdentity(args as Record<string, unknown>)
      const input=args as Record<string,unknown>
      if(Object.keys(input).some(key=>!['manufacturer_id','mpn','projectDir'].includes(key)))throw new Error('Unsupported component import parameter')
      const { projectDir } = input
      if (projectDir !== undefined && (typeof projectDir !== 'string' || !projectDir.trim())) throw new Error('projectDir must be a non-empty path when supplied')
      const agent = exec.agent
      const cwd = agent?.session.header.cwd
      if (!agent || !cwd) throw new Error('import_kicad_component_symbol_and_footprint requires an agent session workspace')
      const policy=ctx.sandboxPolicy.resolve({session:agent.session})
      const { libId, libraryPath, footprintId, builderCompatibility } = await importComponent(
        mfgId, mpn, projectDir as string | undefined, cwd, config, ctx.fs, policy, exec.signal)
      const units = builderCompatibility.availableUnits
      return {
        libId, libraryPath, footprintId,
        ...(units.length === 1 && units[0] === 1 ? {} : { units }),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Import KiCad component and footprint', kind: 'edit', rawInput: args }),
  }
  return [modelsTool, datasheetTool, componentTool]
}
