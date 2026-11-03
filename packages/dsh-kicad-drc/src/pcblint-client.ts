/**
 * pcblint DRC 服务客户端。
 *
 * 替代已废弃的 cli-runner 通道（`POST /api/cli/run-with-file`）。pcblint 是
 * 语义化 DRC 服务（本地单机部署版见 `E:\pcblint-local`，生产版同源），
 * 一条完整检查要两步握手：
 *
 *   1. `POST {base}/api/s/upload`        multipart 上传 `.kicad_pcb`，返回 sessionToken
 *   2. `POST {base}/api/s/lint-drc`      带 `X-Session-Token`，返回 violations 列表
 *
 * 服务端自己完成：S-表达式解析 → 语义分类 → 规则引擎（NATIVE）→
 * 生成 `.kicad_dru` → 本地 `kicad-cli pcb drc`（EDA_DRC）→ 合并 + 抑制过滤。
 * 因此客户端只上传板文件，不传命令、不传规则、也不取回产物文件。
 *
 * 鉴权：生产环境要求 `x-token`；本地部署可开 `pcblint.auth.local-bypass`
 * 免鉴权。两者都不需要 `X-Session-Token` 之外的凭据。
 *
 * @module
 */

/** 单条违规（服务端 `Violation`）。severity/confidence 都是大写枚举。 */
export interface PcblintViolation {
  /**
   * 规则库里的规则 ID。pcblint 新版里 KiCad 内置规则（EDA_DRC 通道）该字段为
   * `null`（或旧版的空串），此时检查项 key 要从 `message` 冒号前取。
   */
  ruleId?: string | null
  title?: string
  /** `ERROR` / `WARNING` / `INFO`。 */
  severity?: string
  /** `HIGH` / `MEDIUM` / `LOW`。 */
  confidence?: string
  /** 形如 `courtyards_overlap: Courtyards overlap`，冒号前是检查项 key。 */
  message?: string
  location?: { x?: number, y?: number }
  /** 涉及的位号/网络名。 */
  objects?: string[]
  /** `EDA_DRC`（kicad-cli 原生检查）或 `NATIVE`（pcblint 规则引擎）。 */
  backend?: string
}

/** `/api/s/upload` 的响应（只保留本插件用得到的字段）。 */
export interface PcblintUploadResult {
  sessionToken: string
  fileName?: string
  /** 服务端按 MD5 命中已有会话时复用，不重新解析。 */
  reused?: boolean
  /** PCB 预览包地址（本插件不用，保留便于排查）。 */
  zipUrl?: string
}

/** `/api/s/lint-drc` 的响应。 */
export interface PcblintLintResult {
  /** 服务端是否找到 kicad-cli；false 时只有 NATIVE 规则结果。 */
  kicadDrcAvailable?: boolean
  /** 本次是否真的跑了 kicad-cli 原生检查。 */
  kicadDrcUsed?: boolean
  violations: PcblintViolation[]
  groups?: unknown[]
  drcRulesCount?: number
  nativeRulesCount?: number
  manualRulesCount?: number
  rulesExecuted?: number
  /** 被抑制规则过滤掉的条数。 */
  suppressedCount?: number
}

/** `/api/s/dru` 的响应：会话当前的 `.kicad_dru` 内容。 */
export interface PcblintDruFile {
  fileName?: string
  content: string
  /** `GENERATED`（服务端按板自动生成）或 `USER_EDITED`（被 PUT 覆盖过）。 */
  source?: string
}

/** KiCad 内置 DRC 规则开关的一条状态（`GET/PUT /api/s/drc-rules`）。 */
export interface PcblintDrcRule {
  /** KiCad `.kicad_pro` 里 `rule_severities` 的 key，如 `clearance`。 */
  key: string
  /** `error` / `warning` / `ignore`。 */
  severity: string
  /** 当前是否启用（severity 非 ignore）。 */
  enabled: boolean
  /** 锁定项：DRU 自研规则依赖其约束类型，保存时会被服务端忽略。 */
  locked?: boolean
}

/** `/api/s/drc-rules` 的响应（GET 与 PUT 相同结构）。 */
export interface PcblintDrcRules {
  proFileName?: string
  proExists?: boolean
  /** 是否有用户显式保存过的开关。 */
  overrides?: boolean
  rules: PcblintDrcRule[]
}

/** `/api/s/drc-status` 的响应：服务端视角的 kicad-cli 可用性（无需会话）。 */
export interface PcblintDrcStatus {
  available: boolean
  /** 形如 `local://ProcessBuilder (kicad-cli at <路径>)`；排查配置错误用。 */
  cliRunnerUrl?: string
}

/** 客户端错误码。 */
export type PcblintErrorCode =
  | 'PCBLINT_UNREACHABLE'
  | 'PCBLINT_TIMEOUT'
  | 'PCBLINT_HTTP_ERROR'
  | 'PCBLINT_BAD_RESPONSE'
  | 'PCBLINT_SESSION_MISSING'

export class PcblintError extends Error {
  readonly code: PcblintErrorCode
  constructor(code: PcblintErrorCode, message: string) {
    super(message)
    this.name = 'PcblintError'
    this.code = code
  }
}

/** 是否中止类错误（超时/主动取消）：不重试。 */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

/** 延迟（重试间隔）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface PcblintClientOptions {
  /** 服务根地址，如 `http://127.0.0.1:8096`。 */
  baseUrl: string
  /** `x-token`；本地免鉴权部署可留空。 */
  token?: string
  /** 注入 fetch，便于单测。 */
  fetchImpl?: typeof fetch
  /** 失败重试次数（网络错误 / HTTP 5xx），默认 1 次。 */
  retries?: number
}

/** 从服务端错误响应里提取可读信息；不带任何凭据。 */
async function describeFailure(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '')
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const msg = body.error ?? body.message ?? body.detail
    if (typeof msg === 'string' && msg) return `${resp.status} ${msg}`
  } catch { /* 非 JSON，退回原文 */ }
  return `${resp.status} ${text.slice(0, 300)}`
}

export class PcblintClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly retries: number

  constructor(opts: PcblintClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token?.trim() ?? ''
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.retries = opts.retries ?? 1
  }

  /** 服务存活探测（`/api/s/health`）。 */
  async health(signal?: AbortSignal): Promise<{ ok: boolean, version?: string }> {
    const resp = await this.request('GET', '/api/s/health', undefined, signal, '健康检查')
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
    const ok = body.status === 'ok' || resp.ok
    return { ok, ...(typeof body.version === 'string' ? { version: body.version } : {}) }
  }

  /** 上传一块 `.kicad_pcb`，拿到会话令牌。 */
  async upload(fileName: string, bytes: Uint8Array, signal?: AbortSignal): Promise<PcblintUploadResult> {
    const form = new FormData()
    // 复制到 ArrayBuffer 支撑的视图：Node 的 Buffer 是 Uint8Array<ArrayBufferLike>，
    // 与 DOM 的 BlobPart 类型不兼容（可能是 SharedArrayBuffer 视图）
    form.append('file', new Blob([new Uint8Array(bytes)]), fileName)
    const resp = await this.request('POST', '/api/s/upload', form, signal, '上传 PCB')
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.sessionToken !== 'string' || !body.sessionToken) {
      throw new PcblintError('PCBLINT_BAD_RESPONSE', 'pcblint 上传响应缺少 sessionToken')
    }
    return {
      sessionToken: body.sessionToken,
      ...(typeof body.fileName === 'string' ? { fileName: body.fileName } : {}),
      ...(typeof body.reused === 'boolean' ? { reused: body.reused } : {}),
      ...(typeof body.zipUrl === 'string' ? { zipUrl: body.zipUrl } : {}),
    }
  }

  /**
   * 读取会话当前的 DRC 规则文件（`.kicad_dru`）。
   *
   * 服务端会按板的分类自动生成一批语义规则（ic_keepout 等），注入工程约束时
   * 必须在这份内容之后追加，不能整份覆盖，否则会丢掉服务端规则。
   */
  async getDru(sessionToken: string, signal?: AbortSignal): Promise<PcblintDruFile> {
    if (!sessionToken) {
      throw new PcblintError('PCBLINT_SESSION_MISSING', '缺少会话令牌，无法读取规则文件')
    }
    const resp = await this.request(
      'GET',
      '/api/s/dru',
      undefined,
      signal,
      '读取规则文件',
      { 'X-Session-Token': sessionToken },
    )
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.content !== 'string') {
      throw new PcblintError('PCBLINT_BAD_RESPONSE', 'pcblint 规则文件响应缺少 content')
    }
    return {
      content: body.content,
      ...(typeof body.fileName === 'string' ? { fileName: body.fileName } : {}),
      ...(typeof body.source === 'string' ? { source: body.source } : {}),
    }
  }

  /** 覆盖会话的 DRC 规则文件（服务端标记 `source=USER_EDITED`）。 */
  async putDru(sessionToken: string, content: string, signal?: AbortSignal): Promise<PcblintDruFile> {
    if (!sessionToken) {
      throw new PcblintError('PCBLINT_SESSION_MISSING', '缺少会话令牌，无法写入规则文件')
    }
    const resp = await this.request(
      'PUT',
      '/api/s/dru',
      JSON.stringify({ content }),
      signal,
      '写入规则文件',
      { 'X-Session-Token': sessionToken, 'Content-Type': 'application/json' },
    )
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    return {
      content: typeof body?.content === 'string' ? body.content : content,
      ...(typeof body?.fileName === 'string' ? { fileName: body.fileName } : {}),
      ...(typeof body?.source === 'string' ? { source: body.source } : {}),
    }
  }

  /** 恢复服务端自动生成的规则文件（丢弃所有注入内容）。 */
  async resetDru(sessionToken: string, signal?: AbortSignal): Promise<void> {
    if (!sessionToken) {
      throw new PcblintError('PCBLINT_SESSION_MISSING', '缺少会话令牌，无法重置规则文件')
    }
    await this.request('POST', '/api/s/dru/reset', undefined, signal, '重置规则文件', {
      'X-Session-Token': sessionToken,
    })
  }

  /**
   * 读取当前板子的 KiCad 内置规则开关。
   *
   * 旧版服务没有该接口（404 抛 `PcblintError`，message 里带状态码），
   * 调用方需自行按"不支持"降级——见 `RemoteExecutor.applyDrcRuleOverrides`。
   */
  async getDrcRules(sessionToken: string, signal?: AbortSignal): Promise<PcblintDrcRules> {
    if (!sessionToken) {
      throw new PcblintError('PCBLINT_SESSION_MISSING', '缺少会话令牌，无法读取校验开关')
    }
    const resp = await this.request(
      'GET',
      '/api/s/drc-rules',
      undefined,
      signal,
      '读取校验开关',
      { 'X-Session-Token': sessionToken },
    )
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !Array.isArray(body.rules)) {
      throw new PcblintError('PCBLINT_BAD_RESPONSE', 'pcblint 校验开关响应缺少 rules 数组')
    }
    return {
      rules: body.rules as unknown as PcblintDrcRule[],
      ...(typeof body.proFileName === 'string' ? { proFileName: body.proFileName } : {}),
      ...(typeof body.proExists === 'boolean' ? { proExists: body.proExists } : {}),
      ...(typeof body.overrides === 'boolean' ? { overrides: body.overrides } : {}),
    }
  }

  /**
   * 保存 KiCad 内置规则开关。`rules` 是 `key → error/warning/ignore` 的稀疏映射：
   * 没出现的 key 保持原值，锁定的 key 由服务端忽略。
   */
  async putDrcRules(
    sessionToken: string,
    rules: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<PcblintDrcRules> {
    if (!sessionToken) {
      throw new PcblintError('PCBLINT_SESSION_MISSING', '缺少会话令牌，无法保存校验开关')
    }
    const resp = await this.request(
      'PUT',
      '/api/s/drc-rules',
      JSON.stringify({ rules }),
      signal,
      '保存校验开关',
      { 'X-Session-Token': sessionToken, 'Content-Type': 'application/json' },
    )
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !Array.isArray(body.rules)) {
      throw new PcblintError('PCBLINT_BAD_RESPONSE', 'pcblint 校验开关保存响应缺少 rules 数组')
    }
    return {
      rules: body.rules as unknown as PcblintDrcRule[],
      ...(typeof body.proFileName === 'string' ? { proFileName: body.proFileName } : {}),
      ...(typeof body.proExists === 'boolean' ? { proExists: body.proExists } : {}),
      ...(typeof body.overrides === 'boolean' ? { overrides: body.overrides } : {}),
    }
  }

  /**
   * kicad-cli 可用性（服务端口径，无需会话）。
   *
   * 注意：旧版服务只报"配置了 runner"，不验证路径是否真的存在，所以
   * `available=true` 不等于 kicad-cli 真能跑起来——最终以 lint 响应的
   * `kicadDrcUsed` 为准，这里只作展示与排查参考。
   */
  async drcStatus(signal?: AbortSignal): Promise<PcblintDrcStatus> {
    const resp = await this.request('GET', '/api/s/drc-status', undefined, signal, 'kicad-cli 状态')
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.available !== 'boolean') {
      throw new PcblintError('PCBLINT_BAD_RESPONSE', 'pcblint drc-status 响应缺少 available')
    }
    return {
      available: body.available,
      ...(typeof body.cliRunnerUrl === 'string' ? { cliRunnerUrl: body.cliRunnerUrl } : {}),
    }
  }

  /** 对已上传的会话执行完整 DRC（规则引擎 + 原生 kicad-cli）。 */
  async lintDrc(sessionToken: string, signal?: AbortSignal): Promise<PcblintLintResult> {
    if (!sessionToken) {
      throw new PcblintError('PCBLINT_SESSION_MISSING', '缺少会话令牌，无法执行 lint-drc')
    }
    const resp = await this.request(
      'POST',
      '/api/s/lint-drc',
      undefined,
      signal,
      '执行 DRC',
      { 'X-Session-Token': sessionToken },
    )
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !Array.isArray(body.violations)) {
      throw new PcblintError('PCBLINT_BAD_RESPONSE', 'pcblint lint-drc 响应缺少 violations 数组')
    }
    return body as unknown as PcblintLintResult
  }

  /** 上传 + 执行，返回两步的原始响应。 */
  async run(
    fileName: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ upload: PcblintUploadResult, lint: PcblintLintResult }> {
    const upload = await this.upload(fileName, bytes, signal)
    const lint = await this.lintDrc(upload.sessionToken, signal)
    return { upload, lint }
  }

  /** 统一的请求入口：带 `x-token`、重试、错误码归一。 */
  private async request(
    method: string,
    path: string,
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
    label: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders }
    if (this.token) headers['x-token'] = this.token

    let lastError: unknown
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const resp = await this.fetchImpl(url, {
          method,
          ...(body === undefined ? {} : { body }),
          headers,
          ...(signal ? { signal } : {}),
        })
        if (resp.status >= 500 && attempt < this.retries) {
          await resp.body?.cancel().catch(() => {})
          console.warn(`[@huaqiu/dsh-kicad-drc] ${label} HTTP ${resp.status}，1s 后重试`)
          await sleep(1000)
          continue
        }
        if (!resp.ok) {
          throw new PcblintError('PCBLINT_HTTP_ERROR', `pcblint ${label}失败: ${await describeFailure(resp)}`)
        }
        return resp
      } catch (e) {
        if (e instanceof PcblintError) throw e
        if (isAbortError(e)) {
          throw new PcblintError('PCBLINT_TIMEOUT', `pcblint ${label}超时或被取消`)
        }
        lastError = e
        if (attempt >= this.retries) break
        console.warn(`[@huaqiu/dsh-kicad-drc] ${label} 网络错误: ${(e as Error).message}，1s 后重试`)
        await sleep(1000)
      }
    }
    throw new PcblintError(
      'PCBLINT_UNREACHABLE',
      `pcblint ${label}无法连接 ${this.baseUrl}: ${(lastError as Error)?.message ?? '未知错误'}`,
    )
  }
}
