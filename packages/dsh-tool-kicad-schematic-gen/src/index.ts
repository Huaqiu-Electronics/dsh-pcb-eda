/** One installable plugin for module-first KiCad schematic design. */
import type {Context} from '@deepseek-ai/cordis'
import {getLogger} from '@huaqiu/dsh-plugin-log'
import {resolveConfig,type ConfigInput} from './config.ts'
import {apply as registerComponents} from './components/index.ts'
import {registerModules} from './modules/register.ts'
import {apply as registerSchematic} from './schematic/index.ts'
import {apply as registerSkills} from './skills.ts'
import {getKiCadPaths} from './runtime-paths.ts'
import {registerSchematicGenSection} from './prompt.ts'
import {registerModuleDispatch} from './module-dispatch.ts'

export {Config,resolveConfig} from './config.ts'
export const name='@huaqiu/dsh-tool-kicad-schematic-gen'
export const inject=['tools','fs','sandboxPolicy','skills','webServer','systemPrompt'] as const

/** Shared component name for the unified DSH-plugin log (`~/.hq-edge/logs/dsh-plugins`). */
const log = getLogger('dsh-schematic-gen')

// Emitted at import time: "module loaded" without a following "node half
// ready" means the entry is parked on an unprovided service (or that another
// entry's failure stopped the boot), which is a different problem from a
// failure inside apply().
log.info('schematic-gen: module loaded (waiting for the tools, fs, sandboxPolicy, skills, webServer and systemPrompt services)')

export function apply(ctx:Context, input:ConfigInput={}):void {
  const config=resolveConfig(input)
  // The node half is what registers the client half: if this entry fails to
  // import or to apply, DSH never loads lib/client.js and neither the sidebar
  // row nor the `@` trigger appear. These two lines are what makes that
  // visible in ~/.hq-edge/logs/dsh-plugins/dsh-plugins.log.
  log.info('applying schematic-gen node half',{kicadCliPath:config.schematic.kicadCliPath,
    symbolDir:getKiCadPaths(config.schematic.kicadCliPath).symbolDir??null})
  try {
    registerComponents(ctx,config.components)
    registerModules(ctx,config.modules,config.schematic)
    registerSchematic(ctx,config.schematic)
    registerSkills(ctx,config.schematic.kicadCliPath)
    registerModuleDispatch(ctx,config.schematic.kicadCliPath)
    // The `@schematic-gen` chip serializes to its bare token; this section is
    // what gives that token meaning (see prompt.ts for why it is static).
    const disposeSection = registerSchematicGenSection((ctx as {systemPrompt?:unknown}).systemPrompt)
    if (disposeSection === undefined) {
      log.warn('systemPrompt service unavailable — the huaqiu:schematic-gen section was not registered')
    } else {
      ctx.effect(() => disposeSection)
    }
  } catch (error) {
    log.error('schematic-gen node half failed',{error:String((error as Error)?.message??error)})
    throw error
  }
  log.info('schematic-gen node half ready',{skill:'kicad-schematic-design',
    kicadCliPath:config.schematic.kicadCliPath,
    note:'a missing/unloadable kicad-cli only disables preview and analysis'})
}
