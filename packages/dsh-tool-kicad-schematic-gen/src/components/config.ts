import Schema from '@deepseek-ai/schemastery'
import type { DatasheetOptions } from './datasheet.ts'
import type { ModelOptions } from './models.ts'

/** Deployment-owned endpoints and bounded search, model, and datasheet limits. */
export type Config = ModelOptions & Omit<DatasheetOptions, 'requestTimeoutMs'> & {
  datasheetRequestTimeoutMs: number
}

/** Validate the field types before checking cross-field limits in apply. */
export const Config: Schema<Config> = Schema.object({
  requestTimeoutMs: Schema.number().default(10000),
  maxModelBytes: Schema.number().default(1000000),
  structuredApiBaseUrl: Schema.string().default('https://task.eda.cn/prod-api/outside/datasheet/v1/components/'),
  datasheetRequestTimeoutMs: Schema.number().default(30000),
  maxPdfBytes: Schema.number().default(12000000),
  maxPdfPages: Schema.number().default(12),
  maxTextChars: Schema.number().default(12000),
  maxImages: Schema.number().default(5),
  allowedPdfHosts: Schema.array(Schema.string()).default(['file.elecfans.com', 'file1.elecfans.com']),
})

function positiveInteger(value: number, field: string, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`dsh-tool-kicad-library: ${field} must be an integer from 1 to ${max}`)
  }
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-tool-kicad-library: ${field} must be an integer from ${minimum} to ${maximum}`)
  }
}

/** Validate cross-field limits before registering any tools. */
export function validateConfig(config: Config): void {
  const structured = new URL(config.structuredApiBaseUrl)
  positiveInteger(config.requestTimeoutMs, 'requestTimeoutMs', 60000)
  positiveInteger(config.maxModelBytes, 'maxModelBytes', 10000000)
  if (structured.protocol !== 'https:' || !structured.pathname.endsWith('/')
    || structured.username || structured.password) {
    throw new Error('dsh-tool-kicad-library: structuredApiBaseUrl must be an HTTPS directory URL without credentials')
  }
  boundedInteger(config.datasheetRequestTimeoutMs, 'datasheetRequestTimeoutMs', 1000, 60000)
  boundedInteger(config.maxPdfBytes, 'maxPdfBytes', 100000, 30000000)
  boundedInteger(config.maxPdfPages, 'maxPdfPages', 1, 100)
  boundedInteger(config.maxTextChars, 'maxTextChars', 1000, 30000)
  boundedInteger(config.maxImages, 'maxImages', 0, 20)
  if (!config.allowedPdfHosts.length || config.allowedPdfHosts.some(host =>
    !/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host === 'localhost')) {
    throw new Error('dsh-tool-kicad-library: allowedPdfHosts must list DNS hostnames')
  }
}
