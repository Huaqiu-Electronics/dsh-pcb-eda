/** One bounded, model-facing page of catalog candidates. */
export interface ModuleSearchResult {
  total: number
  pageNumber: number
  hits: {
    id: string
    name: string
    shortDescription: string
    categories: string[]
  }[]
}

/** Deployment settings shared by all three catalog endpoints. */
export interface SearchOptions {
  apiBaseUrl: string
  requestTimeoutMs: number
  maxResults: number
  maxResponseBytes: number
}

export type SearchKind = 'rag' | 'precise' | 'category'

const endpoints: Record<SearchKind, string> = {
  rag: '/api/es/rag_search',
  precise: '/api/es/precise_search',
  category: '/api/es/category_search',
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseSearchResponse(value: unknown, maxResults: number): ModuleSearchResult {
  const body = record(value)
  if (!body || !Number.isSafeInteger(body.total) || (body.total as number) < 0
    || !Number.isSafeInteger(body.page_number) || (body.page_number as number) < 0
    || !Array.isArray(body.hits)) {
    throw new Error('module search: invalid upstream result fields')
  }
  if (body.hits.length > maxResults) {
    throw new Error('module search: upstream returned more than maxResults')
  }
  const hits = body.hits.map((item: unknown) => {
    const source = record(record(item)?.source)
    if (!source || typeof source.id !== 'string' || !source.id.trim()
      || typeof source.name !== 'string' || !source.name.trim()
      || typeof source.short_description !== 'string' || !Array.isArray(source.categories)) {
      throw new Error('module search: invalid upstream module candidate')
    }
    const categories = source.categories.flatMap((item: unknown) => {
      if (typeof item === 'string') return [item]
      const category = record(item)
      if (!category || typeof category.main_category !== 'string'
        || !Array.isArray(category.sub_categories)
        || !category.sub_categories.every((label: unknown) => typeof label === 'string')) {
        throw new Error('module search: invalid upstream category')
      }
      return [category.main_category, ...category.sub_categories as string[]]
    }) as string[]
    return {
      id: source.id,
      name: source.name,
      shortDescription: source.short_description,
      categories,
    }
  })
  return { total: body.total as number, pageNumber: body.page_number as number, hits }
}

/** Validate the deployment URL before any model call can trigger a request. */
export function validateSearchOptions(options: SearchOptions): URL {
  const base = new URL(options.apiBaseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.search || base.hash || base.pathname !== '/') {
    throw new Error('hq-eda-module-library: apiBaseUrl must be an HTTP(S) origin without credentials, path, query, or fragment')
  }
  for (const [field, value, max] of [
    ['requestTimeoutMs', options.requestTimeoutMs, 120000],
    ['maxResults', options.maxResults, 100],
    ['maxResponseBytes', options.maxResponseBytes, 10000000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`hq-eda-module-library: ${field} must be an integer from 1 to ${max}`)
    }
  }
  return base
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('module search: empty upstream response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('module search: upstream response exceeds maxResponseBytes')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
    if (bytes > maxBytes) await response.body.cancel()
  }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown
}

/** Calls a fixed catalog endpoint and rejects HTTP or malformed responses. */
export async function searchModules(
  kind: SearchKind,
  payload: Record<string, unknown>,
  options: SearchOptions,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ModuleSearchResult> {
  const base = validateSearchOptions(options)
  const endpoint = endpoints[kind]
  const response = await fetcher(new URL(endpoint, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      top_k: options.maxResults,
      ...(kind === 'rag' ? {} : { page_number: 1 }),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]),
  })
  if (!response.ok) throw new Error(`module search ${endpoint}: HTTP ${response.status}`)
  return parseSearchResponse(await readBoundedJson(response, options.maxResponseBytes), options.maxResults)
}
