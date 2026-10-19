import Schema from '@deepseek-ai/schemastery'

/** Deployment-selected file limits, KiCad executable, rendering settings, and flat templates. */
export interface Config {
  maxSchematicBytes: number
  kicadCliPath: string
  previewDensity: number
  previewMaxWidth: number
  previewMaxPages: number
  previewPadding: number
  previewTimeoutMs: number
  previewTrimThreshold: number
  flatTemplateDir: string
  flatListLimit: number
}
export const Config: Schema<Config> = Schema.object({
  maxSchematicBytes: Schema.number().required(),
  kicadCliPath: Schema.string().required(),
  previewDensity: Schema.number().required(),
  previewMaxWidth: Schema.number().required(),
  previewMaxPages: Schema.number().required(),
  previewPadding: Schema.number().required(),
  previewTimeoutMs: Schema.number().required(),
  previewTrimThreshold: Schema.number().required(),
  flatTemplateDir: Schema.string().required(),
  flatListLimit: Schema.number().required(),
})

