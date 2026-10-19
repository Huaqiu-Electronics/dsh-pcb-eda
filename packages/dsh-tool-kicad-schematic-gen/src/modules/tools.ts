/** Three read-only HQ EDA catalog searches for DeepSeek Harness agents. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { searchModules, validateSearchOptions, type SearchOptions } from './search.ts'

export const name = 'hq-eda-module-library'
export const inject = ['tools']

/** Search service origin and per-call resource limits. */
export type Config = SearchOptions

export const Config: Schema<Config> = Schema.object({
  apiBaseUrl: Schema.string().required(),
  requestTimeoutMs: Schema.number().required(),
  maxResults: Schema.number().required(),
  maxResponseBytes: Schema.number().required(),
})

const resultSchema: ToolDefinition['output']['schema'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer' },
    pageNumber: { type: 'integer' },
    hits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          shortDescription: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'name', 'shortDescription', 'categories'],
      },
    },
  },
  required: ['total', 'pageNumber', 'hits'],
}

function fields(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('module search arguments must be an object')
  }
  const input = args as Record<string, unknown>
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new Error(`module search accepts only ${allowed.join(', ')}`)
  }
  return input
}

function term(value: unknown, field: string, required: true): string
function term(value: unknown, field: string, required: false): string | undefined
function term(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new Error(`${field} must contain 1 to 200 characters`)
  }
  return trimmed
}

/** Register three independent tools, each backed by one catalog endpoint. */
export function apply(ctx: { tools: Pick<Context['tools'], 'register'> }, config: Config): void {
  validateSearchOptions(config)

  const rag: ToolDefinition = {
    name: 'eda_module_rag_search',
    description: 'Find HQ EDA electronic modules by function or natural-language requirements. Use this for broad or fuzzy requirements; results are catalog candidates, not verified circuit choices.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { query: { type: 'string', description: 'Module function, name, or technical requirements to search.' } },
      required: ['query'],
    },
    output: { schema: resultSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = fields(args, ['query'])
      return searchModules('rag', { query: term(input.query, 'query', true) }, config, exec.signal)
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: 'Search EDA modules by meaning', kind: 'search', rawInput: args }),
  }

  const category: ToolDefinition = {
    name: 'eda_module_category_search',
    description: 'Browse HQ EDA electronic modules in a known catalog category. Use a category label from previous search results; only the first page is returned.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { category: { type: 'string', description: 'Exact catalog category label to browse.' } },
      required: ['category'],
    },
    output: { schema: resultSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = fields(args, ['category'])
      return searchModules('category', { category: term(input.category, 'category', true) }, config, exec.signal)
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: 'Browse EDA module category', kind: 'search', rawInput: args }),
  }

  const precise: ToolDefinition = {
    name: 'eda_module_precise_search',
    description: 'Find HQ EDA electronic modules by model number or keyword, optionally narrowing to one catalog category. Provide a keyword, category, or both; only the first page is returned.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: 'Known model number or keyword matching a module name or description.' },
        category: { type: 'string', description: 'Optional exact catalog category label.' },
      },
    },
    output: { schema: resultSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = fields(args, ['keyword', 'category'])
      const keyword = term(input.keyword, 'keyword', false)
      const categoryName = term(input.category, 'category', false)
      if (!keyword && !categoryName) throw new Error('eda_module_precise_search requires keyword or category')
      return searchModules('precise', {
        keyword: keyword ?? '',
        ...(categoryName ? { category: categoryName } : {}),
      }, config, exec.signal)
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: 'Search EDA modules precisely', kind: 'search', rawInput: args }),
  }

  ctx.tools.register(rag)
  ctx.tools.register(category)
  ctx.tools.register(precise)
}
