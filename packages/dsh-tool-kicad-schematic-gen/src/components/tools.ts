/** KiCad model and datasheet inspection, and Symbol import. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ToolDefinition, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { getDatasheet, type DatasheetOptions } from './datasheet.ts'
import { importSymbol, summarizeImportedSymbol, saveSymbolImportRecord } from './import-symbol.ts'
import { getComponentModels } from './models.ts'

import { partIdentity } from './identity.ts'
import { importComponent } from './import-component.ts'
import {inspectModuleFootprints,localizeFootprints,summarizeModuleFootprints,type FootprintAssignment} from './module-footprints.ts'

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
    scope: {type:'string',enum:['symbol_and_footprint','symbol'],description:'Default symbol_and_footprint: require both models and matching pin/pad numbers. Use symbol only for explicitly schematic-only work or an already verified footprint. Never downgrade automatically.'},
  },
} satisfies JsonSchemaNode

const builderCompatibilitySchema = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', enum: ['ready', 'unsupported_units'] },
  availableUnits: { type: 'array', items: { type: 'integer' } }, nextAction: { type: 'string' },
  normalization: { type: 'string', enum: ['common_only_to_unit_1'] },
}, required: ['status', 'availableUnits', 'nextAction'] } satisfies JsonSchemaNode

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

  const symbolImportSchema:JsonSchemaNode = {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope:{type:'string',enum:['symbol']},
          part: { type: 'string' },
          libId: { type: 'string' },
          libraryPath: { type: 'string' },
          units: {type:'array',items:{type:'integer'}},
          symbolTextRepaired: { type: 'boolean',enum:[true] },
          normalization: {type:'string',enum:['common_only_to_unit_1']},
          error: {type:'object',additionalProperties:false,properties:{code:{type:'string',enum:['SYMBOL_UNITS_UNSUPPORTED']},nextAction:{type:'string'}},required:['code','nextAction']},
          library: { type: 'string', enum: ['created', 'existing'] },
          table: { type: 'string', enum: ['created', 'updated', 'existing'] },
        },
        required: ['scope','part', 'libId', 'libraryPath', 'units', 'library', 'table'],
      }
  const modelsTool: ToolDefinition = {
    name: 'get_kicad_component_models',
    description: 'Inspect only the KiCad symbol and pins for an exact manufacturer ID and MPN from search_hqsch_parts. Returns part and symbol: status, name, supported units and pins with numeric unit (0=common, null=unrecognized). Common-only normalization to unit 1 is explicit; unsupported units return error. No footprint fetch, file writes or pin-pad validation; import_kicad_component prepares and checks both models.',
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
    name: 'import_kicad_component',
    description: 'Unified importer: scope defaults to symbol_and_footprint; scope:symbol imports only a symbol with compact part/libId/libraryPath/units/library/table output and conditional repair/normalization/error fields. Both modes fill missing symbol properties from exact-part detail (MPN, manufacturer, huaqiu_pn, description, datasheet URL and technical attributes); existing nonempty properties are preserved, and addSymbol carries custom fields into hidden instance properties. Symbol-only provenance is at libraryPath + .import.json; do not place unsupported units. No automatic downgrade when paired import fails. In default mode download and register BOTH the symbol and footprint for an exact searched component into project-local .kicad_sym and .pretty libraries, sym-lib-table and fp-lib-table. Rejects missing/invalid models, unsupported symbol units, and mismatching unique pin/pad number sets before writing. Search availability flags are not trusted. Returns verified hasSymbol/hasFootprint plus libraryPath, libId and footprintId. Paired imports use kicad_api_lib:<exact MPN>, save <MPN>.kicad_mod in a shared project-local library, and write the same Footprint default into the symbol. Existing project-local kicad_api_lib registrations are reused. Same-name different-content models are rejected. addSymbol inherits this default; explicit footprintId is also supported. Does not place a symbol or create a PCB; number matching is not electrical or package-dimension validation. Existing different files are not overwritten. Interrupted writes can leave partial files; errors report their location.',
    parameters: importParameters,
    output: {
      schema: {oneOf:[symbolImportSchema,{
        type: 'object', additionalProperties: true,
        properties: {
          scope:{type:'string',enum:['symbol_and_footprint']},
          part: { type: 'string' }, hasSymbol: { type: 'boolean', enum: [true] }, hasFootprint: { type: 'boolean', enum: [true] },
          libId: { type: 'string' }, libraryPath: { type: 'string' }, tablePath: { type: 'string' },
          footprintId: { type: 'string' }, footprintPath: { type: 'string' }, footprintTablePath: { type: 'string' },
          footprintSourceUrl: { type: 'string' }, footprintSha256: { type: 'string' },
          pinCount: { type: 'number' }, padCount: { type: 'number' }, builderCompatibility: builderCompatibilitySchema,
          validation: { type: 'object', additionalProperties: false, properties: {
            pinPadMatch: { type: 'string', enum: ['number_sets_match'] },
            pinNumbers: { type: 'array', items: { type: 'string' } }, padNumbers: { type: 'array', items: { type: 'string' } },
            electricalCompatibility: { type: 'string', enum: ['not_checked'] }, packageDimensions: { type: 'string', enum: ['not_checked'] },
          }, required: ['pinPadMatch', 'pinNumbers', 'padNumbers', 'electricalCompatibility', 'packageDimensions'] },
          nextAction: { type: 'string' },
        },
        required: ['scope','part', 'hasSymbol', 'hasFootprint', 'libId', 'libraryPath', 'footprintId', 'footprintPath', 'footprintTablePath', 'validation', 'builderCompatibility', 'nextAction'],
      }]},
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    },
    async execute(args: unknown, exec) {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('component arguments must be an object')
      const { mfgId, mpn } = partIdentity(args as Record<string, unknown>)
      const input=args as Record<string,unknown>
      if(Object.keys(input).some(key=>!['manufacturer_id','mpn','projectDir','scope'].includes(key)))throw new Error('Unsupported component import parameter')
      const { projectDir } = input
      const scope=input.scope===undefined?'symbol_and_footprint':input.scope
      if(scope!=='symbol'&&scope!=='symbol_and_footprint')throw new Error('scope must be symbol or symbol_and_footprint')
      if (projectDir !== undefined && (typeof projectDir !== 'string' || !projectDir.trim())) throw new Error('projectDir must be a non-empty path when supplied')
      const agent = exec.agent
      const cwd = agent?.session.header.cwd
      if (!agent || !cwd) throw new Error('import_kicad_component requires an agent session workspace')
      const policy=ctx.sandboxPolicy.resolve({session:agent.session})
      if(scope==='symbol'){
        const result=await importSymbol(mfgId,mpn,projectDir as string|undefined,cwd,config,ctx.fs,policy,exec.signal)
        await saveSymbolImportRecord(result,cwd,ctx.fs,policy,exec.signal)
        return {scope,...summarizeImportedSymbol(result)}
      }
      return {scope,...await importComponent(mfgId, mpn, projectDir as string | undefined, cwd, config,
        ctx.fs, policy, exec.signal)}
    },
    presentCall: args => ({ card: 'generic', title: (args as {scope?:string})?.scope==='symbol'?'Import KiCad symbol':'Import KiCad component and footprint', kind: 'edit', rawInput: args }),
  }
  const moduleFootprints:ToolDefinition={
   name:'localize_kicad_module_footprints',
   description:'List physical instances (including DNP), check_mapping to verify prepared libraries against an unchanged source, check to audit actual Footprint fields in a generated schematic, or import selected footprints. Import does not update the source unless targetPath is supplied. prepared means libraries/mappings ready, not source updated; persist mappingPath as importModule footprintMappingPath, then check the generated final schematic. Full mappings are in mappingPath; list omits libId (read source if needed); unresolved items contain only reference, footprintId and reason. Success omits nextAction. Use archive footprintPath first; otherwise BOTH exact manufacturer_id and mpn from search are mandatory. Downloads run at concurrency 4 with a bounded 15-minute success cache; validation completes before sequential project writes. Number matching is not package/electrical validation.',
   parameters:{type:'object',additionalProperties:false,properties:{
    action:{type:'string',enum:['list','check_mapping','check','import']},schematicPath:{type:'string'},projectDir:{type:'string'},targetPath:{type:'string',description:'Optional explicitly selected workspace schematic copy to update; omit to keep source module immutable.'},
    assignments:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,properties:{references:{type:'array',items:{type:'string'},minItems:1},manufacturer_id:{type:'string'},mpn:{type:'string'},footprintPath:{type:'string'},allowedExtraPads:{type:'array',items:{type:'string'}},extraPadReason:{type:'string'}},required:['references']}},
   },required:['action','schematicPath']},
   output:{schema:{type:'object',additionalProperties:true},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
   async execute(args,exec){
    const a=args as {action:string;schematicPath:string;projectDir?:string;targetPath?:string;assignments?:FootprintAssignment[]};
    if(!a||typeof a.schematicPath!=='string'||!['list','check_mapping','check','import'].includes(a.action))throw new Error('Use list, check_mapping, check or import with schematicPath');
    const agent=exec.agent,cwd=agent?.session.header.cwd;if(!agent||!cwd)throw new Error('A session workspace is required');
    if(a.action==='list')return summarizeModuleFootprints(await inspectModuleFootprints(a.schematicPath,undefined,cwd,ctx.fs,exec.signal));
    if(typeof a.projectDir!=='string'||!a.projectDir.trim())throw new Error('projectDir required for check/import');
    if(a.action==='check'||a.action==='check_mapping')return summarizeModuleFootprints(await inspectModuleFootprints(a.schematicPath,a.projectDir,cwd,ctx.fs,exec.signal,a.action==='check_mapping'));
    if(!Array.isArray(a.assignments)||!a.assignments.length||a.assignments.length>200)throw new Error('Import requires 1–200 explicit assignments');
    return summarizeModuleFootprints(await localizeFootprints({...a,projectDir:a.projectDir,assignments:a.assignments},cwd,config,ctx.fs,ctx.sandboxPolicy.resolve({session:agent.session}),exec.signal));
   },
   presentCall:args=>({card:'generic',title:'Localize module footprints',kind:(args as {action?:string})?.action==='import'?'edit':'read',rawInput:args}),
  };
  return [modelsTool, datasheetTool, componentTool,moduleFootprints]
}
