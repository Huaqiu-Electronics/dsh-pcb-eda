/**
 * 宿主服务：把 DRC 能力以 **Cordis 服务**的形式提供给其它插件（当前是
 * `@huaqiu/dsh-tool-pcb-autoplacement`），而不只是给模型用的工具。
 *
 * 为什么需要这一层：
 *   自动布局的候选板评估是 3 候选并行、由插件代码自动驱动的，不经过模型，
 *   所以既不能调 `kicad_drc_run` 工具，也不能 import 执行器（那会把两个插件
 *   在运行时绑死）。宿主服务是 Cordis 里唯一干净的跨插件通道：
 *   DRC 插件 `ctx.provide('kicadDrc', service)`，布局插件 `ctx.inject(['kicadDrc'])`。
 *
 * 这一层只做三件事，不重复实现检查逻辑：
 *   1. 调自适应执行器跑一次 DRC（复用已有的后端选择与回退）
 *   2. 把两种报告格式（kicad-cli 原生 / pcblint 语义）归一成同一份违规列表
 *   3. 按区域过滤，实现"局部 DRC"
 *
 * 局部检查的真相：pcblint 服务端没有区域参数，只能整板跑完再按 `location`
 * 过滤。结果里用 `scope` 与 `outsideRegion` 如实标注，避免被当成服务端优化。
 *
 * @module
 */

import {
  ExecutorError,
  onlyLockedRulesEnabled,
  type DrcBackendName,
  type DrcMode,
  type DrcProjectRules,
  type DrcRuleOverridesResult,
  type DrcRuleSeverity,
  type DrcRuleSources,
} from './executor.ts'
import type { AdaptiveExecutor } from './adaptive-executor.ts'

/** 违规位置（PCB 坐标，毫米）。 */
export interface DrcViolationLocation {
  x: number
  y: number
}

/** 归一化后的一条违规。两种后端格式都收敛到这个形状。 */
export interface DrcViolation {
  severity: 'error' | 'warning' | 'info' | 'exclusion' | 'other'
  /** 检查项名称，如 `clearance` / `courtyards_overlap`。 */
  ruleId: string
  title: string
  message: string
  /** pcblint 的置信度（HIGH/MEDIUM/LOW）；kicad-cli 格式没有该字段。 */
  confidence?: string
  /** pcblint 的产出方（EDA_DRC / NATIVE）；kicad-cli 格式没有该字段。 */
  backend?: string
  /** 违规位置；部分条目（如整板级提示）没有明确坐标。 */
  location?: DrcViolationLocation
  /** 涉及对象的可读描述。 */
  objects: string[]
}

/** 矩形检查区域（PCB 坐标，毫米，含边界）。 */
export interface DrcRegion {
  x: number
  y: number
  width: number
  height: number
}

/** 一次检查请求。 */
export interface DrcCheckRequest {
  /** `.kicad_pcb` 绝对路径。 */
  pcbPath: string
  /**
   * 调用方冻结的工程规则源。候选板目录里没有 `.kicad_pro` 时必须由调用方提供，
   * 否则服务端会按它自己的默认工程判定，线宽/过孔/间距全错位。
   */
  ruleSources?: DrcRuleSources
  /**
   * KiCad 内置规则开关（`key → error/warning/ignore`），只对 remote 生效。
   *
   * 局部 DRC 的规则维度：服务端在解析阶段只放行「DRU 自研规则 + 显式打开的内置规则」，
   * 未打开的内置规则即使产生了违规也会被丢弃。实测默认只启用被锁定的 `clearance`
   * （`.kicad_dru` 依赖它），其余 58 条全是 `ignore`——要按 `silk_edge_clearance`、
   * `lib_footprint_issues` 这类内置项评分，必须在这里显式打开。
   * 未出现的 key 保持服务端当前值；锁定项（`locked: true`）设置会被忽略。
   */
  drcRuleOverrides?: Record<string, DrcRuleSeverity>
  /** 只看这个矩形内的违规（整板仍会完整检查，这里只过滤结果）。 */
  region?: DrcRegion
  /**
   * 指定后端。
   *
   * 默认 `auto`（remote → local → ipc），但**给了 `ruleSources` 或 `drcRuleOverrides`
   * 却没给 `mode` 时默认 `remote`**：这两个参数只有 remote 认，落到 local/ipc 会被
   * 静默丢弃——调用方以为按冻结规则判了，实际是另一套口径。宁可 remote 不可用直接
   * 报错，也不要给出一份看起来正常、口径却错了的结果。
   */
  mode?: DrcMode
  timeoutSeconds?: number
  signal?: AbortSignal
}

/** 检查结果。 */
export interface DrcCheckResult {
  /** 实际使用的后端（auto 模式下由自适应执行器决定）。 */
  backend: DrcBackendName | 'unknown'
  /** `pcblint` 或 `kicad-cli`；两种格式的违规数不能直接横比。 */
  reportFormat: string
  /** 过滤后的违规（`region` 存在时只含区域内的）。 */
  violations: DrcViolation[]
  counts: {
    error: number
    warning: number
    info: number
    other: number
    total: number
  }
  /** 检查范围：整板，或整板跑完按区域过滤。 */
  scope: 'full' | 'region'
  /** 被区域过滤掉的条数（`scope=full` 时为 0）。 */
  outsideRegion: number
  /** 没有坐标、无法判断是否在区域内而保留的条数（`scope=full` 时为 0）。 */
  unknownRegion: number
  /** 服务端按抑制规则过滤掉的条数。 */
  suppressedCount: number | null
  /** 服务端是否真的跑了 kicad-cli 原生检查（false 表示只有规则引擎结果）。 */
  kicadDrcUsed: boolean | null
  /**
   * 本次结果是否完整。
   *
   * `false` 有两个来源，都有明确证据：
   *   - `kicadDrcUsed === false`：服务端没跑 kicad-cli，结果只剩规则引擎那半边；
   *   - 内置规则里只有被锁定的项在参与（见 `onlyLockedRulesEnabled`）：
   *     kicad-cli 跑了，但用户没打开任何内置规则，结果同样缺了那部分。
   * 后端没给口径（`kicadDrcUsed: null`，或拿不到规则开关状态）按完整处理——
   * 不完整是判定出来的，不能靠猜。
   * 此时 `counts.total` 不能当作完整 DRC 结论，更不能和 local 后端的条数横比。
   * 调用方（自动布局评分）应先看这个字段。
   */
  complete: boolean
  /** 服务端实际执行的规则数。 */
  rulesExecuted: number | null
  /**
   * 本次是否按"我们这块板的规则"跑的。
   *
   * 这是结果可信度的判据：`status !== 'injected'`（且不是 local/ipc 的 not-applicable）
   * 说明检查用的是服务端默认工程，线宽/过孔/间距类结论不能直接采信。
   * 以前这件事只写在 `notes` 文本里，调用方判不了，只能人工读日志。
   */
  projectRules: DrcProjectRules
  /**
   * 本次内置规则开关的状态（remote 后端才有）。
   *
   * 没传 `drcRuleOverrides` 时也会出现，`status: 'observed'` 表示只读取了服务端
   * 当前开关集——`enabledKeys` 就是判断"内置规则有没有参与判定"的依据。
   * `status: 'unsupported'` 说明服务端太旧没有该接口，此时 `violations` 是按
   * 服务端自己的开关集跑出来的——内置规则的缺失不是因为"没有违规"。
   */
  drcRules?: DrcRuleOverridesResult
  elapsedMs: number
  /** 报告落盘路径（与 `.kicad_pcb` 同目录；remote 为 `<板名>_drc.pcblint.json`，其余为 `<板名>_drc.json`）。 */
  reportPath: string | null
  /** 执行器给的口径提示（规则注入结果、抑制数量等），原样透传。 */
  notes: string
}

/** 提供给宿主的 DRC 服务契约。 */
export interface DrcService {
  check(request: DrcCheckRequest): Promise<DrcCheckResult>
  /** 后端可用性与预估耗时；供布局插件在开始批量检查前判断能不能走远端。 */
  describe(): Promise<Array<{ backend: DrcBackendName, available: boolean, endpoint: string, reason?: string, estimatedMs: number }>>
}

/** 服务在 Cordis 里的名字。布局插件用 `ctx.inject(['kicadDrc'])` 取。 */
export const DRC_SERVICE_NAME = 'kicadDrc'

/** kicad-cli 原生报告里不是违规列表的顶层字段。 */
const NON_ISSUE_SECTIONS = new Set(['ignored_checks', 'groups'])

const SEVERITY_ALIASES: Record<string, DrcViolation['severity']> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  exclusion: 'exclusion',
  excluded: 'exclusion',
}

function normalizeSeverity(value: unknown): DrcViolation['severity'] {
  if (typeof value !== 'string') return 'other'
  return SEVERITY_ALIASES[value.toLowerCase()] ?? 'other'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asLocation(value: unknown): DrcViolationLocation | undefined {
  const rec = asRecord(value)
  if (!rec) return undefined
  const x = rec.x
  const y = rec.y
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined
}

/** pcblint 的 `message` 形如 `courtyards_overlap: Courtyards overlap`。 */
function ruleIdOf(rec: Record<string, unknown>, fallback: string): string {
  if (typeof rec.ruleId === 'string' && rec.ruleId) return rec.ruleId
  if (typeof rec.type === 'string' && rec.type) return rec.type
  const message = typeof rec.message === 'string' ? rec.message : ''
  const idx = message.indexOf(':')
  if (idx > 0) return message.slice(0, idx).trim()
  const title = typeof rec.title === 'string' ? rec.title : ''
  return title || fallback
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      const rec = asRecord(item)
      if (!rec) return undefined
      return typeof rec.description === 'string' ? rec.description : undefined
    })
    .filter((item): item is string => typeof item === 'string')
}

/** pcblint 格式：顶层 `violations` 数组，severity 大写、带 confidence/backend。 */
function violationsFromPcblint(violations: unknown[]): DrcViolation[] {
  return violations.flatMap((raw) => {
    const rec = asRecord(raw)
    if (!rec) return []
    const message = typeof rec.message === 'string' ? rec.message : ''
    const title = typeof rec.title === 'string' ? rec.title : ''
    return [{
      severity: normalizeSeverity(rec.severity),
      ruleId: ruleIdOf(rec, 'unknown'),
      title,
      message,
      ...(typeof rec.confidence === 'string' ? { confidence: rec.confidence } : {}),
      ...(typeof rec.backend === 'string' ? { backend: rec.backend } : {}),
      ...(asLocation(rec.location) ? { location: asLocation(rec.location) } : {}),
      objects: stringsOf(rec.objects),
    }]
  })
}

/** kicad-cli 格式：按检查项分区，每条的坐标在 `items[].pos`。 */
function violationsFromKicadCli(data: Record<string, unknown>): DrcViolation[] {
  const out: DrcViolation[] = []
  for (const [section, value] of Object.entries(data)) {
    if (NON_ISSUE_SECTIONS.has(section) || !Array.isArray(value)) continue
    for (const raw of value) {
      const rec = asRecord(raw)
      if (!rec) continue
      const items = Array.isArray(rec.items) ? rec.items.map((item) => asRecord(item)) : []
      const location = items
        .map((item) => (item ? asLocation(item.pos) : undefined))
        .find((pos): pos is DrcViolationLocation => pos !== undefined)
      out.push({
        severity: normalizeSeverity(rec.severity),
        ruleId: ruleIdOf(rec, section),
        title: typeof rec.type === 'string' ? rec.type : section,
        message: typeof rec.description === 'string' ? rec.description : '',
        ...(location ? { location } : {}),
        objects: items
          .map((item) => (typeof item?.description === 'string' ? item.description : undefined))
          .filter((item): item is string => typeof item === 'string'),
      })
    }
  }
  return out
}

/** 解析报告 JSON，兼容两种格式；坏数据抛错由调用方转成可读失败。 */
export function parseDrcViolations(drcJson: string): DrcViolation[] {
  const data = asRecord(JSON.parse(drcJson))
  if (!data) return []
  if (Array.isArray(data.violations)) return violationsFromPcblint(data.violations)
  return violationsFromKicadCli(data)
}

/** 点是否落在矩形内（含边界）。 */
export function inRegion(location: DrcViolationLocation, region: DrcRegion): boolean {
  return (
    location.x >= region.x &&
    location.x <= region.x + region.width &&
    location.y >= region.y &&
    location.y <= region.y + region.height
  )
}

function countViolations(violations: DrcViolation[]): DrcCheckResult['counts'] {
  const counts = { error: 0, warning: 0, info: 0, other: 0, total: violations.length }
  for (const violation of violations) {
    if (violation.severity === 'error') counts.error++
    else if (violation.severity === 'warning') counts.warning++
    else if (violation.severity === 'info') counts.info++
    else counts.other++
  }
  return counts
}

/** stdout 是执行器给的一行 JSON 摘要；解析失败不作为错误。 */
function parseStdoutSummary(stdout: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(stdout))
  } catch {
    return undefined
  }
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** notes 为空时直接给一行；有内容时换行追加。 */
function appendLine(notes: string, line: string): string {
  return notes ? `${notes}\n${line}` : line
}

export function createDrcService(adaptive: AdaptiveExecutor): DrcService {
  return {
    async describe() {
      return adaptive.describe()
    },

    async check(request) {
      if (!request.pcbPath) {
        throw new ExecutorError('DRC 检查缺少 pcbPath')
      }
      // ruleSources / drcRuleOverrides 只有 remote 认。调用方给了它们就说明要求
      // "按我给的口径判定"，此时走 auto 有概率落到 local/ipc 把规则丢掉，
      // 而调用方看不出来——所以这种情况下默认 remote，并在 notes 里说明原因。
      const remoteOnlyInputs = Boolean(request.ruleSources ?? request.drcRuleOverrides)
      const impliedRemote = remoteOnlyInputs && !request.mode

      const result = await adaptive.run({
        pcbPath: request.pcbPath,
        ...(request.ruleSources ? { ruleSources: request.ruleSources } : {}),
        ...(request.drcRuleOverrides ? { drcRuleOverrides: request.drcRuleOverrides } : {}),
        mode: request.mode ?? (impliedRemote ? 'remote' : 'auto'),
        ...(request.timeoutSeconds ? { timeoutSeconds: request.timeoutSeconds } : {}),
        // 取消必须真的传到执行器：不透传的话用户取消任务后 DRC 仍会跑完整块板
        ...(request.signal ? { signal: request.signal } : {}),
      })

      const all = result.drcJson ? parseDrcViolations(result.drcJson) : []
      const region = request.region
      let violations = all
      let outsideRegion = 0
      let unknownRegion = 0
      if (region) {
        violations = []
        for (const violation of all) {
          if (!violation.location) {
            // 没有坐标的条目无法判断归属：保留并计数，宁可多报也不漏报
            unknownRegion++
            violations.push(violation)
          } else if (inRegion(violation.location, region)) {
            violations.push(violation)
          } else {
            outsideRegion++
          }
        }
      }

      // stdout 只解析一次：三个字段拆三个 helper 会把同一行 JSON 反复 parse 三遍
      const summary = parseStdoutSummary(result.stdout)
      const metrics = result.metrics ?? {
        suppressedCount: numberOf(summary?.suppressedCount),
        kicadDrcUsed: typeof summary?.kicadDrcUsed === 'boolean' ? summary.kicadDrcUsed : null,
        rulesExecuted: numberOf(summary?.rulesExecuted),
        drcRulesCount: numberOf(summary?.drcRulesCount),
      }

      // 内置规则覆盖度只认 drc-rules 里的 enabled/locked 集合。
      // lint-drc 的 drcRulesCount 实测恒为固定值（开关 1→59→1 都不变），拿它判完整性
      // 会给出虚假的安全感，已弃用。
      const narrowedRules = onlyLockedRulesEnabled(result.drcRules)
      const enabledKeys = result.drcRules?.enabledKeys

      // 口径提示统一往 notes 追加：调用方只读结构化字段时至少还有一处能看见
      let notes = result.stderr
      if (narrowedRules) {
        notes = appendLine(notes,
          '警告: 服务端内置规则里只有被锁定的项参与判定'
          + `（${enabledKeys?.join(', ') || '无'}），其余全部关闭，结果不含这些内置规则的违规；`
          + '需要它们参与时，用 drcRuleOverrides 显式打开')
      }
      if (impliedRemote) {
        notes = appendLine(notes, '提示: 本次提供了 remote 专属参数（ruleSources/drcRuleOverrides），'
          + '未指定 mode 时按 remote 执行；要自适应选择请显式传 mode')
      }

      return {
        backend: result.verifiedBy?.backend ?? 'unknown',
        reportFormat: result.reportFormat ?? 'kicad-cli',
        violations,
        counts: countViolations(violations),
        scope: region ? 'region' : 'full',
        outsideRegion,
        unknownRegion,
        suppressedCount: metrics.suppressedCount,
        kicadDrcUsed: metrics.kicadDrcUsed,
        // null（后端没给口径）按完整处理：不完整是有明确证据的判定，不能靠猜。
        // 两类证据：kicad-cli 没跑；或内置规则只剩被锁定的那些在参与。
        complete: metrics.kicadDrcUsed !== false && !narrowedRules,
        rulesExecuted: metrics.rulesExecuted,
        elapsedMs: result.elapsedMs,
        reportPath: result.drcJsonPath,
        // local/ipc 由 kicad-cli 直接读工程目录，没有"注入"这一步；
        // 只有 remote 才会产出 projectRules，缺省按"不适用"标注，而不是"按默认参数跑了"。
        projectRules: result.projectRules ?? {
          status: 'not-applicable',
          applied: 0,
          skipped: [],
          druMerged: false,
        },
        ...(result.drcRules ? { drcRules: result.drcRules } : {}),
        notes,
      }
    },
  }
}
