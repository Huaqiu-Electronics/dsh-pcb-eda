/**
 * `@huaqiu/dsh-tool-symbol-footprint` — the three agent-visible tools.
 *
 * Faithful TypeScript port of the `hq-edge` plugin's tool bodies, adapted to
 * the published DSH plugin surface:
 *   - `inject`-provided services: `huaqiuAuth` (token) and `huaqiuArtifacts`
 *     (preview-artifact store) instead of the `hqEdge` bridge twin;
 *   - tools are `defineTool` with `output.schema = { type: 'json' }` and a
 *     structured (lossless-JSON) result — the web client card renders it;
 *   - the human-in-the-loop dimension confirmation is owned by the web client
 *     card (`needs_confirmation` result), the direct-footprint path keeps the
 *     native accept/decline gate.
 *
 * ## Two text channels in a tool result
 *
 * Because `output.schema` is plain JSON, every field of the returned object is
 * visible to the model — but the client card chooses what to render. So:
 *
 *   - `agentNote` — AGENT ONLY. Directives about what to do next: "wait for the
 *     card confirmation, then call X, do not repeat these numbers in your
 *     reply". This is prompt text, not user copy. The card MUST NOT render it;
 *     a user has no way to act on "call generate_footprint_from_dimensions".
 *   - `note` — degradation/status detail that is safe to show a human (the
 *     artifact could not be downloaded, the file was truncated, …).
 *
 * Keeping them apart is what stops a system-prompt-style instruction from
 * leaking into the transcript as if it were a message to the user.
 *
 * Tools:
 *   generate_symbol_from_image          image → KiCad schematic symbol
 *   generate_footprint_from_image       image → dimensions → HUMAN → footprint
 *   generate_footprint_from_dimensions  confirmed dimensions → footprint
 *
 * @module @huaqiu/dsh-tool-symbol-footprint
 */
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { HuaqiuAuthService } from '@huaqiu/dsh-auth'
import type { CreateArtifactResult, HuaqiuArtifacts } from '@huaqiu/dsh-artifacts'
import { getLogger } from '@huaqiu/dsh-plugin-log'
import {
  agentActions,
  artifactFilenameFor,
  buildCommand,
  buildSocketUrl,
  callComponentAgent,
  commandTypes,
  extractFileUrl,
  fetchArtifactText,
  findAction,
  packageTypes,
  resolveEndpoint,
  resolveImageDataUrl,
  type SocketLike,
} from './protocol.js'
import {
  confirmDirectFootprintWithHuman,
  normalizeDimensions,
  type ExecutionLike,
  type ExtractedDimensions,
  type UserQuestionsLike,
} from './dimensions.js'
import type { HitlLocale } from './hitl-i18n.js'

/** Structural alias of the DSH `JsonValue` (see part-search Phase 1 §15.2.1). */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** The normalized domain values are lossless-JSON plain objects except that
 *  optional fields are `undefined`, which fails DSH's lossless-JSON validation.
 *  JSON round-trip strips `undefined` properties and array holes. */
function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-symbol-footprint'
const log = getLogger(COMPONENT)

/** Agent-facing timeout hints (the image→footprint tool contains a human pause). */
export const TOOL_TIMEOUT_MS = {
  generate_symbol_from_image: 180_000,
  generate_footprint_from_image: 900_000,
  generate_footprint_from_dimensions: 180_000,
} as const

/** Deterministic render for every canonical value. */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

// ── Runtime environment ──────────────────────────────────────────────────────

export interface SymbolFootprintDeps {
  processEnv?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  socketFactory?: (url: string) => SocketLike
  random?: () => number
}

export interface SymbolFootprintEnv {
  /** `huaqiuAuth` node service — token capability. */
  auth: HuaqiuAuthService['auth']
  /** `huaqiuArtifacts` node service — preview-artifact store. */
  artifacts: HuaqiuArtifacts
  deps?: SymbolFootprintDeps
  /**
   * UI language for the HIL prompt copy. Deployment-level (the node half has
   * no DOM to read the host locale from); see `SymbolFootprintConfig`.
   */
  hitlLanguage?: HitlLocale
  /** Opportunistic HIL seam — resolved per call, not injected. */
  getUserQuestions?: () => UserQuestionsLike | undefined
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Resolve the SaaS token, tolerating an unauthenticated state. */
async function resolveToken(auth: HuaqiuAuthService['auth']): Promise<string | null> {
  if (!auth || typeof auth.getAccessToken !== 'function') return null
  try {
    return await auth.getAccessToken()
  } catch (err) {
    log.warn('could not resolve the Huaqiu access token', { error: String((err as Error)?.message || err) })
    return null
  }
}

/**
 * Structured `needs_auth` result returned when the Huaqiu EDA (eda.cn) login
 * is missing — the signal that makes login a human-in-the-loop step. The web
 * client (dsh-auth client half) renders a login card with an embedded
 * auth.eda.cn iframe for this result; the model asks the user to complete the
 * login and then retries the tool. Throwing here would hide that HIT surface.
 */
export function needsAuth(kind: 'symbol' | 'footprint'): Record<string, unknown> {
  return {
    status: 'needs_auth',
    kind,
    hint:
      'This tool requires a Huaqiu EDA (eda.cn) login. The web client is showing ' +
      'a login card with an embedded eda.cn login iframe — ask the user to complete ' +
      'the login there (or use the 华秋EDA login button in the sidebar), then call ' +
      'this tool again.',
  }
}

/**
 * Store a generated artifact in the user-wide preview store via the
 * `huaqiuArtifacts` service (in-process — no HTTP loopback).
 */
async function createPreviewArtifact(
  env: SymbolFootprintEnv,
  type: 'symbol' | 'footprint',
  filename: string,
  content: string,
): Promise<CreateArtifactResult> {
  if (!env.artifacts || typeof env.artifacts.create !== 'function') {
    throw new Error('symbol-footprint: huaqiuArtifacts service unavailable — cannot store preview artifact')
  }
  return env.artifacts.create({ type, filename, content })
}

/**
 * Best-effort cross-process URI for a stored artifact (`file://` to its
 * content on disk). This is what the Place action hands to HQ Edge — an
 * artifact *id* is store-local and meaningless there. Never throws: when the
 * URI cannot be resolved the card simply hides Place.
 */
async function artifactUriOf(env: SymbolFootprintEnv, id: string): Promise<string | null> {
  try {
    if (!env.artifacts || typeof env.artifacts.getDownloadUri !== 'function') return null
    return await env.artifacts.getDownloadUri(id)
  } catch (err) {
    log.warn('getDownloadUri failed', { id, error: String((err as Error)?.message || err) })
    return null
  }
}

/** Shared tail of both generation paths: artifact URL → download → store. */
async function finishGeneration(
  kind: 'symbol' | 'footprint',
  response: { action: { action: string; context: unknown } | null; actions: Array<{ action: string; context: unknown }>; text: string },
  env: SymbolFootprintEnv,
): Promise<{ fileUrl: string; filename: string; artifact?: { id: string; type: string; filename: string; size: number; uri?: string }; content?: string; note?: string; serviceMessage?: string }> {
  const action = response.action
  if (action === null) {
    const notFound = findAction(response.actions, [agentActions.PKG_TYPE_NOT_FOUND])
    if (notFound !== null) {
      throw new Error('symbol-footprint: the component service does not support that package type. ' +
        'Supported types: ' + packageTypes.join(', ') + '.')
    }
    throw new Error('symbol-footprint: the component service did not return a generated ' + kind +
      (response.text ? '. Service said: ' + response.text.slice(0, 400) : '.'))
  }
  const fileUrl = extractFileUrl(action.context)
  if (fileUrl === null) {
    throw new Error('symbol-footprint: the component service returned a ' + kind +
      ' result without a file URL')
  }
  const artifact = await fetchArtifactText(fileUrl, env.deps?.fetchImpl)
  const filename = artifactFilenameFor(kind, fileUrl)
  const result: {
    fileUrl: string
    filename: string
    artifact?: { id: string; type: string; filename: string; size: number; uri?: string }
    content?: string
    note?: string
    serviceMessage?: string
  } = { fileUrl, filename }

  if (typeof artifact.content === 'string' && artifact.content.length > 0) {
    try {
      const created = await createPreviewArtifact(env, kind, filename, artifact.content)
      result.artifact = {
        id: created.id,
        type: created.type,
        filename: created.filename,
        size: created.size,
      }
      // The Place channel: a stable HQ Edge-resolvable URI. Best-effort —
      // without it the card hides Place and everything else still works.
      const uri = await artifactUriOf(env, created.id)
      if (uri) result.artifact.uri = uri
    } catch (storeErr) {
      result.note = (artifact.note ? artifact.note + ' ' : '') +
        'Preview artifact storage failed (' +
        String((storeErr as Error)?.message || storeErr) +
        '). Preview rendering may be unavailable; use fileUrl to download.'
      result.content = artifact.content // data-loss guard
    }
  } else {
    if (artifact.note) result.note = artifact.note
  }
  if (response.text) result.serviceMessage = response.text.slice(0, 2000)
  return result
}

/**
 * The degraded-HIL result: dimensions handed back, nothing generated.
 *
 * `agentNote` (not `note`) — see the module header. The text says "do NOT list
 * or repeat these dimensions in your reply"; rendering it in the card would put
 * an instruction to the model on screen as if it were a message to the user.
 */
function needsConfirmation(
  extracted: ExtractedDimensions,
  agentNote: string,
): Record<string, unknown> {
  return {
    status: 'needs_confirmation',
    kind: 'footprint',
    pkgType: extracted.pkgType,
    fileName: extracted.fileName,
    dimensions: extracted.dimensions,
    agentNote,
  }
}

/**
 * Handle the direct-generation path: the service returned a complete
 * `footprint_button` from the dimensions.generate command. The footprint is
 * already generated, so the HIL is an accept/decline gate.
 */
async function handleDirectFootprint(
  extraction: { action: { action: string; context: unknown } | null; actions: Array<{ action: string; context: unknown }>; text: string },
  env: SymbolFootprintEnv,
  exec?: ExecutionLike,
): Promise<Record<string, unknown>> {
  const generated = await finishGeneration('footprint', extraction, env)

  const userQuestions = typeof env.getUserQuestions === 'function' ? env.getUserQuestions() : undefined
  if (!userQuestions || typeof userQuestions.ask !== 'function') {
    return Object.assign(
      { status: 'generated', kind: 'footprint', autoGenerated: true },
      generated,
      {
        agentNote: 'The service recognised this as a standard package and generated the footprint directly ' +
          '(no dimensions to confirm). Review the footprint; if it is wrong, ask the user for the ' +
          'package_type and dimensions and call generate_footprint_from_dimensions.',
      },
    )
  }

  let decision
  try {
    // Merge the deployment locale into the execution context rather than
    // passing a 5th positional arg: `locale` is not part of the tool-exec
    // seam, it is only read by the HIL helpers.
    decision = await confirmDirectFootprintWithHuman(
      userQuestions,
      generated,
      Object.assign({}, exec, { locale: env.hitlLanguage }),
    )
  } catch (err) {
    log.warn('direct-footprint confirmation unavailable', { error: String((err as Error)?.message || err) })
    return Object.assign(
      { status: 'generated', kind: 'footprint', autoGenerated: true },
      generated,
      {
        agentNote: 'The auto-generated footprint could not be presented for confirmation (' +
          String((err as Error)?.message || err) + '). Review it; if wrong, call ' +
          'generate_footprint_from_dimensions with the correct package_type and dimensions.',
      },
    )
  }

  if (decision.verdict === 'declined') {
    return {
      status: 'cancelled',
      kind: 'footprint',
      autoGenerated: true,
      fileUrl: generated.fileUrl,
      agentNote: 'The user declined the auto-generated footprint. Ask for the package_type and dimensions, ' +
        'then call generate_footprint_from_dimensions.',
    }
  }

  return Object.assign(
    { status: 'generated', kind: 'footprint', autoGenerated: true, confirmedByUser: true },
    generated,
  )
}

// ── Tool bodies ──────────────────────────────────────────────────────────────

/** `generate_symbol_from_image` body. */
export async function runGenerateSymbol(
  args: Record<string, unknown>,
  exec: ExecutionLike | undefined,
  env: SymbolFootprintEnv,
): Promise<Record<string, unknown>> {
  const image = await resolveImageDataUrl(args, env.deps)
  const endpoint = resolveEndpoint(env.deps?.processEnv)
  const token = await resolveToken(env.auth)
  if (token === null) return needsAuth('symbol')
  const url = buildSocketUrl(endpoint, token, env.deps?.random)

  const instruction = typeof args.instruction === 'string' ? args.instruction : ''
  const response = await callComponentAgent({
    url,
    command: buildCommand(commandTypes.PARSE_SYMBOL, { inputText: instruction, images: [image] }),
    awaitActions: [agentActions.SYMBOL_BUTTON],
    signal: exec?.signal,
    socketFactory: env.deps?.socketFactory,
    // Reactive invalidation (spec §6.5): a token-expired frame means the cached
    // credential is dead. Clear it so the next call re-resolves (and the UI
    // re-prompts for login) instead of replaying the same token forever.
    onTokenExpired: () => { env.auth.invalidate() },
  })

  const generated = await finishGeneration('symbol', response, env)
  return Object.assign({ status: 'generated', kind: 'symbol' }, generated)
}

/** `generate_footprint_from_dimensions` body (the post-confirmation half). */
export async function runGenerateFootprintFromDimensions(
  args: Record<string, unknown>,
  exec: ExecutionLike | undefined,
  env: SymbolFootprintEnv,
): Promise<Record<string, unknown>> {
  const pkgType = typeof args.package_type === 'string' ? args.package_type.trim().toLowerCase() : ''
  if (pkgType.length === 0) {
    throw new Error('symbol-footprint: package_type is required (one of ' + packageTypes.join(', ') + ')')
  }
  if (!(packageTypes as readonly string[]).includes(pkgType)) {
    throw new Error('symbol-footprint: unsupported package_type "' + pkgType + '" (expected one of ' +
      packageTypes.join(', ') + ')')
  }
  const dimensions = args && args.dimensions && typeof args.dimensions === 'object' ? args.dimensions as Record<string, unknown> : null
  if (dimensions === null || Object.keys(dimensions).length === 0) {
    throw new Error('symbol-footprint: dimensions is required and must not be empty. ' +
      'Run generate_footprint_from_image first to extract them from a package drawing.')
  }

  const image = typeof args.image === 'string' && args.image.length > 0
    ? await resolveImageDataUrl(args, env.deps)
    : null

  const endpoint = resolveEndpoint(env.deps?.processEnv)
  const token = await resolveToken(env.auth)
  if (token === null) return needsAuth('footprint')
  const url = buildSocketUrl(endpoint, token, env.deps?.random)

  const extra: Record<string, unknown> = { pkgType, dimensions }
  if (typeof args.file_name === 'string' && args.file_name.length > 0) {
    extra.fileName = args.file_name
  }
  const response = await callComponentAgent({
    url,
    command: buildCommand(commandTypes.FOOTPRINT_GENERATE, {
      images: image === null ? undefined : [image],
      extra,
    }),
    awaitActions: [agentActions.FOOTPRINT_BUTTON],
    signal: exec?.signal,
    socketFactory: env.deps?.socketFactory,
    // Reactive invalidation (spec §6.5): a token-expired frame means the cached
    // credential is dead. Clear it so the next call re-resolves (and the UI
    // re-prompts for login) instead of replaying the same token forever.
    onTokenExpired: () => { env.auth.invalidate() },
  })

  const generated = await finishGeneration('footprint', response, env)
  return Object.assign({ status: 'generated', kind: 'footprint', pkgType, dimensions }, generated)
}

/**
 * `generate_footprint_from_image` body — the full flow with the
 * human-in-the-loop step in the middle.
 *
 * The one invariant that must not be broken: a footprint is generated ONLY from
 * dimensions a human has seen. The web client renders the dimension editor card
 * and the result returns `needs_confirmation` so the model calls
 * `generate_footprint_from_dimensions` with the confirmed values.
 */
export async function runGenerateFootprintFromImage(
  args: Record<string, unknown>,
  exec: ExecutionLike | undefined,
  env: SymbolFootprintEnv,
): Promise<Record<string, unknown>> {
  const image = await resolveImageDataUrl(args, env.deps)
  const endpoint = resolveEndpoint(env.deps?.processEnv)
  const token = await resolveToken(env.auth)
  if (token === null) return needsAuth('footprint')

  const requestedPkg = typeof args.package_type === 'string'
    ? args.package_type.trim().toLowerCase() : ''
  if (requestedPkg.length > 0 && !(packageTypes as readonly string[]).includes(requestedPkg)) {
    throw new Error('symbol-footprint: unsupported package_type "' + requestedPkg + '" (expected one of ' +
      packageTypes.join(', ') + ')')
  }

  // The backend has two behaviours for dimensions.generate: (a) recognise a
  // STANDARD package and return footprint_button directly; (b) extract
  // candidate dimensions and return footprint_dimensions. Await BOTH.
  const extractExtra: Record<string, unknown> = {}
  if (requestedPkg.length > 0) extractExtra.pkgType = requestedPkg
  const extraction = await callComponentAgent({
    url: buildSocketUrl(endpoint, token, env.deps?.random),
    command: buildCommand(commandTypes.FOOTPRINT_DIMENSIONS, {
      inputText: typeof args.instruction === 'string' ? args.instruction : '',
      images: [image],
      extra: extractExtra,
    }),
    awaitActions: [agentActions.FOOTPRINT_DIMENSIONS, agentActions.FOOTPRINT_BUTTON],
    signal: exec?.signal,
    socketFactory: env.deps?.socketFactory,
    // Reactive invalidation (spec §6.5): a token-expired frame means the cached
    // credential is dead. Clear it so the next call re-resolves (and the UI
    // re-prompts for login) instead of replaying the same token forever.
    onTokenExpired: () => { env.auth.invalidate() },
  })

  if (extraction.action === null) {
    if (findAction(extraction.actions, [agentActions.PKG_TYPE_NOT_FOUND]) !== null) {
      throw new Error('symbol-footprint: the component service could not match a package type for that ' +
        'image. Pass package_type explicitly (one of ' + packageTypes.join(', ') + ').')
    }
    throw new Error('symbol-footprint: could not extract package dimensions or a footprint from the image' +
      (extraction.text ? '. Service said: ' + extraction.text.slice(0, 400) : '.'))
  }

  // Direct-generation path (case a): the service auto-generated a standard
  // footprint — the HIL is a simple accept/decline gate.
  if (extraction.action.action === agentActions.FOOTPRINT_BUTTON) {
    return handleDirectFootprint(extraction, env, exec)
  }

  // Dimension-extraction path (case b): the web client owns the confirmation
  // UX via an interactive editor card. Always return needs_confirmation here
  // instead of pausing on the native userQuestions.ask() popup.
  const extracted = normalizeDimensions(extraction.action.context)
  if (extracted.pkgType === null && requestedPkg.length > 0) extracted.pkgType = requestedPkg
  if (Object.keys(extracted.dimensions).length === 0) {
    throw new Error('symbol-footprint: the component service returned no dimension values for that image; ' +
      'try a clearer package drawing or pass package_type explicitly.')
  }

  return needsConfirmation(extracted,
    'The web client renders the extracted dimensions in an interactive editor card; the user ' +
    'confirms or corrects them there. Wait for the card confirmation, then call ' +
    'generate_footprint_from_dimensions with the confirmed values. Do NOT ask the user again, ' +
    'do NOT list or repeat these dimensions in your reply, and do NOT generate a footprint from ' +
    'unconfirmed dimensions.')
}

// ── Tool definitions ─────────────────────────────────────────────────────────

/** Shared image-input schema fragment. */
const IMAGE_PARAMS: ParameterSchemaSpec = {
  image_path: {
    type: 'string',
    description:
      'Absolute path to a local image file of the component (a datasheet crop, pinout drawing or ' +
      'package drawing). PNG, JPEG, GIF, WEBP or BMP, up to 4 MiB. Provide this or image_url.',
  },
  image_url: {
    type: 'string',
    description:
      'HTTP(S) URL or data: URL of the component image, as an alternative to image_path.',
  },
}

/**
 * Agent-awareness note about the Huaqiu EDA login gate, appended to every tool
 * description. It tells the model that a `needs_auth` result surfaces a login
 * HIT (embedded eda.cn iframe card) and that it should wait for the user to
 * log in, then retry — it must not invent credentials or fake a success.
 */
const AUTH_GATE_NOTE =
  'AUTH: This tool requires a Huaqiu EDA (eda.cn) account. If the result has ' +
  'status "needs_auth", the web client is showing a login card with an embedded ' +
  'eda.cn login iframe (the human-in-the-loop step). Ask the user to complete the ' +
  'login there or via the 华秋EDA login button in the sidebar (you may use ' +
  'ask_user_question to wait, offering a "retry now that I have logged in" ' +
  'option and a "cancel" option — phrase BOTH in the language the user is ' +
  'writing in), then call this tool again. Never invent credentials and never ' +
  'claim success when the result ' +
  'is needs_auth.'

function createGenerateSymbolTool(env: SymbolFootprintEnv) {
  return defineTool({
    name: 'generate_symbol_from_image',
    description:
      'Generate a KiCad schematic symbol from an image of a component (datasheet pinout drawing, ' +
      'package picture, or a photo of a part). Returns the URL of the generated KiCad symbol library ' +
      'file PLUS a preview artifact reference (id, type, filename, size, and a ' +
      'uri when the cross-process placement channel is available) in the `artifact` field. ' +
      'Use this when the user asks to create, generate or draw a schematic symbol for a part that ' +
      'is not in the component library. ' +
      'IMPORTANT: The generated symbol renders automatically as a result card in the web client — ' +
      'an interactive canvas preview with a download button. Do NOT paste the symbol source, its ' +
      'file URL, or any fenced code block into your reply; just note in one line that the symbol ' +
      'was generated. ' + AUTH_GATE_NOTE,
    parameters: {
      ...IMAGE_PARAMS,
      instruction: {
        type: 'string',
        description:
          'Optional extra guidance for the generator, e.g. "this is a 3-pin LDO, pin 1 is VIN" or the ' +
          'part number. Leave empty when the image speaks for itself.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return asJson(await runGenerateSymbol(args, exec, env))
    },
    timeoutMs: TOOL_TIMEOUT_MS.generate_symbol_from_image,
  })
}

function createGenerateFootprintFromImageTool(env: SymbolFootprintEnv) {
  return defineTool({
    name: 'generate_footprint_from_image',
    description:
      'Generate a KiCad PCB footprint from an image of a package mechanical drawing. Extracts the ' +
      'package dimensions and returns status "needs_confirmation" WITH the extracted dimensions — the ' +
      'web client renders them in an interactive dimension editor card where the user confirms or ' +
      'corrects each value. Do NOT ask the user again yourself; wait for the user to confirm in the ' +
      'card, then call generate_footprint_from_dimensions with the exact confirmed values. The ' +
      'footprint is generated ONLY from dimensions a human has confirmed — never from unconfirmed ' +
      'extraction. Use this when the user asks to create a footprint or land pattern from a datasheet ' +
      'package drawing. ' +
      'IMPORTANT: The generated footprint renders automatically as a result card in the web client — ' +
      'an interactive canvas preview with a download button. Do NOT paste the footprint source, its ' +
      'file URL, or any fenced code block into your reply; just note in one line that the footprint ' +
      'was generated (with the package type when known). ' + AUTH_GATE_NOTE,
    parameters: {
      ...IMAGE_PARAMS,
      package_type: {
        type: 'string',
        enum: packageTypes.slice(),
        description:
          'Optional package family hint. Pass it when the drawing is ambiguous or when a previous ' +
          'attempt could not match a package type; otherwise let the service detect it.',
      },
      instruction: {
        type: 'string',
        description:
          'Optional extra guidance, e.g. "dimensions are in millimetres" or "use the recommended land ' +
          'pattern, not the body outline".',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return asJson(await runGenerateFootprintFromImage(args, exec, env))
    },
    timeoutMs: TOOL_TIMEOUT_MS.generate_footprint_from_image,
  })
}

function createGenerateFootprintFromDimensionsTool(env: SymbolFootprintEnv) {
  return defineTool({
    name: 'generate_footprint_from_dimensions',
    description:
      'Generate a KiCad PCB footprint from package dimensions that are already known and have been ' +
      'confirmed by the user. Use this as the follow-up when generate_footprint_from_image returned ' +
      'status "needs_confirmation", or when the user states the package type and dimensions directly. ' +
      'Do not invent dimension values — they must come from the user or from an extraction the user has ' +
      'reviewed. Returns the generated footprint file URL, a preview artifact reference (id, type, ' +
      'filename, size) in the `artifact` field, plus pkgType and dimensions. ' +
      'IMPORTANT: The generated footprint renders automatically as a result card in the web client — ' +
      'an interactive canvas preview with a download button. Do NOT paste the footprint source, its ' +
      'file URL, or any fenced code block into your reply; just note in one line that the footprint ' +
      'was generated. ' + AUTH_GATE_NOTE,
    parameters: {
      package_type: {
        type: 'string',
        enum: packageTypes.slice(),
        required: true,
        description: 'The package family, e.g. "sop" or "qfn".',
      },
      dimensions: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description:
          'The confirmed dimension values, keyed exactly as the extractor returned them (e.g. ' +
          '{"W": 6.2, "L": 5.0, "pitch": 1.27}). Reuse the keys from a previous ' +
          'generate_footprint_from_image result rather than renaming them.',
      },
      file_name: {
        type: 'string',
        description:
          'Optional file name echoed from a previous extraction result; pass it through when you have it.',
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args, exec) {
      return asJson(await runGenerateFootprintFromDimensions(args, exec, env))
    },
    timeoutMs: TOOL_TIMEOUT_MS.generate_footprint_from_dimensions,
  })
}

/** Build the three tool definitions against a runtime env. */
export function createSymbolFootprintTools(env: SymbolFootprintEnv) {
  return [
    createGenerateSymbolTool(env),
    createGenerateFootprintFromImageTool(env),
    createGenerateFootprintFromDimensionsTool(env),
  ]
}
