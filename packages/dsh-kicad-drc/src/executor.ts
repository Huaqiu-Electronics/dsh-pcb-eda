/**
 * 执行器接口 + 结果类型。
 * 实现：本地 subprocess（LocalExecutor）、远程 pcblint 服务（RemoteExecutor）、
 * 运行中 KiCad 的 IPC（KicadIpcExecutor）；由 AdaptiveExecutor 做选择与回退。
 */

/** 后端标识。 */
export type DrcBackendName = 'local' | 'remote' | 'ipc'

/** 请求的执行模式：auto 交给 AdaptiveExecutor 决策，其余强制指定后端。 */
export type DrcMode = 'auto' | DrcBackendName

/** 后端健康状态（探测结果；不产生 DRC 副作用）。 */
export interface BackendHealth {
  backend: DrcBackendName
  available: boolean
  /** 实际使用的端点：本地为 kicad-cli 绝对路径，远程为服务地址。 */
  endpoint: string
  /** 不可用原因（available=false 时有值）。 */
  reason?: string
}

/**
 * 后端来源标注：这次结果由哪个后端跑出来的、为什么选它。
 *
 * 定义在执行器这一层（而不是 AdaptiveExecutor 里），因为它是**结果的一部分**：
 * `DrcRunResult.verifiedBy` 带着它跨模块传递，消费方不必再对执行器做类型转换。
 */
export interface VerifiedBy {
  backend: DrcBackendName
  /** 实际端点：本地为 kicad-cli 路径，远程为服务地址。 */
  endpoint: string
  elapsedMs: number
  /** 为什么选它（人类可读，直接给 AI 看）。 */
  reasons: string[]
  /** 若发生过回退，回退前的后端。 */
  fallbackFrom?: DrcBackendName
  /** 选中的后端是否启用了配置隔离（本地后端专用）。 */
  isolatedConfig?: boolean
}

/**
 * 工程规则注入结果。
 *
 * 存在的理由：`notes`（stderr 文本）里那句话人看得懂，但程序判不出来。
 * 而"这次是按我们板的规则判的，还是按服务端默认工程判的"直接决定结果能不能用——
 * 没有 `.kicad_pro` 时按默认参数检查，就是那条被误判 1139 次的通路。
 * 所以把状态做成字段，让调用方能自己判断，而不是让人去读日志。
 */
export type DrcProjectRulesStatus = 'injected' | 'absent' | 'skipped' | 'failed' | 'not-applicable'

export interface DrcProjectRules {
  status: DrcProjectRulesStatus
  /** 规则来源（`.kicad_pro` 文件名或 `inline`）。 */
  source?: string
  /** 实际注入的板级约束条数。 */
  applied: number
  /** 未注入的约束 key（这些项沿用服务端默认值）。 */
  skipped: string[]
  /** 工程自带 `.kicad_dru` 是否已合并进会话规则。 */
  druMerged: boolean
  /** 跳过/失败的原因。 */
  message?: string
}

/** 服务端返回的口径指标（只有 remote 后端产出）。 */
export interface DrcRunMetrics {
  /** 服务端按抑制规则过滤掉的条数。 */
  suppressedCount: number | null
  /** 服务端是否真的跑了 kicad-cli 原生检查。 */
  kicadDrcUsed: boolean | null
  /** 服务端实际执行的规则数。 */
  rulesExecuted: number | null
  /** 服务端当前启用的 KiCad 内置规则数（pcblint 新版返回；旧版没有则为 null）。 */
  drcRulesCount: number | null
}

/**
 * KiCad 内置 DRC 规则的严重级别（pcblint 校验开关面板的取值）。
 *
 * `ignore` = 关闭该内置规则（违规不会出现在结果里）。
 * 注意与 `.kicad_dru` 注入是两套机制：这是给服务端生成 `.kicad_pro` 用的开关。
 */
export type DrcRuleSeverity = 'error' | 'warning' | 'ignore'

/**
 * 校验开关（`PUT /api/s/drc-rules`）的结果。
 *
 * 与 {@link DrcProjectRules} 同样的思路：状态做成字段，让调用方判得出
 * "结果里缺内置规则违规，是因为我没开、还是开关没写进去、还是服务端太旧"。
 */
export interface DrcRuleOverridesResult {
  /** applied=已写入；unsupported=服务端没有该接口（旧版 404）；failed=写入失败 */
  status: 'applied' | 'unsupported' | 'failed'
  /** 尝试设置的规则 key（无论成败都回传，便于比对哪些生效了）。 */
  keys: string[]
  /** 写入后服务端启用的内置规则总数（保存响应里数出来的；拿不到为 null）。 */
  enabledCount: number | null
  /** 跳过/失败的原因。 */
  message?: string
}

/** DRC 执行结果。 */
export interface DrcRunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** drc.json 原始 JSON 字符串；null 表示未生成。 */
  drcJson: string | null
  elapsedMs: number
  timedOut: boolean
  /** 实际使用的 kicad-cli 可执行文件绝对路径。 */
  kicadCliPath: string
  /** 实际执行的完整命令行（含参数）。 */
  command: string
  /** drc.json 文件持久化保存的绝对路径（供用户直接打开/下载）。 */
  drcJsonPath: string | null
  /** 本次执行是否使用了隔离的 KICAD_CONFIG_HOME（仅本地后端会设置）。 */
  isolatedConfig?: boolean
  /**
   * 报告格式。`kicad-cli` = kicad-cli 原生 JSON（按检查项分区，severity 小写）；
   * `pcblint` = pcblint 语义服务格式（顶层 violations，severity 大写、带 confidence/backend）。
   * 缺省视为 `kicad-cli`。两种格式不能直接对比数字。
   */
  reportFormat?: 'kicad-cli' | 'pcblint'
  /**
   * 实际执行后端与选择依据。自适应执行器总会填；直接调用单个执行器时没有。
   */
  verifiedBy?: VerifiedBy
  /**
   * 工程规则注入结果。只有 remote 后端产出：local/ipc 由 kicad-cli 自己读工程目录，
   * 不存在"注入"这一步。缺省视为未产出（而不是"没注入"），别把两者混为一谈。
   */
  projectRules?: DrcProjectRules
  /**
   * KiCad 内置规则开关结果。只有 remote 后端产出（新接口 `PUT /api/s/drc-rules`）；
   * local/ipc 由 kicad-cli 自己读工程目录、全量跑内置规则，不存在开关这一步。
   */
  drcRules?: DrcRuleOverridesResult
  /** 服务端口径指标（只有 remote 产出）；缺省时调用方自行从 stdout 取。 */
  metrics?: DrcRunMetrics
}

/**
 * 调用方直接提供的工程规则源内容（而非从磁盘读取）。
 *
 * 自动布局的候选板是被投影出来的临时文件，磁盘上只有 `.kicad_pcb`，
 * 同目录没有 `.kicad_pro`；调用方手里持有的是**冻结过**的工程规则快照，
 * 由 {@link DrcRunOptions.ruleSources} 传进来，避免这里回读用户工程拿到另一份规则。
 */
export interface DrcRuleSources {
  /** `.kicad_pro` 文本内容。 */
  projectFile?: string
  /** 工程里已有的 `.kicad_dru` 文本内容（可选，会与板级约束合并）。 */
  drcFile?: string
  /** 规则来源名（用于结果标注），默认 `inline`。 */
  name?: string
}

/** 执行器选项。 */
export interface DrcRunOptions {
  /** .kicad_pcb 文件绝对路径。 */
  pcbPath: string
  /**
   * 调用方提供的工程规则源；给了就不读同目录 `.kicad_pro`。
   * 只对 remote 后端生效（local/ipc 直接读工程目录）。
   */
  ruleSources?: DrcRuleSources
  /**
   * KiCad 内置规则开关（`key → error/warning/ignore`）。只对 remote 生效；
   * 未出现的 key 保持服务端当前值。给了它，结果里就只可能出现这些内置规则的
   * 违规 + pcblint 自研规则（布局评分据此做规则维度的过滤）。
   */
  drcRuleOverrides?: Record<string, DrcRuleSeverity>
  /** 启用所有严重级别。 */
  severityAll?: boolean
  /** DRC 前重绘填充区。 */
  refillZones?: boolean
  /** 报告所有走线错误。 */
  allTrackErrors?: boolean
  /** 超时秒数。 */
  timeoutSeconds?: number
  /**
   * 调用方取消信号。各执行器都必须响应：远程要中断 HTTP，本地/ipc 要杀掉子进程。
   *
   * 与 `timeoutSeconds` 的区别不只是来源：超时是"这次失败了"，取消是"用户不要了"。
   * 取消不能触发自适应执行器的后端回退——再试一个后端只会白烧时间。
   */
  signal?: AbortSignal
  /**
   * 请求的执行模式。仅 AdaptiveExecutor 读取；单个执行器忽略该字段
   * （显式指定模式时由调用方直接选中对应执行器）。
   */
  mode?: DrcMode
}

/** 执行器抽象接口。 */
export interface DrcExecutor {
  /** 执行 kicad-cli pcb drc 并返回结果。 */
  run(options: DrcRunOptions): Promise<DrcRunResult>
  /** 后端标识（AdaptiveExecutor 按此排序与标注）。 */
  readonly name?: DrcBackendName
  /** 能力探测：只判断可用性，不跑 DRC。 */
  probe?(): Promise<BackendHealth>
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutorError'
  }
}

/**
 * 调用方取消（`AbortSignal`）导致的终止。
 *
 * 单独一个类型是为了和"超时/后端失败"区分开：自适应执行器靠它决定**不回退**。
 * 继承 `ExecutorError`，所以既有的 `instanceof ExecutorError` 判断仍然成立。
 */
export class DrcAbortedError extends ExecutorError {
  constructor(message = 'DRC 检查已取消') {
    super(message)
    this.name = 'DrcAbortedError'
  }
}

/** 判断一个错误是不是"调用方取消"。兼容 fetch 抛出的原生 `AbortError`。 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DrcAbortedError) return true
  return error instanceof Error && error.name === 'AbortError'
}
