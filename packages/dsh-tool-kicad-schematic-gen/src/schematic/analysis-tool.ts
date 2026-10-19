/** Bounded queries over KiCad-exported module data; also supplies the download postprocessor. */
import type {Context} from '@deepseek-ai/cordis'
import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import {basename, isAbsolute} from 'node:path'
import {createModuleAnalyzer, type AnalysisConfig, type AnalyzeModule, type AnalysisData, type AnalysisComponent} from './module-analysis.ts'
import {requiredString, validateKeys} from './input.ts'

/** Bound both item count and serialized text; never silently truncate a connection record. */
export function pageAnalysisItems(items: object[], offset: number) {
  const page: object[] = []; let chars = 0, next = offset
  for (const item of items.slice(offset, offset + 60)) {
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

/** Compact defaults: omitted flags are false; unknown BOM membership remains explicit null. */
function componentItem(c: AnalysisComponent, detail: boolean) {
  return {reference: c.reference, ...(c.value === null ? {} : {value: c.value}),
    ...(c.footprint === null ? {} : {footprint: c.footprint}),
    ...(c.dnp ? {dnp: true} : {}), ...(c.excludeFromBom ? {excludeFromBom: true} : {}),
    ...(c.excludeFromBoard ? {excludeFromBoard: true} : {}), bomIncluded: c.bomIncluded ?? null,
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
    description: 'Primary circuit query for design planning: components, BOM and electrical nets in downloaded or local KiCad circuits. Downloads already return summary; request only needed detail and reuse results. Do not duplicate nets with flat-editor wire queries; use that tool only for missing drawing notes or implementation geometry. Filter by reference/pin or exact net; follow nextOffset. Nets contain all peers, chunked with nodeOffset/totalNodes when large. Components include custom fields only with reference. Omitted flags=false; bomIncluded:null means unknown. Detail queries reuse partial data; summary retries failed analysis after fixing configuration. CLI/project resolved internally. Default variant, no ERC.',
    parameters: {type: 'object', additionalProperties: false, properties: {
      schematicPath: {type: 'string'},
      kicadCliPath: {type: 'string', description: 'Recovery only: absolute kicad-cli path from get_eda_host_info installation.executables. Retry view:summary without downloading again; successful path is reused.'},
      view: {type: 'string', enum: ['summary', 'components', 'nets', 'bom']},
      reference: {type: 'string'}, pin: {type: 'string', description: 'Pin number; requires reference and view:nets.'},
      net: {type: 'string', description: 'Exact exported net name; view:nets only.'}, offset: {type: 'integer'},
    }, required: ['schematicPath', 'view']},
    output: {schema: {type: 'object', additionalProperties: false, properties: {
      status: {type: 'string', enum: ['ready', 'partial', 'unavailable']},
      items: {type: 'array', items: {type: 'object'}}, nextOffset: {type: 'integer'},
      counts: {type: 'object'}, inventoryScope: {type: 'string'}, files: {type: 'object'},
      warnings: {type: 'array', items: {type: 'string'}},
      error: {type: 'object', additionalProperties: false, properties: {code: {type: 'string'}, executable: {type: 'string'}}, required: ['code', 'executable']},
    }, required: ['status']}, render: (_args, result) => [{type: 'text', text: JSON.stringify(result)}]},
    async execute(args, exec) {
      const input = validateKeys(args, ['schematicPath', 'view', 'reference', 'pin', 'net', 'offset', 'kicadCliPath'], 'analyze_kicad_module')
      const path = requiredString(input, 'schematicPath')
      const optional = (key: string) => input[key] === undefined ? undefined : requiredString(input, key)
      const view = requiredString(input, 'view'), reference = optional('reference'), pin = optional('pin'), net = optional('net')
      const kicadCliPath = optional('kicadCliPath')
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
      const result = await analyze(path, exec, {reusePartial: view !== 'summary' && !kicadCliPath,
        ...(kicadCliPath ? {kicadCliPath} : {})})
      const {analysis, data} = result
      const warnings: string[] = []
      if (analysis.status !== 'ready') {
        warnings.push(...analysis.diagnostics.slice(0, 3).map(d => d.slice(0, 400)))
        warnings.push(analysis.failure ? analysis.nextAction : 'Partial/unavailable data; fix configuration then use view:summary to retry.')
      }
      if (analysis.inventoryScope === 'bom_only') warnings.push('BOM-only inventory may omit excluded symbols.')
      if (view === 'nets' && !data?.nets) warnings.push('Network data unavailable; empty items do not mean no connections.')
      if (view === 'bom' && !data?.bomAvailable) warnings.push('BOM unavailable; empty items do not mean an empty BOM.')
      if (view === 'components' && !data?.components) warnings.push('Component data unavailable; empty items do not mean no components.')
      const common = {status: analysis.status, ...(warnings.length ? {warnings} : {}),
        ...(analysis.failure ? {error: analysis.failure} : {})}
      if (view === 'summary') return {...common, counts: analysis.counts ?? {},
        ...(analysis.inventoryScope ? {inventoryScope: analysis.inventoryScope} : {}),
        ...(analysis.status !== 'ready' && analysis.files ? {files: analysis.files} : {})}
      const page = pageAnalysisItems(data ? queryAnalysisItems(data, view, reference, pin, net) : [], offset)
      return {...common, items: page.items, ...(page.nextOffset === null ? {} : {nextOffset: page.nextOffset}),
        ...(page.items.some(item => 'omitted' in item) && analysis.files ? {files: analysis.files} : {})}
    },
    presentCall: args => ({card: 'generic', title: 'Analyze KiCad module circuit', kind: 'read', rawInput: args}),
  }
  ctx.effect(() => ctx.tools.register(tool))
  return analyze
}
