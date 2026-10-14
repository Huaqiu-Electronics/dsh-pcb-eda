/**
 * Agent tools for `@huaqiu/dsh-tool-quote`.
 *
 *   quote_pcb   real-time PCB fabrication price for the requested region
 *   quote_smt   real-time SMT assembly price (single-side / double-side)
 *
 * The tools are pure pass-throughs: they read validated arguments, build the
 * canonical quote request (matching hq.fab.v1.QuoteService / the hq-edge
 * router contract), call hq-edge via the client, and return the normalized
 * QuotePrice as lossless JSON. Errors carry a semantic `kind`
 * (FAILED_PRECONDITION / VALIDATION / UNIMPLEMENTED / UPSTREAM_REJECTED /
 * DEADLINE_EXCEEDED / INTERNAL) — the agent sees why a quote failed, not a
 * bare HTTP status.
 *
 * Note on enums: only the enumerated choices are accepted, mirroring the
 * proto/type definitions on hq-edge. Unknown fields are rejected upstream
 * (Zod .strict()), so the tools never send unsupported keys.
 *
 * @module
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { QuoteToolClient } from './client.js'

/** Structural alias of the DSH `JsonValue`. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

/** Tool execution context (structural view of DSH's ToolRunContext). */
interface ToolExecLike {
  signal?: AbortSignal
  callId?: string
}

interface QuoteToolEnv {
  client: QuoteToolClient
}

/** Pick the EDA derivation flags (only when explicitly true). */
function edaOf(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const eda: Record<string, unknown> = {}
  if (args.derive_board_size === true) eda.deriveBoardSize = true
  if (args.derive_board_stackup === true) eda.deriveBoardStackup = true
  return Object.keys(eda).length > 0 ? eda : undefined
}

export function createQuoteTools(env: QuoteToolEnv) {
  const { client } = env

  /** Build the canonical PCB form from the flat tool args. */
  const pcbFormOf = (a: Record<string, unknown>): Record<string, unknown> | undefined => {
    const form: Record<string, unknown> = {}
    if (a.bcount !== undefined) form.bcount = a.bcount
    if (a.blayer !== undefined) form.blayer = a.blayer
    if (a.blength !== undefined) form.blength = a.blength
    if (a.bwidth !== undefined) form.bwidth = a.bwidth
    if (a.board_tg !== undefined) form.boardTg = a.board_tg
    if (a.color !== undefined) form.color = a.color
    if (a.cover !== undefined) form.cover = a.cover
    if (a.spray !== undefined) form.spray = a.spray
    return Object.keys(form).length > 0 ? form : undefined
  }

  /** Optional EDA-host derivation flags shared by both tools. */
  const edaFlagProps = {
    derive_board_size: {
      type: 'boolean' as const,
      description:
        'When true, ask hq-edge to derive board length/width from the current PCB board ' +
        '(approximate bounding box of footprints; only when a board is open in the host).',
    },
    derive_board_stackup: {
      type: 'boolean' as const,
      description:
        'NOT SUPPORTED (explicit capability gap): hq-edge has no board-properties source, ' +
        'so stack-up is never derived or fabricated. Provide blayer/bheight explicitly instead.',
    },
    include_raw_response: {
      type: 'boolean' as const,
      description: 'Include the bounded raw upstream payload for diagnostics (default false).',
    },
  }

  return [
    defineTool({
      name: 'quote_pcb',
      description:
        'Get a real-time PCB fabrication price quote (multi-layer, panel pricing, delivery options) ' +
        'for the requested region through Huaqiu/NextPCB. Use when the user asks how much a PCB ' +
        'would cost, "报价", "价格", delivery time estimates, or comparing fab options. ' +
        'Returns the itemized price breakdown, total price, and delivery alternatives ' +
        '(name + build time in days + total price) with currency symbol (¥ CN / ￥ intl). ' +
        'When derive_board_size / derive_board_stackup is set, the response also carries the ' +
        'effective quote form: EDA-extracted board facts (length/width from the board outline, ' +
        'layer count + thickness from the stack-up in KiCad) merged with the caller overrides — ' +
        'plus server defaults applied on the wire (e.g. bcount default 5, endpoint-required ' +
        'pbnum=1 / insidecopper). Inspect "form" in the result, adjust any parameter the user ' +
        'wants to change (e.g. color, blayer, board_tg), and re-query with the corrected form ' +
        'rather than guessing values. Progressive usage: quote_pcb for PCB fabrication, quote_smt ' +
        'for assembly, then the user places the order in the EDA host. This is a quote-only ' +
        'query — no order is created. All regions are anonymous-queryable (no login required). ' +
        'The pricing region is auto-detected by hq-edge from the trusted request context (CN / JP / ' +
        'INTERNATIONAL) — do NOT force a region unless the user explicitly asks for one.',
      parameters: {
        region: {
          type: 'string',
          enum: ['cn', 'eu_us', 'jp'],
          description:
            'Optional explicit override. When omitted, hq-edge auto-detects the pricing region from ' +
            'the trusted request context (CN / JP / INTERNATIONAL). "cn" = Huaqiu China (eda.cn, ¥), ' +
            '"eu_us" = NextPCB EU/US, "jp" = NextPCB Japan (both ￥).',
        },
        bcount: {
          type: 'integer',
          description: 'Panel quantity (boards per panel), >= 1. Default 5.',
        },
        blayer: {
          type: 'integer',
          description: 'PCB layer count, 1-64. Default 4.',
        },
        blength: {
          type: 'number',
          description: 'Board length in mm, > 0 (canonical mm; converted to cm on the wire).',
        },
        bwidth: {
          type: 'number',
          description: 'Board width in mm, > 0.',
        },
        board_tg: {
          type: 'string',
          enum: ['tg130', 'tg150', 'tg170'],
          description: 'Glass transition temperature grade (4+ layers only).',
        },
        color: {
          type: 'string',
          enum: ['green', 'red', 'yellow', 'blue', 'white', 'black', 'matte_black'],
          description: 'Solder mask color. Default green.',
        },
        cover: {
          type: 'string',
          enum: ['covered', 'exposed', 'solder_mask_plug', 'non_conductive_fill'],
          description:
            'Via process (tenting / open / solder-mask-plug / non-conductive fill). Default covered.',
        },
        spray: {
          type: 'string',
          enum: ['hasl_lead', 'hasl_lf', 'enig', 'osp'],
          description: 'Surface finish. Default HASL (lead).',
        },
        ...edaFlagProps,
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
        const a = args as Record<string, unknown>
        const payload = {
          region: a.region,
          form: pcbFormOf(a),
          eda: edaOf(a),
          includeRawResponse: a.include_raw_response === true,
        }
        const result = await client.quotePcb(payload, { signal: exec.signal })
        return asJson(result)
      },
    }),
    defineTool({
      name: 'quote_smt',
      description:
        'Get a real-time SMT assembly price quote (single/double side, stencil, X-ray, conformal coating, ' +
        'Huaqiu agent part purchasing) for the requested region through Huaqiu/NextPCB. Use when the user ' +
        'asks about assembly costs, "贴片价格", "SMT 报价", "焊接费用", or delivery time for assembly. ' +
        'Embeds the PCB order (layers/size/quantity) used for the assembly quote. Returns the normalized ' +
        'price with SMT fee detail (no-tax, total, tax) and currency symbol. When derive_board_size / ' +
        'derive_board_stackup is set, the response carries the effective form: EDA-extracted board facts ' +
        '(panel size, embedded PCB length/width/layers/thickness) merged with the caller overrides — ' +
        'inspect "form" and re-query with corrected parameters instead of guessing. Quote-only — no ' +
        'order is created. The pricing region is auto-detected by hq-edge from the trusted request ' +
        'context (CN / JP / INTERNATIONAL) — do NOT force a region unless the user explicitly asks.',
      parameters: {
        region: {
          type: 'string',
          enum: ['cn', 'eu_us', 'jp'],
          description:
            'Optional explicit override. When omitted, hq-edge auto-detects the pricing region from ' +
            'the trusted request context (CN / JP / INTERNATIONAL). "cn" = Huaqiu China (eda.cn, ¥), ' +
            '"eu_us" = NextPCB EU/US, "jp" = NextPCB Japan (both ￥).',
        },
        number: {
          type: 'string',
          description: 'Assembly quantity as string (e.g. "5"). Default "5".',
        },
        buy_bom: {
          type: 'string',
          enum: ['hq_select', 'user_upload', 'online_match'],
          description:
            'BOM parts source: hq_select = Huaqiu agent purchasing (default), ' +
            'user_upload = customer parts, online_match = online parts matching.',
        },
        single_or_double_technique: {
          type: 'string',
          enum: ['single', 'double'],
          description: 'Single-side or double-side assembly. Default double.',
        },
        pcb_blayer: {
          type: 'integer',
          description:
            'Embedded PCB layer count, 1-64 (assembly quote depends on the PCB order). Default 4.',
        },
        pcb_blength: {
          type: 'number',
          description: 'Embedded PCB board length in mm, > 0.',
        },
        pcb_bwidth: {
          type: 'number',
          description: 'Embedded PCB board width in mm, > 0.',
        },
        pcb_bcount: {
          type: 'integer',
          description:
            'Embedded PCB panel quantity, >= 1. Default 5. NOTE: the embedded board size ' +
            '(pcb_blength/pcb_bwidth) is also used as the assembly panel size (panel = single ' +
            'board) when no explicit panel size is given — the Intl SMT endpoint rejects the ' +
            'request otherwise ("pcb_width can not empty", response_code 1003).',
        },
        ...edaFlagProps,
      },
      output: { schema: { type: 'json' }, render: renderJson },      async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
        const a = args as Record<string, unknown>
        const form: Record<string, unknown> = {}
        if (a.number !== undefined) form.number = a.number
        if (a.buy_bom !== undefined) form.buyBom = a.buy_bom
        if (a.single_or_double_technique !== undefined)
          form.singleOrDoubleTechnique = a.single_or_double_technique
        const pcb: Record<string, unknown> = {}
        if (a.pcb_blayer !== undefined) pcb.blayer = a.pcb_blayer
        if (a.pcb_blength !== undefined) pcb.blength = a.pcb_blength
        if (a.pcb_bwidth !== undefined) pcb.bwidth = a.pcb_bwidth
        if (a.pcb_bcount !== undefined) pcb.bcount = a.pcb_bcount
        if (Object.keys(pcb).length > 0) form.pcbOrder = pcb
        const payload = {
          region: a.region,
          form: Object.keys(form).length > 0 ? form : undefined,
          eda: edaOf(a),
          includeRawResponse: a.include_raw_response === true,
        }
        const result = await client.quoteSmt(payload, { signal: exec.signal })
        return asJson(result)
      },
    }),
    defineTool({
      name: 'place_pcb_order',
      description:
        'Trigger the EDA host\'s PCB place-order workflow (KiCad ACTIONS::placeOrderForPCB). ' +
        'The host validates the Huaqiu login (opens its login dialog first if needed), prepares ' +
        'the order artifacts (gerber/drill/bom/zip) from the currently open PCB board, uploads ' +
        'them and opens the place-order page in the editor\'s own dialog. Use when the user asks ' +
        'to "下单", "place order", "提交打样/PCB订单", or after a quote_pcb has been reviewed and the ' +
        'user wants to actually order. Returns { orderUrl, status, message } — status "launched" ' +
        'means the order dialog was opened in the editor; the user completes the order there. ' +
        'NOT a quote — this creates/enters the order flow. Preconditions: a PCB editor with a ' +
        'board open in the EDA host (otherwise FAILED_PRECONDITION), and a logged-in Huaqiu ' +
        'account (the host prompts login itself). The region is auto-detected by hq-edge from the ' +
        'trusted request context — do NOT force a region unless the user explicitly asks.',
      parameters: {
        region: {
          type: 'string',
          enum: ['cn', 'eu_us', 'jp'],
          description:
            'Optional explicit override. When omitted, hq-edge auto-detects the pricing region from ' +
            'the trusted request context (CN / JP / INTERNATIONAL). "cn" = Huaqiu China (eda.cn), ' +
            '"eu_us" = NextPCB EU/US, "jp" = NextPCB Japan.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
        const a = args as Record<string, unknown>
        const payload = { region: a.region }
        const result = await client.placeOrder('pcb', payload, { signal: exec.signal })
        return asJson(result)
      },
    }),
    defineTool({
      name: 'place_smt_order',
      description:
        'Trigger the EDA host\'s SMT assembly place-order workflow (KiCad ACTIONS::placeOrderForSMT). ' +
        'Same flow as place_pcb_order but for assembly: the host validates login, prepares the ' +
        'assembly order artifacts (board zip + BOM + component positions) from the currently open ' +
        'PCB, uploads them and opens the place-order page in the editor\'s own dialog. Use when the ' +
        'user wants to "贴片下单", "SMT 下单", "place SMT order", or after quote_smt has been reviewed. ' +
        'Returns { orderUrl, status, message }. Preconditions: a PCB editor with a board open in the ' +
        'EDA host, and a logged-in Huaqiu account (the host prompts login itself). The region is ' +
        'auto-detected by hq-edge — do NOT force a region unless the user explicitly asks.',
      parameters: {
        region: {
          type: 'string',
          enum: ['cn', 'eu_us', 'jp'],
          description:
            'Optional explicit override. When omitted, hq-edge auto-detects the pricing region from ' +
            'the trusted request context (CN / JP / INTERNATIONAL). "cn" = Huaqiu China (eda.cn), ' +
            '"eu_us" = NextPCB EU/US, "jp" = NextPCB Japan.',
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args: unknown, exec: ToolExecLike): Promise<Json> {
        const a = args as Record<string, unknown>
        const payload = { region: a.region }
        const result = await client.placeOrder('smt', payload, { signal: exec.signal })
        return asJson(result)
      },
    }),
  ]
}
