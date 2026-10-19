/** One installable plugin for module-first KiCad schematic design. */
import type {Context} from '@deepseek-ai/cordis'
import {resolveConfig,type ConfigInput} from './config.ts'
import {apply as registerComponents} from './components/index.ts'
import {registerModules} from './modules/register.ts'
import {apply as registerSchematic} from './schematic/index.ts'
import {apply as registerSkills} from './skills.ts'
import {registerModuleAnalysis} from './schematic/analysis-tool.ts'

export {Config,resolveConfig} from './config.ts'
export const name='@local/dsh-tool-kicad-schematic-gen'
export const inject=['tools','fs','sandboxPolicy','skills','webServer'] as const

export function apply(ctx:Context, input:ConfigInput={}):void {
  const config=resolveConfig(input)
  const analyze = registerModuleAnalysis(ctx, config.schematic)
  registerComponents(ctx,config.components)
  registerModules(ctx,config.modules,analyze)
  registerSchematic(ctx,config.schematic)
  registerSkills(ctx,config.schematic.kicadCliPath)
}
