/** Bounded, view-scoped queries over KiCad-exported circuit data. */
import type {Context} from '@deepseek-ai/cordis'
import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import {basename, isAbsolute} from 'node:path'
import {createModuleAnalyzer, type AnalysisConfig, type AnalyzeModule, type AnalysisData, type AnalysisComponent, type AnalysisView} from './module-analysis.ts'
import {requiredString, validateKeys} from './input.ts'

/** Keep usable core identity when custom fields alone exceed the response budget.
 * Grouping is already complete before this projection; full fields stay in local artifacts.
 */
function boundCustomFields(item: object): object {
  if(JSON.stringify(item).length<=24000)return item
  const record=item as Record<string,unknown>,fields=record.fields
  if(!fields || typeof fields!=='object' || Array.isArray(fields))return item
  const {fields:_fields,...core}=record
  const compact: Record<string,unknown>={...core,fieldsTruncated:true}
  const kept: Record<string,unknown>={}
  // Keep short procurement identity first, then other fields within the remaining budget.
  const entries=Object.entries(fields).sort(([a],[b])=>Number(!/^(mpn|manufacturer|manufacturer_part_number)$/i.test(a))-Number(!/^(mpn|manufacturer|manufacturer_part_number)$/i.test(b)))
  for(const [key,value] of entries){
    const bounded=typeof value==='string'&&value.length>1000?value.slice(0,1000):value
    if(JSON.stringify({...compact,fields:{...kept,[key]:bounded}}).length<=20000)kept[key]=bounded
  }
  if(Object.keys(kept).length)compact.fields=kept
  return compact
}

/** Bound both item count and serialized text; never silently truncate a connection record. */
export function pageAnalysisItems(items: object[], offset: number) {
  const page: object[] = []; let chars = 0, next = offset
  for (const original of items.slice(offset, offset + 60)) {
    const item=boundCustomFields(original)
    const size = JSON.stringify(item).length
    if (size > 24000) {
      if (page.length) break
      page.push({omitted: true, reason: 'This single record exceeds 24000 characters; inspect the local analysis file selectively. It is not an empty record.'})
      next++; break
    }
    if (chars + size > 24000) break
    page.push(item); chars += size; next++
  }
  return {items: page, totalItems: items.length, nextOffset: next < items.length ? next : null}
}

/** Omitted assembly flags are false; omitted BOM membership is unknown, not false. */
function componentItem(c: AnalysisComponent, detail: boolean) {
  return {reference: c.reference, ...(c.value === null ? {} : {value: c.value}),
    ...(c.footprint === null ? {} : {footprint: c.footprint}),
    ...(c.dnp ? {dnp: true} : {}), ...(c.excludeFromBom ? {excludeFromBom: true} : {}),
    ...(c.excludeFromBoard ? {excludeFromBoard: true} : {}),
    ...(c.bomIncluded == null ? {} : {bomIncluded: c.bomIncluded}),
    ...(detail && c.sheetPath ? {sheetPath: c.sheetPath} : {}),
    ...(detail && Object.keys(c.fields).length ? {fields: c.fields} : {})}
}

export function queryAnalysisItems(data: AnalysisData, view: string, reference?: string, pin?: string, net?: string): object[] {
  const components = (data.components ?? []).filter(c => !reference || c.reference === reference)
  if (view === 'components') return components.map(c => componentItem(c, !!reference))
  if (view === 'bom') {
    if (!data.bomAvailable) return []
    const groups = new Map<string, {references: string[]; value: string | null; footprint: string | null;
      quantity: number; dnp: boolean; excludeFromBom: boolean; excludeFromBoard: boolean; fields: Record<string, string>}>()
    for (const c of components.filter(c => c.bomIncluded)) {
      // Include ALL source fields and assembly flags in identity; never merge different MPNs.
      const fields = Object.fromEntries(Object.entries(c.fields).sort(([a], [b]) => a.localeCompare(b)))
      const identity = {value: c.value, footprint: c.footprint, dnp: c.dnp,
        excludeFromBom: c.excludeFromBom, excludeFromBoard: c.excludeFromBoard, fields}
      const key = JSON.stringify(identity), group = groups.get(key)
      if (group) {group.references.push(c.reference); group.quantity++}
      else groups.set(key, {...identity, references: [c.reference], quantity: 1})
    }
    return [...groups.values()].map(g => ({references: g.references, quantity: g.quantity,
      ...(g.value === null ? {} : {value: g.value}), ...(g.footprint === null ? {} : {footprint: g.footprint}),
      ...(g.dnp ? {dnp: true} : {}), ...(g.excludeFromBom ? {excludeFromBom: true} : {}),
      ...(g.excludeFromBoard ? {excludeFromBoard: true} : {}),
      ...(Object.keys(g.fields).length ? {fields: g.fields} : {})}))
  }
  if (view === 'nets') return (data.nets ?? []).filter(n => (!net || n.name === net)
    && (!reference || n.nodes.some(node => node.reference === reference && (!pin || node.pin === pin))))
    .flatMap(n => {
      // Split large networks into bounded chunks; pagination never silently loses nodes.
      const chunks: object[] = []
      for (let offset = 0; offset < Math.max(n.nodes.length, 1); offset += 32) chunks.push({net: n.name,
        ...(n.nodes.length > 32 ? {nodeOffset: offset, totalNodes: n.nodes.length} : {}),
        nodes: n.nodes.slice(offset, offset + 32).map(node => ({reference: node.reference, pin: node.pin,
          ...(node.pinName ? {pinName: node.pinName} : {}), ...(node.pinType ? {pinType: node.pinType} : {})}))})
      return chunks
    })
  return []
}

export function registerModuleAnalysis(ctx: Context, config: AnalysisConfig,
  analyze: AnalyzeModule = createModuleAnalyzer(ctx, config)): AnalyzeModule {
  const tool: ToolDefinition = {
    name: 'analyze_kicad_module',
    description: 'Query components, electrical nets, grouped BOM or summary from local/downloaded KiCad schematics. Status describes the requested view: ready with empty items means no match; unavailable means extraction failed. Components/nets share netlist extraction; BOM also reads netlist properties to preserve procurement identity. Results and failed stages are cached; refresh:true retries only required exports. Summary is an overview, not an implicit retry. Filter by reference/pin or exact net; follow nextOffset. Nets return all peers in 32-node chunks. Component fields require reference. fieldsTruncated marks shortened custom fields; files preserves full records. Omitted assembly flags=false, but omitted bomIncluded means unknown; explicit true/false means confirmed BOM membership. Errors require code/message; executable is only for launch/path failures and nextAction only for specific recovery. Fix failures then use refresh:true. CLI/project resolved internally. Default variant, no ERC.',
    parameters: {type: 'object', additionalProperties: false, properties: {
      schematicPath: {type: 'string'},
      kicadCliPath: {type: 'string', description: 'Recovery only: absolute kicad-cli path from get_eda_host_info installation.executables. Repeat the original query with refresh:true without downloading again; successful path is reused.'},
      refresh: {type:'boolean',description:'Default false: reuse cached successes and failures. True: retry only the exports needed by this view and reprobe CLI capabilities.'},
      view: {type: 'string', enum: ['summary', 'components', 'nets', 'bom']},
      reference: {type: 'string'}, pin: {type: 'string', description: 'Pin number; requires reference and view:nets.'},
      net: {type: 'string', description: 'Exact exported net name; view:nets only.'}, offset: {type: 'integer'},
    }, required: ['schematicPath', 'view']},
    output: {schema: {type: 'object', additionalProperties: false, properties: {
      status: {type: 'string', enum: ['ready', 'partial', 'unavailable']},
      items: {type: 'array', items: {type: 'object'}}, nextOffset: {type: 'integer'},
      counts: {type: 'object'}, files: {type: 'object'},
      warnings: {type: 'array', items: {type: 'string'}},
      error: {type: 'object', additionalProperties: false, properties: {code: {type: 'string'}, executable: {type: 'string'}, message:{type:'string'},nextAction:{type:'string'}}, required: ['code','message']},
    }, required: ['status']}, render: (_args, result) => [{type: 'text', text: JSON.stringify(result)}]},
    async execute(args, exec) {
      const input = validateKeys(args, ['schematicPath', 'view', 'reference', 'pin', 'net', 'offset', 'kicadCliPath','refresh'], 'analyze_kicad_module')
      const path = requiredString(input, 'schematicPath')
      const optional = (key: string) => input[key] === undefined ? undefined : requiredString(input, key)
      const view = requiredString(input, 'view'), reference = optional('reference'), pin = optional('pin'), net = optional('net')
      const kicadCliPath = optional('kicadCliPath')
      if(input.refresh!==undefined && typeof input.refresh!=='boolean')throw new Error('refresh must be boolean')
      if (kicadCliPath && (!isAbsolute(kicadCliPath) || !/^kicad-cli(?:\.exe)?$/i.test(basename(kicadCliPath)))) {
        throw new Error('kicadCliPath must be an absolute kicad-cli executable path from get_eda_host_info')
      }
      if (!['summary', 'components', 'nets', 'bom'].includes(String(view))) throw new Error('view must be summary, components, nets or bom')
      if (pin && (!reference || view !== 'nets')) throw new Error('pin requires reference and view:nets')
      if (net && view !== 'nets') throw new Error('net applies only to view:nets')
      if (reference && view === 'summary') throw new Error('reference requires components, nets or bom view')
      const offset = input.offset ?? 0
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
      if (view === 'summary' && offset !== 0) throw new Error('offset applies only to detail views')
      const {analysis,data} = await analyze(path,exec,{view:view as AnalysisView,refresh:input.refresh===true,
        ...(kicadCliPath?{kicadCliPath}:{})})
      // Completeness of unrelated exports must not turn a successful detail query partial.
      const available = view==='components'?data?.components!==null&&data?.components!==undefined
        :view==='nets'?data?.nets!==null&&data?.nets!==undefined
        :view==='bom'?data?.bomAvailable===true:false
      const status = view==='summary'?analysis.status:!available?'unavailable'
        :view==='components'&&data?.inventoryScope==='bom_only'?'partial':'ready'
      const warnings: string[]=[]
      if(data?.inventoryScope==='bom_only' && view!=='nets')warnings.push('BOM-only inventory may omit excluded symbols and custom fields; grouping reflects available fields.')
      const relevant = view==='summary'?['netlist','bom']:view==='bom'?['bom']:['netlist']
      const failedStage = relevant.find(stage=>analysis.stages?.[stage as 'netlist'|'bom']?.status==='failed')
      const stageDiagnostic = failedStage?analysis.stages?.[failedStage as 'netlist'|'bom']?.diagnostic:undefined
      const diagnostic = stageDiagnostic ?? analysis.diagnostics[0]
      const launchFailure = analysis.failure?.code==='CLI_START_FAILED'
        || /\b(?:ENOENT|EACCES|EPERM|ENOEXEC)\b/.test(diagnostic??'')
      // Generic retry guidance lives in the tool description; repeat only actionable recovery.
      const nextAction = analysis.failure?.code==='CLI_START_FAILED' || analysis.failure?.code==='CLI_CAPABILITY_UNSUPPORTED' ? analysis.nextAction.trim()
        : analysis.failure?.code==='CLI_PROBE_TIMEOUT' ? 'Check that KiCad CLI export help completes within the configured timeout, then retry this query with refresh:true.'
        : launchFailure ? 'Reuse the host kicad-cli absolute path as kicadCliPath and retry this query with refresh:true.'
        : stageDiagnostic?.includes('does not support')
          ? `Use a KiCad CLI supporting the required ${failedStage} export options, then retry this query with refresh:true.`
          : undefined
      const error = status==='ready'?undefined:analysis.failure || failedStage || status==='unavailable'?{
        code:analysis.failure?.code??(failedStage?`${failedStage.toUpperCase()}_EXPORT_FAILED`:'ANALYSIS_DATA_UNAVAILABLE'),
        message:(diagnostic||`${view} data unavailable; empty items do not mean no matching circuit data.`).slice(0,400),
        ...(launchFailure?{executable:analysis.failure?.executable??analysis.executable??kicadCliPath??config.kicadCliPath}:{}),
        ...(nextAction?{nextAction}:{}),
      }:undefined
      const common={status,...(warnings.length?{warnings}:{}),...(error?{error}: {})}
      if(view==='summary')return {...common,counts:analysis.counts??{},
        ...(status!=='ready'&&analysis.files?{files:analysis.files}:{})}
      const page=pageAnalysisItems(available&&data?queryAnalysisItems(data,view,reference,pin,net):[],offset)
      const shortened=page.items.some(item=>'omitted' in item || 'fieldsTruncated' in item)
      return {...common,items:page.items,...(page.nextOffset===null?{}:{nextOffset:page.nextOffset}),
        ...((shortened||error)&&analysis.files?{files:analysis.files}:{})}

    },
    presentCall: args => ({card: 'generic', title: 'Analyze KiCad module circuit', kind: 'read', rawInput: args}),
  }
  ctx.effect(() => ctx.tools.register(tool))
  return analyze
}
