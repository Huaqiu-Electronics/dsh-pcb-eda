import Schema from '@deepseek-ai/schemastery'
import {fileURLToPath} from 'node:url'
import {getKiCadPaths} from './runtime-paths.ts'
import {Config as ComponentsConfig} from './components/config.ts'
import {Config as ModulesConfig} from './modules/config.ts'
import {Config as SchematicConfig} from './schematic/config.ts'

export interface Config {
  components: ComponentsConfig
  modules: ModulesConfig
  schematic: SchematicConfig
}

const defaults: Config = {
  components: {
    requestTimeoutMs:15000,maxModelBytes:1000000,
    structuredApiBaseUrl:'https://task.eda.cn/prod-api/outside/datasheet/v1/components/',
    datasheetRequestTimeoutMs:30000,maxPdfBytes:12000000,maxPdfPages:12,
    maxTextChars:12000,maxImages:5,allowedPdfHosts:['file.elecfans.com','file1.elecfans.com'],
  },
  modules: {
    search:{apiBaseUrl:'https://gen.eda.cn',requestTimeoutMs:30000,maxResults:10,maxResponseBytes:1000000},
    download:{apiBaseUrl:'https://www.eda.cn',requestTimeoutMs:30000,maxDetailBytes:2000000,
      maxZipBytes:20000000,maxSchematicBytes:10000000,maxProjectBytes:10000000,maxArchiveEntries:512},
  },
  schematic:{maxSchematicBytes:10000000,kicadCliPath:'kicad-cli',
    previewDensity:288,previewMaxWidth:2400,previewMaxPages:4,previewPadding:32,previewTimeoutMs:30000,
    previewTrimThreshold:10,flatListLimit:120,
    flatTemplateDir:fileURLToPath(new URL('../skills/kicad-schematic-design/templates/',import.meta.url))},
}

export const Config: Schema<Config> = Schema.object({
  components:ComponentsConfig.default(defaults.components),
  modules:ModulesConfig.default(defaults.modules),
  schematic:SchematicConfig.default(defaults.schematic),
})

export interface ConfigInput {
  components?: Partial<ComponentsConfig>
  modules?: {search?:Partial<ModulesConfig['search']>;download?:Partial<ModulesConfig['download']>}
  schematic?: Partial<SchematicConfig>
}

export function resolveConfig(input: ConfigInput = {}): Config {
  return Config({
    components:{...defaults.components,...input.components},
    modules:{search:{...defaults.modules.search,...input.modules?.search},
      download:{...defaults.modules.download,...input.modules?.download}},
    schematic:{...defaults.schematic,...input.schematic,kicadCliPath:getKiCadPaths(input.schematic?.kicadCliPath).kicadCliPath},
  })
}
