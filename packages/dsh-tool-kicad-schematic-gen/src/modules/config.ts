import Schema from '@deepseek-ai/schemastery'
import { Config as SearchConfig, type Config as SearchOptions } from './tools.ts'
import { Config as DownloadConfig, type Config as DownloadOptions } from './kicad-download.ts'

export interface Config {
  search: SearchOptions
  download: DownloadOptions
}

export const Config: Schema<Config> = Schema.object({
  search: SearchConfig.required(),
  download: DownloadConfig.required(),
})
