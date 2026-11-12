/**
 * DSH 工具定义：kicad_drc_run。
 *
 * AI agent 调用此工具，传入 .kicad_pcb 文件路径，
 * 工具在 Host 端执行 kicad-cli pcb drc（本地 subprocess 或远程 pcblint-java）
 * 并返回结构化结果。
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseDrcSummary, formatSummaryText, type DrcSummary, type JsonValue } from './drc-summary.ts'
import {
  onlyLockedRulesEnabled,
  type BackendHealth,
  type DrcExecutor,
  type DrcMode,
  type DrcRuleSeverity,
  type VerifiedBy,
} from './executor.ts'

/** 工具名（唯一来源；注册/卸载日志与 dispose 均使用它）。 */
export const TOOL_NAME = 'kicad_drc_run'

/** 后端探测工具名。 */
export const BACKENDS_TOOL_NAME = 'kicad_drc_backends'

/** 工具输出结构。未生成报告的字段直接省略（drcJsonPath/drcJson/drcSummary）。 */
interface KicadDrcOutput {
  success: boolean
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  /** 本次执行使用的 kicad-cli（local 模式为可执行文件绝对路径，remote 模式为 remote:<baseUrl> 标识）。 */
  kicadCliPath: string
  /** 实际执行的完整命令行（含参数）。 */
  command: string
  /** 报告格式：kicad-cli（原生）或 pcblint（语义服务）。两种格式不可直接比较数字。 */
  reportFormat?: string
  /**
   * 报告是否完整。false 的两种情况：
   *   - 服务端没跑 kicad-cli（`kicadDrcUsed=false`）；
   *   - 内置规则里只有被锁定的项在参与（用户没主动打开任何内置规则）——
   *     两种情况结果都缺了 kicad-cli 原生检查那部分。
   * 字段缺失表示结果完整、或后端没给出可判定的口径。
   */
  reportComplete?: boolean
  /** `reportComplete=false` 的具体原因，用于生成不产生歧义的提示文案。 */
  reportIncomplete?: 'kicad-cli' | 'rules'
  /** 内置规则开关状态（remote 后端总是出现；status=observed 表示只读取未写入）。 */
  drcRules?: Record<string, JsonValue>
  /** drc.json 持久化保存的绝对路径（PCB 文件同目录，可直接打开）。 */
  drcJsonPath?: string
  /** drc.json 原始 JSON 字符串（可能很大；仅 includeFullJson=true 时返回）。 */
  drcJson?: string
  /** 解析后的紧凑摘要。 */
  drcSummary?: DrcSummary
  /** 本次验证由哪个后端执行、为什么选它（跨后端结果不可直接比较，务必读这个字段）。 */
  verifiedBy?: Record<string, JsonValue>
  /** 规则口径：是否真的按工程板级约束检查（injected / skipped / failed / not-applicable）。 */
  projectRules?: Record<string, JsonValue>
  /** Web GUI 报告查看器地址（浏览器半边经此拉取报告 JSON 并分页渲染；无 webServer 时省略）。 */
  viewUrl?: string
}

/**
 * 创建 kicad_drc_run 工具。
 *
 * @param registerReport 可选的报告登记回调：DRC 成功生成报告后，把 drc.json
 *   路径登记到 webServer 路由的 key 上，供浏览器半边拉取渲染（无 webServer 时传 undefined）。
 */
export function createDrcTool(
  executor: DrcExecutor,
  defaultTimeoutSeconds = 600,
  registerReport?: (key: string, reportPath: string) => void,
  options: { defaultMode?: DrcMode } = {},
) {
  const defaultMode: DrcMode = options.defaultMode ?? 'auto'
  return defineTool({
    name: TOOL_NAME,
    description:
      '对 KiCad PCB 文件执行 DRC（设计规则检查）。\n\n'
      + '【工作原理】三种后端执行方式不同：\n\n'
      + '  - local / ipc：直接跑 kicad-cli pcb drc <pcb文件> --output drc.json --format json --severity-all --refill-zones\n'
      + '  - remote：把 pcb 文件 multipart 上传到 pcblint DRC 服务（POST /api/s/upload → POST /api/s/lint-drc），\n'
      + '    由服务端运行「语义规则引擎（NATIVE）+ 本地 kicad-cli 原生检查（EDA_DRC）」并合并返回\n\n'
      + '三种后端（mode 参数可强制指定，默认 auto 自动选择）：\n'
      + '  - local:  本地 subprocess 直接调 kicad-cli（需本机安装 KiCad；'
      + '可执行文件按 插件配置 → 环境变量 KICAD_CLI_PATH → PATH → Windows 注册表 → 常见安装目录 自动探测）。'
      + '约 1~2 秒，且能读取工程级规则，但只有在 remote 不可用或失败时才会被选到\n'
      + '  - remote: 上传到 pcblint 服务执行（本机无需 KiCad）。约 3~10 秒；'
      + '除 kicad-cli 原生检查外还会跑服务端规则引擎，每条违规带 confidence（HIGH/MEDIUM/LOW）与 ruleId；'
      + '只上传单个 .kicad_pcb，工程级规则（.kicad_pro）带不过去，因此违规数通常与 local 不同。'
      + '⚠️ pcblint 新版默认只启用被锁定的 clearance（59 条内置规则里其余 58 条关闭）——'
      + '结果里主要是服务端自研规则；'
      + '要检查其他内置项（silk_edge_clearance、lib_footprint_issues 等）必须用 drcRules 参数显式打开；'
      + '内置规则走 kicad-cli 通道，服务端 kicad-cli 跑不起来时打开也不会有新条目\n'
      + '  - ipc:   让正在运行的 KiCad 直接执行（需要华秋定制版 KiCad 提供 RunDrc）\n\n'
      + 'auto 模式先按固定优先序列分层（默认 remote → local → ipc），前一层不可用或执行失败才降级；'
      + '同一层内才按历史耗时排序，所以 local 更快也不会插队抢在 remote 前面。'
      + '失败会自动回退到下一个，并在结果的 verifiedBy 字段标注实际执行的后端。'
      + '同一块板在会话内会保持在首次成功的后端上，保证多次结果可比。\n\n'
      + '传入 .kicad_pcb 文件的绝对路径（文件必须存在于本机文件系统），'
      + '工具返回 stdout、drcSummary（错误/警告数量、按类型分类、示例错误等）'
      + '和 drcJsonPath（完整报告持久化在 PCB 文件同目录，可直接读取该文件查看明细）。'
      + '报告格式由 reportFormat 标明：kicad-cli（原生，severity 小写）或 pcblint（severity 大写 + confidence），两种格式的数字不可直接比较。'
      + '如果只关心概况，优先读 drcSummary；需要完整明细时传 includeFullJson=true 或直接读 drcJsonPath 指向的文件。\n\n'
      + '【注意】默认输出不含原始 JSON（可能数百 KB），避免撑爆上下文。'
      + 'success 表示 DRC 运行是否正常完成，不代表板子没有违规——有无违规请判断 drcSummary.totalIssues。',

    parameters: {
      pcbPath: {
        type: 'string',
        required: true,
        description: 'KiCad PCB 文件的绝对路径（.kicad_pcb）。',
      },
      mode: {
        type: 'string',
        description:
          `执行后端。默认 ${defaultMode}（auto 按优先序列选择：默认 remote → local → ipc，`
          + '前一个不可用或执行失败才降级到下一个）；'
          + 'local 强制本地 kicad-cli；remote 强制走 pcblint 服务（语义规则 + 原生检查）；'
          + 'ipc 直接让正在运行的 KiCad 执行 DRC 并取回结构化结果'
          + '（作用于未保存的板、不产生 marker，需要华秋定制版 KiCad）。'
          + '需要可复现的固定环境时显式指定，其余情况留空即可。',
      },
      severityAll: {
        type: 'boolean',
        description: '启用所有严重级别（error/warning/exclusion）。默认 true。',
      },
      refillZones: {
        type: 'boolean',
        description: 'DRC 前重绘填充区。默认 true。',
      },
      allTrackErrors: {
        type: 'boolean',
        description: '报告所有走线错误（不仅是第一个）。默认 false。',
      },
      drcRules: {
        type: 'string',
        description:
          'KiCad 内置规则开关，格式 "key=severity,key=severity"（severity ∈ error/warning/ignore），'
          + '如 "silk_edge_clearance=error,unconnected_items=ignore"。仅 remote 后端生效：'
          + 'pcblint 新版默认只启用被锁定的 clearance，其余内置规则关闭，需要它们的违规时必须在这里显式打开；'
          + '未提到的 key 保持服务端当前值（开关按板持久化，不传是沿用上次而非回到默认），'
          + '锁定的 key（DRU 依赖的约束类型）由服务端忽略。'
          + '只想看某几类问题时用它收窄口径，不要与 local 的全量结果直接比数字。',
      },
      includeFullJson: {
        type: 'boolean',
        description: '在输出中包含 drc.json 原始 JSON 字符串（可能很大）。默认 false；需要完整明细时传 true，或直接读取 drcJsonPath 指向的文件。',
      },
      timeoutSeconds: {
        type: 'number',
        description: `超时秒数。默认 ${defaultTimeoutSeconds}（插件配置 defaultTimeoutSeconds）。`,
      },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { type: 'number', required: true },
          timedOut: { type: 'boolean', required: true },
          elapsedMs: { type: 'number', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          kicadCliPath: {
            type: 'string',
            required: true,
            description: '本次执行使用的 kicad-cli（local 模式为可执行文件绝对路径，remote 模式为 remote:<baseUrl> 标识）。',
          },
          command: {
            type: 'string',
            required: true,
            description: '实际执行的完整命令行。',
          },
          reportFormat: {
            type: 'string',
            description:
              '报告格式：kicad-cli（kicad-cli 原生 JSON，severity 小写、按检查项分区）'
              + '或 pcblint（pcblint 语义服务，severity 大写、带 confidence/ruleId/backend）。'
              + '两种格式的违规数不可直接比较。',
          },
          reportIncomplete: {
            type: 'string',
            description:
              'reportComplete=false 时的具体原因。kicad-cli 表示服务端未执行原生检查；'
              + 'rules 表示原生检查已执行，但内置 DRC 检查项只剩锁定项参与。',
          },
          reportComplete: {
            type: 'boolean',
            description:
              '报告是否完整。值为 false 表示结果缺少 kicad-cli 原生检查中的一部分——'
              + '要么服务端根本没执行 kicad-cli（kicadDrcUsed=false），'
              + '要么内置 DRC 检查项只剩被锁定的项在参与（其余检查项未启用）。'
              + '这类报告的违规数不能当作完整 DRC 结论，也不能与 local 的条数比较。'
              + '字段缺失表示结果完整或该后端未给出可判定的口径。',
          },
          drcRules: {
            type: 'object',
            additionalProperties: true,
            description:
              '内置规则开关状态（remote 后端总是出现）：'
              + 'status=applied/observed/unsupported/failed，observed 表示没传 drcRules、只读取了当前状态；'
              + 'enabledKeys 是当前启用的全部内置规则，lockedKeys 是其中被服务端强制锁定的。'
              + '判断内置规则有没有参与判定看这两个集合，别看 drcRulesCount（它与开关无关）。'
              + 'unsupported 表示服务端太旧没有 /api/s/drc-rules 接口，开关未生效。',
          },
          drcJsonPath: {
            type: 'string',
            description:
              'drc.json 报告文件在本机持久化保存的绝对路径，与 PCB 文件同目录，'
              + '可直接读取查看完整明细。若 DRC 未生成报告，该字段不存在。',
          },
          drcSummary: {
            type: 'object',
            additionalProperties: true,
            description:
              'DRC 摘要：错误/警告数量、按类型分类、示例错误等。若未生成报告，该字段不存在。',
          },
          drcJson: {
            type: 'string',
            description:
              'drc.json 原始 JSON 字符串（可能很大，数百 KB）。仅当调用时传 includeFullJson=true 才返回；'
              + '通常只需读 drcSummary 或 drcJsonPath 指向的文件。若未生成报告，该字段不存在。',
          },
          verifiedBy: {
            type: 'object',
            additionalProperties: true,
            description:
              '本次验证实际由哪个后端执行（backend: local/remote）、端点、耗时、选择原因，'
              + '以及发生回退时的 fallbackFrom。跨后端结果不可直接比较，比较两次 DRC 前请先看本字段。',
          },
          projectRules: {
            type: 'object',
            additionalProperties: true,
            description:
              '规则口径：status=injected 表示已把工程板级约束注入会话（applied/skipped 为条数），'
              + 'skipped/failed 表示按服务端默认工程判定（线宽/间距类结论不可直接采信），'
              + 'not-applicable 表示 local/ipc 由 kicad-cli 直接读工程目录、无需注入。',
          },
          viewUrl: {
            type: 'string',
            description:
              'Web GUI 报告查看器地址（/drc-report/api/report?key=…）。'
              + '浏览器半边会自动拉取该地址并在对话尾部渲染分页报告卡片，调用方无需处理。'
              + '无 webServer 环境时该字段不存在。',
          },
        },
      },
      render: (args, value) => {
        const vb = value.verifiedBy as
          | { backend?: string; endpoint?: string; elapsedMs?: number }
          | undefined
        const backend = vb?.backend
        const summary = value.drcSummary
          ? formatSummaryText(value.drcSummary as DrcSummary)
          // ipc 正常会带回结构化结果；走到这里说明结果没取到，文案要和"没跑出报告"区分开
          : backend === 'ipc'
            ? '已在 KiCad 中执行 DRC，但没取回结构化结果（RunDrcResponse 为空），请改用 local 后端复核。'
            : 'DRC 未生成报告'
        const pathLine = value.drcJsonPath
          ? `\n\n📄 完整 DRC 报告已保存到: ${value.drcJsonPath}`
          : ''
        // 模型只能看到 render 返回的文本块，看不到结构化 verifiedBy；
        // 后端身份必须落在正文里，否则无法判断本次结果来自哪条通路（ipc / local / remote）。
        const backendLine = backend
          ? `\n\n执行后端: ${backend}${vb?.endpoint ? ` (${vb.endpoint})` : ''} · ${vb?.elapsedMs ?? '?'} ms`
          : ''
        // 规则口径同样只进结构化字段的话，模型看不见；落在正文里它才知道这批数字能不能用。
        // 只在"没按本板规则跑"时才写（injected / not-applicable 是正常情况，不必占篇幅）。
        const rules = value.projectRules as { status?: string; message?: string } | undefined
        const rulesLine = rules && (rules.status === 'skipped' || rules.status === 'failed')
          ? `\n\n⚠️ 规则口径: 未注入工程板级约束（${rules.status}${rules.message ? `：${rules.message}` : ''}），`
            + '本次按服务端默认工程判定，线宽/间距类结论不可直接采信'
          : ''
        // 结果缺半边时 drcSummary 的数字不是完整 DRC。模型基本只读摘要正文，
        // 所以这句必须放在最前面——只写进 stderr 是看不见的。
        // 两种原因要分开写：曾经合写成"kicad-cli 未执行，或内置规则只剩锁定项"，
        // 结果模型把原生检查确实跑过的情况也报成"kicad-cli 没出结果"。
        let incompleteLine = ''
        if (value.reportComplete === false) {
          incompleteLine = value.reportIncomplete === 'rules'
            ? '⚠️ 报告不完整：kicad-cli 已执行，但内置 DRC 检查项只剩被锁定的项参与（其余内置检查项默认关闭），'
              + '因此缺少这部分原生检查结果，不能当作完整 DRC 结论\n\n'
            : '⚠️ 报告不完整：服务端未执行 kicad-cli 原生检查，本次只有 pcblint 规则引擎结果，'
              + '不能当作完整 DRC 结论，也不要与 local 后端的违规数比较\n\n'
        }
        const blocks: Array<{ type: 'text'; text: string }> = [
          { type: 'text', text: incompleteLine + summary + pathLine + backendLine + rulesLine },
        ]
        // 第二块：客户端预览载荷。浏览器半边（src/client）逐块 JSON.parse 工具结果，
        // 找到 {ok:true, viewUrl} 即在该轮尾部渲染分页报告卡片。
        if (value.viewUrl) {
          blocks.push({
            type: 'text',
            text: JSON.stringify({
              ok: true,
              viewUrl: value.viewUrl,
              key: /key=([\w.-]+)$/.exec(value.viewUrl)?.[1] ?? '',
              name: typeof args.pcbPath === 'string' && args.pcbPath ? basename(args.pcbPath) : '',
            }),
          })
        }
        return blocks
      },
    },

    async execute(args, exec) {
      exec.signal.throwIfAborted()

      // mode 是自由字符串，这里收敛到合法取值，避免拼错导致静默走默认
      const mode = normalizeMode(args.mode)
      // drcRules 是 "key=severity,..." 自由字符串，同样先收敛再往下传
      const drcRuleOverrides = parseDrcRules(args.drcRules)

      let result
      try {
        result = await executor.run({
          pcbPath: args.pcbPath,
          severityAll: args.severityAll,
          refillZones: args.refillZones,
          allTrackErrors: args.allTrackErrors,
          ...(drcRuleOverrides ? { drcRuleOverrides } : {}),
          // 调用方未指定时回退到插件配置的默认超时
          timeoutSeconds: args.timeoutSeconds ?? defaultTimeoutSeconds,
          mode,
          // 工具被取消时执行器要能真的停下来（否则用户取消后进程/HTTP 还在跑）
          signal: exec.signal,
        })
      } catch (e) {
        // 把执行器错误（PCB 不存在、kicad-cli 未找到、HTTP 失败等）转成结构化输出，
        // 让 AI 能统一处理，而不是收到裸异常。
        const message = e instanceof Error ? e.message : String(e)
        return {
          success: false,
          exitCode: -1,
          timedOut: false,
          elapsedMs: 0,
          stdout: '',
          stderr: message,
          kicadCliPath: 'unknown',
          command: '',
        }
      }

      // 解析摘要
      let drcSummary: DrcSummary | null = null
      if (result.drcJson) {
        try {
          drcSummary = parseDrcSummary(result.drcJson)
        } catch { /* ignore parse errors */ }
      }

      // 注意：drcJsonPath / drcJson / drcSummary 缺失时不放入返回对象，
      // 因为 DSH 的 schema 不支持 type: ['string', 'null']，而这些字段没有 required，
      // 省略即可（AI 侧用 in 检查或可选链访问）。
      const output: KicadDrcOutput = {
        success: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        elapsedMs: result.elapsedMs,
        stdout: result.stdout,
        stderr: result.stderr,
        kicadCliPath: result.kicadCliPath,
        command: result.command,
      }
      if (result.drcJsonPath) output.drcJsonPath = result.drcJsonPath
      if (result.reportFormat) output.reportFormat = result.reportFormat
      // 两类"不完整"要显式标出来，并且区分原因：服务端没跑 kicad-cli（kicadDrcUsed=false），
      // 或原生检查跑了但内置语义规则只剩锁定项参与。两者缺的是不同的半边。
      // 判据不能用 lint-drc 的 drcRulesCount：实测它恒为固定值、与开关无关。
      const narrowedRules = onlyLockedRulesEnabled(result.drcRules)
      if (result.metrics?.kicadDrcUsed === false) {
        output.reportComplete = false
        output.reportIncomplete = 'kicad-cli'
      } else if (narrowedRules) {
        output.reportComplete = false
        output.reportIncomplete = 'rules'
      }
      if (result.drcRules) {
        output.drcRules = result.drcRules as unknown as Record<string, JsonValue>
      }
      // 默认不回传原始 JSON，避免大报告撑爆 AI 上下文；仅在显式请求时包含
      if (result.drcJson && args.includeFullJson) output.drcJson = result.drcJson
      if (drcSummary) output.drcSummary = drcSummary

      // 自适应执行器会带回来源标注；直接用单执行器时补一个最小标注，
      // 保证 AI 任何时候都知道这次结果是哪个后端跑出来的。
      const verifiedBy: VerifiedBy = result.verifiedBy
        ? { ...result.verifiedBy, reasons: [...result.verifiedBy.reasons] }
        : {
            // 兜底按端点前缀认后端：ipc 的端点是 `ipc:<版本>`，不能一律算成 local
            backend: result.kicadCliPath.startsWith('remote:')
              ? 'remote'
              : result.kicadCliPath.startsWith('ipc:') ? 'ipc' : 'local',
            endpoint: result.kicadCliPath,
            elapsedMs: result.elapsedMs,
            reasons: ['由固定后端执行（未启用自适应选择）'],
          }
      // 结构化字段里也留一条：reasons 是"为什么这个结果可信/不可信"的正式位置，
      // 有些消费方只读 verifiedBy，不看正文。
      if (output.reportComplete === false) {
        verifiedBy.reasons.push(
          result.metrics?.kicadDrcUsed === false
            ? '服务端未执行 kicad-cli 原生检查，报告仅含规则引擎结果（不完整）'
            : '内置 DRC 检查项只剩被锁定的项参与，其余检查项全部关闭，报告缺这部分原生结果（不完整）',
        )
      }
      output.verifiedBy = verifiedBy as unknown as Record<string, JsonValue>

      // 规则口径也进结构化输出：调用方/AI 要能判断这次是不是按本板规则跑的
      if (result.projectRules) {
        output.projectRules = result.projectRules as unknown as Record<string, JsonValue>
      }

      // 登记报告到 webServer 路由，供浏览器半边拉取渲染（无 webServer 时跳过）
      if (result.drcJsonPath && registerReport) {
        const key = `drc-${randomUUID()}`
        registerReport(key, result.drcJsonPath)
        output.viewUrl = `/drc-report/api/report?key=${key}`
      }

      return output
    },

    presentCall: (args) => ({
      card: 'generic',
      title: `KiCad DRC: ${args.pcbPath ?? '?'}`,
      kind: 'other',
      rawInput: args.pcbPath,
    }),
  })
}

/** 把调用方传入的 mode 收敛到合法取值；非法值退回 auto 并留一条日志。 */
function normalizeMode(raw: unknown): DrcMode {
  if (raw === 'local' || raw === 'remote' || raw === 'ipc' || raw === 'auto') return raw
  if (raw !== undefined && raw !== null && raw !== '') {
    console.warn(`[@huaqiu/dsh-kicad-drc] 未知 mode="${String(raw)}"，回退 auto`)
  }
  return 'auto'
}

/**
 * 把 drcRules 参数（"key=severity,key=severity" 自由字符串）收敛成稀疏映射。
 * 非法项跳过并留日志，而不是整份作废——AI 拼错一项时，其余项仍然生效。
 */
function parseDrcRules(raw: unknown): Record<string, DrcRuleSeverity> | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const out: Record<string, DrcRuleSeverity> = {}
  for (const part of raw.split(',')) {
    const entry = part.trim()
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq <= 0) {
      console.warn(`[@huaqiu/dsh-kicad-drc] 忽略非法 drcRules 项 "${entry}"（应为 key=error/warning/ignore）`)
      continue
    }
    const key = entry.slice(0, eq).trim()
    const severity = entry.slice(eq + 1).trim() as DrcRuleSeverity
    if (severity !== 'error' && severity !== 'warning' && severity !== 'ignore') {
      console.warn(`[@huaqiu/dsh-kicad-drc] 忽略非法 drcRules 项 "${entry}"（severity 只能是 error/warning/ignore）`)
      continue
    }
    out[key] = severity
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 后端探测工具：让 AI 在执行 DRC 前先看清有哪些后端、各自是否可用、预计多快，
 * 从而有依据地决定要不要显式指定 mode（而不是盲选或盲信默认值）。
 */
export function createBackendsTool(
  describe: () => Promise<Array<BackendHealth & { estimatedMs: number }>>,
) {
  return defineTool({
    name: BACKENDS_TOOL_NAME,
    description:
      '列出 KiCad DRC 的可用执行后端及其状态（不执行 DRC，也不产生副作用）。\n\n'
      + '返回每个后端的 available、endpoint、预计耗时 estimatedMs 与不可用原因。'
      + '典型用途：跑 DRC 前确认本机是否有可用的本地 kicad-cli；'
      + '或在上一次远程调用失败后确认它是否处于降级冷却期。'
      + '一般情况下直接调用 kicad_drc_run（mode 留空）即可，无需先调本工具。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backends: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
            description: '每个后端的状态：backend / available / endpoint / estimatedMs / reason。',
          },
        },
      },
      render: (_args, value) => {
        const rows = Array.isArray(value.backends) ? value.backends : []
        const lines = rows.map((b) => {
          const rec = b as Record<string, unknown>
          const flag = rec.available ? '可用' : '不可用'
          const extra = rec.available ? `约 ${rec.estimatedMs}ms` : String(rec.reason ?? '')
          return `  - ${rec.backend}: ${flag}（${extra}）`
        })
        return [{ type: 'text', text: ['KiCad DRC 后端状态', ...lines].join('\n') }]
      },
    },
    async execute() {
      try {
        return { backends: (await describe()) as unknown as Record<string, JsonValue>[] }
      } catch (e) {
        return {
          backends: [],
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'KiCad DRC 后端探测',
      kind: 'other',
    }),
  })
}
