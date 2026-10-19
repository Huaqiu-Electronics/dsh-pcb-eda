/** Read exact-part metadata from the same client used by dsh-tool-part-search. */
import { createPartSearchService, type EdaModels } from '@huaqiu/part-search'

export interface SourceOptions { requestTimeoutMs: number }

export function componentSource(options: SourceOptions, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  return createPartSearchService({
    timeoutMs: options.requestTimeoutMs,
    fetch: (input, init) => fetcher(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    }),
  })
}

/** Optional models stay optional; URL presence is checked independently of search flags. */
export async function getModelUrls(mfgId: string, mpn: string, options: SourceOptions,
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{symbol: URL | null; footprint: URL | null}> {
  const models: EdaModels = await componentSource(options, signal, fetcher)
    .getEdaModels({ manufacturerId: mfgId, mpn })
  const read = (kind: 'symbol' | 'footprint'): URL | null => {
    const model = models[kind]
    if (!model) return null
    const url = new URL(model.url)
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`Huaqiu ${kind} URL must use HTTPS without credentials`)
    }
    return url
  }
  return {symbol: read('symbol'), footprint: read('footprint')}
}
