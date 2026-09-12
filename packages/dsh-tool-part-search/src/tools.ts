/**
 * The four Huaqiu part-search DSH tools — the DSH tool adapter layer.
 *
 * This module is a **pure adapter**: every tool reads validated arguments,
 * calls one `PartSearchServiceLike` operation (see `service.ts`), and returns
 * the normalized domain model as its canonical JSON value. It never touches the
 * wire protocol, `@huaqiu/part-search` internals, or any DSH host service.
 *
 * The agent-facing contracts (names, descriptions, snake_case parameters) are
 * preserved verbatim from the original HQ Edge plugin so existing agent
 * behaviors keep working after the migration.
 *
 * Error model: `PartSearchError` subclasses thrown by the service propagate to
 * the DSH tool runtime, which surfaces the message to the model as a tool
 * failure (same observable contract as the old HQ Edge proxy, which threw on
 * upstream failure).
 *
 * @module @huaqiu/dsh-tool-part-search/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PartIdentifier } from '@huaqiu/part-search'
import type { PartSearchServiceLike } from './service.js'

/**
 * Structural alias of the DSH `JsonValue` (dsh-session). Kept local so the
 * plugin does not need `@deepseek-ai/dsh-session` as a direct dependency for
 * a type only; the alias is structurally identical to `JsonValue`, which is
 * what `defineTool`'s `{ type: 'json' }` output infers.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Per-tool cooperative execution budget (ms). The upstream may be a fresh
 *  fetch (~15s); give headroom so `exec.signal` aborts gracefully. */
const TOOL_TIMEOUT_MS = 30_000

/** Deterministic model content for every canonical part-search value. The value
 *  is already the normalized domain model from `@huaqiu/part-search`. */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/**
 * The normalized domain model is plain JSON **except** that optional fields
 * are present as `undefined`, which is not lossless JSON and fails the DSH
 * runtime's canonical-value validation. The JSON round-trip strips
 * `undefined` properties (and array holes → null) so the canonical value is
 * always valid lossless JSON.
 */
function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/** The language param shared by detail / models lookups. */
const LANGUAGE_PARAM = {
  type: 'string',
  enum: ['en', 'zh'],
  description: 'Response language. Default "zh".',
} as const

/**
 * Build the four part-search tool definitions.
 *
 * @param service - the Huaqiu part-search service the tools call. Pass the
 *   shared instance from `index.ts` (or a stub in tests).
 * @returns the four registry-ready tool definitions.
 */
export function createPartSearchTools(service: PartSearchServiceLike) {
  return [
    defineTool({
      name: 'search_hqsch_parts',
      description:
        'Search electronic components / ICs / PCB parts by keyword through HQSCH (Huaqiu EDA). ' +
        'Returns candidate parts with MPN, manufacturer, package, description, and EDA-model ' +
        'availability flags. Use this when the user asks for part selection, component lookup, ' +
        'finding ICs, resistors, capacitors, or any electronic parts suitable for EDA/PCB design. ' +
        'By default only parts with available EDA models (schematic symbol / PCB footprint) are ' +
        'returned. Progressive retrieval is recommended: search_hqsch_parts → get_hqsch_part → ' +
        'get_hqsch_part_models / get_hqsch_supply_chain.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description:
            'Search keyword: a partial MPN (e.g. "STM32F103"), a description ' +
            '("32-bit microcontroller 72MHz"), or a combined value ("0402 10k resistor"). ' +
            'Max 200 characters. Matching is fuzzy — related models may appear.',
        },
        page: {
          type: 'integer',
          description: '1-based page index. Default 1.',
        },
        page_size: {
          type: 'integer',
          description: 'Page size, 1-50. Default 10.',
        },
        require_eda_model: {
          type: 'boolean',
          description:
            'When true (default), only return parts that have any EDA model. ' +
            'Set false to search across all parts (e.g. for research).',
        },
        requirements: {
          type: 'object',
          additionalProperties: false,
          description:
            'Fine-grained model requirements. All optional booleans: ' +
            '{ symbol, footprint, model3d, simulation, supplier }.',
          properties: {
            symbol: { type: 'boolean', description: 'Require a schematic symbol.' },
            footprint: { type: 'boolean', description: 'Require a PCB footprint.' },
            model3d: { type: 'boolean', description: 'Require a 3D model.' },
            simulation: { type: 'boolean', description: 'Require a simulation model.' },
            supplier: { type: 'boolean', description: 'Require supplier/stock data.' },
          },
        },
        language: LANGUAGE_PARAM,
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args) {
        const page = await service.searchParts({
          query: args.query,
          page: args.page,
          pageSize: args.page_size,
          requireEdaModel: args.require_eda_model,
          requirements: args.requirements,
          language: args.language,
        })
        return asJson(page)
      },
    }),

    defineTool({
      name: 'get_hqsch_part',
      description:
        'Get the canonical detailed part from HQSCH (Huaqiu EDA) by manufacturer id + MPN. ' +
        'Returns attributes, categories, documents (datasheets), images, EDA-model metadata ' +
        '(symbol/footprint/3D/simulation URLs), and tags. Use this after ' +
        'search_hqsch_parts to inspect a specific candidate. The part MUST be identified by ' +
        'both manufacturerId and mpn — partial identifiers are not accepted.',
      parameters: {
        manufacturer_id: {
          type: 'string',
          required: true,
          description: 'Huaqiu manufacturer id (e.g. "7189" for STMicroelectronics).',
        },
        mpn: {
          type: 'string',
          required: true,
          description: 'Manufacturer part number (e.g. "STM32F410T8Y6TR").',
        },
        language: LANGUAGE_PARAM,
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args) {
        const identifier = toPartIdentifier(args)
        return asJson(await service.getPart(identifier, args.language))
      },
    }),

    defineTool({
      name: 'get_hqsch_part_models',
      description:
        'Get EDA model metadata (schematic symbol / PCB footprint / 3D / simulation) for a ' +
        'HQSCH (Huaqiu EDA) part by manufacturer id + MPN. Returns URLs and format hints — ' +
        'does NOT download the model files. Use this when you need to know which models exist ' +
        'and where to fetch them, without retrieving the full part detail.',
      parameters: {
        manufacturer_id: {
          type: 'string',
          required: true,
          description: 'Huaqiu manufacturer id (e.g. "7189" for STMicroelectronics).',
        },
        mpn: {
          type: 'string',
          required: true,
          description: 'Manufacturer part number (e.g. "STM32F410T8Y6TR").',
        },
        language: LANGUAGE_PARAM,
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args) {
        const identifier = toPartIdentifier(args)
        return asJson(await service.getEdaModels(identifier, args.language))
      },
    }),

    defineTool({
      name: 'get_hqsch_supply_chain',
      description:
        'Get supply-chain offers (vendor, stock, MOQ, lead time, price breaks, distributor ' +
        'URL) for one or more HQSCH (Huaqiu EDA) parts by manufacturer id + MPN. Batched ' +
        'lookup is supported — pass an array of parts. Use this AFTER identifying a specific ' +
        'part via search_hqsch_parts / get_hqsch_part, when procurement or availability ' +
        'information is needed.',
      parameters: {
        parts: {
          type: 'array',
          required: true,
          description: 'Array of parts to look up supply-chain offers for.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              manufacturer_id: { type: 'string', required: true },
              mpn: { type: 'string', required: true },
            },
          },
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      timeoutMs: TOOL_TIMEOUT_MS,
      async execute(args) {
        const parts = args.parts.map(toPartIdentifier)
        return asJson(await service.getSupplyChain(parts))
      },
    }),
  ]
}

/** Narrow the shared `manufacturer_id` + `mpn` args into a PartIdentifier. */
function toPartIdentifier(args: { manufacturer_id: string; mpn: string }): PartIdentifier {
  return { manufacturerId: args.manufacturer_id, mpn: args.mpn }
}
