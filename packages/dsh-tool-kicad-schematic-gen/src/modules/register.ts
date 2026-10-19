import type {Context} from '@deepseek-ai/cordis'
import type {Config} from './config.ts'
import {apply as registerSearch} from './tools.ts'
import {apply as registerDownload} from './download-core/index.ts'
import {adaptTool,type HqEdge} from './kicad-download.ts'
import type {AnalyzeModule} from '../schematic/module-analysis.ts'

/** Search works without a live host; downloads resolve the current host at execution time. */
export function registerModules(ctx:Context, config:Config, analyze?:AnalyzeModule):void {
  registerSearch({tools:{register:tool=>ctx.effect(()=>ctx.tools.register(tool))}},config.search)
  registerDownload({
    effect:callback=>ctx.effect(callback),fs:ctx.fs,sandboxPolicy:ctx.sandboxPolicy,
    tools:{register:tool=>ctx.tools.register(adaptTool(tool,()=>ctx.get('hqEdge') as HqEdge|undefined,analyze))},
  },config.download)
}
