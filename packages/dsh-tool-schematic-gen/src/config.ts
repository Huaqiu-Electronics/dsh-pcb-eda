/**
 * `@huaqiu/dsh-tool-schematic-gen` — config, agent identity, run-body and
 * filename helpers (pure, dependency-free).
 *
 * Faithful TypeScript port of the `hq-edge` schematic-gen node half, with ONE
 * deliberate change per migration plan review #9: the demo eda.cn account is
 * REMOVED. The account now always comes from the `huaqiuAuth` service
 * (`getUserInfo()` → `x-user-id` / `x-user-token`); there is no baked-in
 * default credential.
 *
 * @module @huaqiu/dsh-tool-schematic-gen
 */
import { randomUUID } from 'node:crypto'

/** CopilotKit `agentId` values the two tools drive. */
export const agentIds = {
  /** description → final KiCad schematic (`.kicad_sch` files). */
  SCHEMATIC: 'schemagen',
  /** description → module graph → KiCad project zip. */
  SYSTEM: 'modular_circuit',
} as const

/** Default production CopilotKit endpoint (the prod value the reference scripts POST to). */
export const DEFAULT_COPILOTKIT_URL = 'https://gen.eda.cn/api/copilotkit'

/** Default production export-zip endpoint. */
export const DEFAULT_EXPORT_ZIP_URL = 'https://gen.eda.cn/api/modular_circuit/export-zip'

/**
 * Language hint sent to the agent when the caller omits `user_language`.
 *
 * This was a bare `'简体中文'` literal inside `buildRunBody`, which pinned every
 * agent reply to Chinese even for an English UI. The node half has no way to
 * read the host UI locale (the tool is invoked by the model, not the browser),
 * so the value is a named, overridable default instead of an inline literal.
 */
export const DEFAULT_AGENT_LANGUAGE = '简体中文'

/** Resolved runtime config — endpoints only; the account is per-call via auth. */
export interface SchematicGenConfig {
  copilotkitUrl: string
  exportZipUrl: string
  cookie: string | null
  /** Fallback agent language; see `DEFAULT_AGENT_LANGUAGE`. */
  defaultLanguage: string
}

/** The eda.cn account derived from `huaqiuAuth` per call. */
export interface EdaAccount {
  userId: string
  userToken: string
}

/**
 * Resolve the production endpoints from env. No credential defaults: the
 * account is never baked in (migration plan review #9).
 */
export function resolveConfig(env?: Record<string, string | undefined>): SchematicGenConfig {
  const e = env && typeof env === 'object' ? env : {}
  const get = (k: string, d: string) => (typeof e[k] === 'string' && e[k].length > 0 ? e[k]! : d)
  return {
    copilotkitUrl: get('HQ_EDA_COPILOTKIT_URL', DEFAULT_COPILOTKIT_URL),
    exportZipUrl: get('HQ_EDA_EXPORT_ZIP_URL', DEFAULT_EXPORT_ZIP_URL),
    cookie: typeof e['HQ_EDA_COOKIE'] === 'string' && e['HQ_EDA_COOKIE'].length > 0
      ? e['HQ_EDA_COOKIE']
      : null,
    defaultLanguage: get('HQ_EDA_DEFAULT_LANGUAGE', DEFAULT_AGENT_LANGUAGE),
  }
}

/** Build the headers for the CopilotKit SSE POST. */
export function buildHeaders(config: SchematicGenConfig, account: EdaAccount, threadId: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'x-user-id': account.userId,
    'x-user-token': account.userToken,
    'x-thread-id': threadId,
    Referer: 'https://gen.eda.cn/',
  }
  if (config.cookie) h.cookie = config.cookie
  return h
}

/** Build the headers for the export-zip POST (JSON in, zip out). */
export function buildExportHeaders(config: SchematicGenConfig, account: EdaAccount): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'x-user-id': account.userId,
    'x-user-token': account.userToken,
    Referer: 'https://gen.eda.cn/',
  }
  if (config.cookie) h.cookie = config.cookie
  return h
}

/** Minimal empty state for the schematic agent. */
export function emptySchematicState(config: SchematicGenConfig, account: EdaAccount, language: string): Record<string, unknown> {
  return {
    user_id: account.userId,
    token: account.userToken,
    commits: [],
    requirement: '',
    architecture: null,
    circuit: {},
    report: null,
    schFiles: [],
    kicadPro: '',
    outProject: '',
    project_achieve_url: '',
    reportOk: false,
    reportStage: '',
    error: '',
  }
}

/** Empty state for the system-design agent. */
export function emptySystemState(config: SchematicGenConfig, account: EdaAccount, language: string): Record<string, unknown> {
  return {
    design_name: null,
    pending_module_replacement_req: null,
    available_modules: null,
    connection_outdated: true,
    commented_outline: null,
    user_option: null,
    modules_alternatives: null,
    user_id: account.userId,
    token: account.userToken,
    user_language: language,
    user_input: '',
    design_plan: '',
    original_bom_list: [],
    top_block: null,
    search_plan: [],
    bom_list: [],
    module_list: [],
    connect_result: { connections: [] },
    erc_passed: false,
    connection_count: 0,
    pending_bom_updates: [],
    connect_agent_summary: '',
    connect_iteration_history: [],
    bom_exclusion_list: {},
    reflect_retry_count: 0,
    task_completed: false,
    final_report_content: '',
    circuit_url: null,
    module_graph: null,
    kicad_project_zip_url: null,
  }
}

/**
 * Build the CopilotKit `agent/run` body. A FRESH uuid is assigned to both
 * `threadId` and `runId` (and reused for `x-thread-id`) so every call is a
 * one-shot, independent run.
 */
export function buildRunBody(
  agentId: string,
  description: string,
  config: SchematicGenConfig,
  account: EdaAccount,
  language?: string,
  threadId?: string,
): Record<string, unknown> {
  const tid = typeof threadId === 'string' && threadId.length > 0 ? threadId : randomUUID()
  const runId = randomUUID()
  const msgId = randomUUID()
  const lang = typeof language === 'string' && language.length > 0 ? language : config.defaultLanguage
  const state = agentId === agentIds.SCHEMATIC
    ? emptySchematicState(config, account, lang)
    : emptySystemState(config, account, lang)
  return {
    method: 'agent/run',
    params: { agentId },
    body: {
      threadId: tid,
      runId,
      tools: [],
      context: [{
        description: 'Current Module Circuit Design State',
        value: JSON.stringify({ user_language: lang }),
      }],
      forwardedProps: {},
      state,
      messages: [{ id: msgId, role: 'user', content: String(description || '') }],
    },
  }
}

/**
 * Derive a human-readable, filesystem-safe zip basename from the design name.
 * Keeps Unicode letters/digits (CJK included) intact; only illegal path chars
 * and whitespace are replaced.
 */
export function sanitizeZipBaseName(designName: string): string {
  const normalized = String(designName || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  return Array.from(normalized).slice(0, 60).join('') || 'circuit'
}
