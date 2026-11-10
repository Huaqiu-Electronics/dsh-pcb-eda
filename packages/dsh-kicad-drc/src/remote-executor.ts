/**
 * 远程执行器：把 `.kicad_pcb` 交给 pcblint DRC 服务（本地部署版 `E:\pcblint-local`，
 * 生产版同源），取回语义化违规列表。
 *
 * 与已废弃的 cli-runner 通道的区别（不只是换了 URL）：
 *   - 不再由客户端拼 `kicad-cli pcb drc ...` 命令，也不再上传 workDir / command / outputFiles；
 *   - 不再需要共享磁盘或静态文件服务器取回 `drc.json`，报告直接走 HTTP 响应体；
 *   - 服务端除了 kicad-cli 原生检查（backend=EDA_DRC），还跑自己的规则引擎（backend=NATIVE），
 *     每条违规带 `confidence`（HIGH/MEDIUM/LOW）与 `ruleId`，这是纯 kicad-cli 给不出来的信息。
 *
 * 因此本后端产出的报告是 **pcblint 格式**，与 local/ipc 的 kicad-cli 原生格式不同：
 * 顶层是 `violations`（severity 大写、带 confidence/backend/objects），而不是按检查项分组的数组。
 * 报告落盘时会在最前面补 `format: 'pcblint'` 与 `source`/`date`/`endpoint` 四个字段，
 * 其余字段原样保留（不裁剪、不改写），便于下游按 `format` 分支处理。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DrcAbortedError,
  ExecutorError,
  isAbortError,
  type BackendHealth,
  type DrcExecutor,
  type DrcProjectRules,
  type DrcRuleOverridesResult,
  type DrcRuleSeverity,
  type DrcRuleSources,
  type DrcRunMetrics,
  type DrcRunOptions,
  type DrcRunResult,
} from './executor.ts'
import { PcblintClient, PcblintError } from './pcblint-client.ts'
import type { PcblintLauncher } from './pcblint-launcher.ts'
import {
  buildProjectRuleSet,
  describeProjectRules,
  injectProjectDru,
  injectProjectRules,
  type ProjectRuleSet,
} from './project-rules.ts'

/**
 * 从 `.kicad_pcb` 里收集网络名。
 *
 * 网络类规则要按 **NetName** 写条件（远端没有本工程的网络类），所以需要先把
 * 类成员落到具体网络上。脚注里的 `(net N "名字")` 与焊盘引用都能覆盖到，
 * 去重即可，不必真的解析整份 S 表达式。
 */
function readPcbNetNames(pcbPath: string): string[] {
  try {
    const names = new Set<string>()
    for (const match of readFileSync(pcbPath, 'utf-8').matchAll(/\(net\s+\d+\s+"((?:[^"\\]|\\.)*)"\)/gu)) {
      const name = match[1].replace(/\\(.)/gu, '$1').trim()
      if (name && !name.startsWith('unconnected-')) names.add(name)
    }
    return [...names]
  } catch {
    return []
  }
}

/** 远程失败后的冷却时间：期间探测判为不可用，让自适应选择优先走其他后端。 */
const FAILURE_COOLDOWN_MS = 60_000

/** 健康检查超时：探活不能拖慢 auto 模式的选路。 */
const HEALTH_TIMEOUT_MS = 3_000

/** 落盘的报告格式标识。 */
const REPORT_FORMAT = 'pcblint'

/** 工程规则注入的结果（决定要不要在结果里标注口径）。 */
type ProjectRuleInjection =
  | { status: 'absent' }
  | { status: 'skipped', message: string }
  | { status: 'injected', set: ProjectRuleSet, dru?: boolean }
  | { status: 'failed', message: string }

/**
 * 内部注入结果 → 对外字段。
 *
 * 内部要拿 `set` 拼 notes（人读的文本），对外只给可判定的状态与计数，
 * 两边各自需要的粒度不同，所以留一层映射而不是直接把内部结构抛出去。
 */
function toPublicRules(injection: ProjectRuleInjection): DrcProjectRules {
  if (injection.status === 'injected') {
    return {
      status: 'injected',
      source: injection.set.source,
      applied: injection.set.applied.length,
      skipped: injection.set.skipped.map((item) => item.key),
      druMerged: injection.dru === true,
    }
  }
  return {
    status: injection.status,
    applied: 0,
    skipped: [],
    druMerged: false,
    ...('message' in injection ? { message: injection.message } : {}),
  }
}

export interface RemoteExecutorOptions {
  /** pcblint 服务根地址。留空且提供 launcher 时走本地托管（默认）。 */
  baseUrl?: string
  /**
   * 本地托管器：由它按需启动服务。
   *
   * 提供后 `run()` 会用本次实际端口重建客户端，并在结束时 `release()`；
   * `probe()` 只读托管状态，绝不拉起 JVM。
   */
  launcher?: PcblintLauncher
  /** `x-token`；本地免鉴权部署可留空。 */
  token?: string
  /** 注入 fetch，便于单测。 */
  fetchImpl?: typeof fetch
}

export class RemoteExecutor implements DrcExecutor {
  readonly name = 'remote' as const
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl?: typeof fetch
  private readonly launcher?: PcblintLauncher
  /** 最近一次失败的时间戳（用于冷却期内降级，避免每次都等 HTTP 超时）。 */
  private lastFailureAt = 0

  constructor(opts: RemoteExecutorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '')
    this.token = opts.token?.trim() ?? ''
    if (opts.fetchImpl) this.fetchImpl = opts.fetchImpl
    if (opts.launcher) this.launcher = opts.launcher
  }

  /** 按本次实际地址新建客户端：托管模式的端口每次启动都可能不同。 */
  private createClient(baseUrl: string): PcblintClient {
    return new PcblintClient({
      baseUrl,
      ...(this.token ? { token: this.token } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    })
  }

  /**
   * 探测 pcblint 服务可用性。
   *
   * 托管模式（有 launcher）只读状态：组件就绪即返回可用，写明"按需启动"，
   * **绝不在这里拉起 JVM**——插件加载 1.5s 后会调 `describe()`，若探活启动服务，
   * 每开一次 DSH 就多一个常驻进程，正好违背按需目标。
   *
   * 外部固定服务模式保持原有行为：真发一次 `/api/s/health`。探活成本很低，
   * 而误判可用的代价是一次完整上传 + DRC（数秒）。
   */
  async probe(): Promise<BackendHealth> {
    if (Date.now() - this.lastFailureAt < FAILURE_COOLDOWN_MS) {
      return {
        backend: 'remote',
        available: false,
        endpoint: this.launcher?.baseUrl || this.baseUrl,
        reason: '最近一次远程调用失败，冷却期内降级',
      }
    }
    if (this.launcher) {
      const state = this.launcher.describe()
      if (!state.available) {
        return {
          backend: 'remote',
          available: false,
          endpoint: state.baseUrl ?? state.home,
          reason: state.reason,
        }
      }
      // 未运行但具备启动条件：表示"可以启动"，不是"已经在线"
      if (!state.running || !state.baseUrl) {
        return { backend: 'remote', available: true, endpoint: state.home, reason: state.reason }
      }
      return this.checkHealth(state.baseUrl, state.version)
    }
    if (!this.baseUrl) {
      return {
        backend: 'remote',
        available: false,
        endpoint: '',
        reason: '未配置 pcblintBaseUrl，也未启用本地托管',
      }
    }
    return this.checkHealth(this.baseUrl)
  }

  /**
   * 对指定地址真发健康检查，并顺手带上 kicad-cli 配置口径。
   *
   * `expectedVersion` 来自托管组件的 `version.txt`：安装包升级了 jar 但
   * `version.txt` 没同步（或反过来）时，参数/接口可能已经不匹配，必须提前告警。
   */
  private async checkHealth(baseUrl: string, expectedVersion?: string): Promise<BackendHealth> {
    const client = this.createClient(baseUrl)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS)
    try {
      const health = await client.health(ctrl.signal)
      if (!health.ok) {
        this.lastFailureAt = Date.now()
        return { backend: 'remote', available: false, endpoint: baseUrl, reason: 'pcblint 健康检查未通过' }
      }
      // 探测成功即清冷却：否则一次瞬时失败会让之后 60s 内一直报"不可用"，
      // 哪怕服务其实早就恢复了，自适应选择会被这条过期状态带去走 local。
      this.lastFailureAt = 0
      let suffix = ''
      if (expectedVersion && health.version && expectedVersion !== health.version) {
        const mismatch = `组件版本 ${expectedVersion} 与服务端 ${health.version} 不一致`
        console.warn(`[@huaqiu/dsh-kicad-drc] PCBLint ${mismatch}，可能存在参数/接口不匹配`)
        suffix = ` · ⚠️ ${mismatch}`
      }
      // 顺手问一次 kicad-cli 状态，写进 reason：服务在线但 kicad-cli 跑不起来时，
      // remote 的结果只有规则引擎那半边，AI/调用方看 reason 就能预判口径。
      //
      // 注意不能把 available 翻译成"可用"：它只代表服务端配了 runner。实测
      // `start.bat` 里 KICAD_CLI 指向不存在的路径时，服务端照样回 available=true。
      // 所以这里只展示配置内容；服务在本机时再顺手验一下路径是否存在。
      try {
        const status = await client.drcStatus(ctrl.signal)
        if (!status.available) {
          suffix += ' · ⚠️ 服务端未配置 kicad-cli'
        } else {
          const configured = /kicad-cli at ([^)]+)/u.exec(status.cliRunnerUrl ?? '')?.[1]?.trim()
          if (!configured) {
            suffix += ' · kicad-cli 已配置'
          } else {
            // 只有本机部署才能验路径：远端服务上的路径在本地当然不存在
            const isLocal = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|$)/u.test(baseUrl)
            const missing = isLocal && !existsSync(configured)
            suffix += missing
              ? ` · ⚠️ kicad-cli 路径本机不存在（${configured}），结果将只有规则引擎`
              : ` · kicad-cli 配置: ${configured}`
          }
        }
      } catch { /* 旧版没有该接口或响应异常：不影响可用性判定 */ }
      return {
        backend: 'remote',
        available: true,
        endpoint: baseUrl,
        reason: `pcblint ${health.version ?? ''} 在线${suffix}`.trim(),
      }
    } catch (e) {
      this.lastFailureAt = Date.now()
      const message = e instanceof Error ? e.message : String(e)
      return { backend: 'remote', available: false, endpoint: baseUrl, reason: message }
    } finally {
      clearTimeout(timer)
    }
  }

  async run(options: DrcRunOptions): Promise<DrcRunResult> {
    const start = performance.now()
    const pcbPath = resolve(options.pcbPath)
    if (!existsSync(pcbPath)) {
      throw new ExecutorError(`PCB 文件不存在: ${pcbPath}`)
    }
    // 先校验板文件，再按需启动服务：为一个不存在的文件白起 JVM 没有意义
    const baseUrl = await this.openService(options.signal)
    try {
      return await this.runOnService(baseUrl, pcbPath, options, start)
    } finally {
      // 引用计数归零后由托管器决定何时停止；外部服务不归这里管
      this.launcher?.release()
    }
  }

  /** 本次实际服务地址：托管模式按需启动，外部模式直接用配置。 */
  private async openService(signal?: AbortSignal): Promise<string> {
    if (!this.launcher) {
      if (!this.baseUrl) {
        throw new ExecutorError('未配置 pcblintBaseUrl，也未启用本地托管，remote 后端不可用')
      }
      return this.baseUrl
    }
    try {
      return await this.launcher.ensureUp(signal)
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new DrcAbortedError()
      if (error instanceof ExecutorError) throw error
      throw new ExecutorError(`PCBLint 本地服务启动失败: ${(error as Error).message}`)
    }
  }

  /** 在指定服务地址上完成一次「上传 → 注入规则 → DRC → 落盘」。 */
  private async runOnService(
    baseUrl: string,
    pcbPath: string,
    options: DrcRunOptions,
    start: number,
  ): Promise<DrcRunResult> {
    const client = this.createClient(baseUrl)
    const fileName = basename(pcbPath)
    const bytes = readFileSync(pcbPath)
    const timeoutSeconds = options.timeoutSeconds ?? 600

    // 超时与调用方取消是两个来源，合成一个信号往下传：
    // 只用自己的定时器会漏掉调用方的取消（任务被取消后 DRC 仍跑完 13s+，
    // 而服务端是串行队列，后面排队的候选只能干等）。
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutSeconds * 1000)
    const signal = options.signal
      ? AbortSignal.any([timeoutCtrl.signal, options.signal])
      : timeoutCtrl.signal

    let lint
    let upload
    let injection: ProjectRuleInjection = { status: 'absent' }
    let drcRuleState: DrcRuleOverridesResult | undefined
    try {
      // 不能再用 client.run：必须在 upload 与 lint 之间把工程规则写进会话
      upload = await client.upload(fileName, bytes, signal)
      injection = await this.injectProjectRules(
        client,
        pcbPath,
        upload.sessionToken,
        signal,
        options.ruleSources,
      )
      drcRuleState = await this.syncDrcRules(
        client,
        upload.sessionToken,
        options.drcRuleOverrides,
        signal,
      )
      lint = await client.lintDrc(upload.sessionToken, signal)
    } catch (e) {
      // 取消不是失败：不进冷却期（否则取消一次就把 remote 下线一分钟），也不重试
      if (options.signal?.aborted) throw new DrcAbortedError()
      this.lastFailureAt = Date.now()
      if (timeoutCtrl.signal.aborted) {
        throw new ExecutorError(`pcblint 调用超时（${timeoutSeconds}s）: ${baseUrl}`)
      }
      if (e instanceof PcblintError) throw new ExecutorError(e.message)
      throw new ExecutorError(`pcblint 调用失败: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
    }

    // 跑通一次就说明服务可用：清掉冷却标记，别让一次瞬时失败继续影响后续探测
    this.lastFailureAt = 0

    const violations = Array.isArray(lint.violations) ? lint.violations : []

    // 报告落盘：与 .kicad_pcb 同目录。文件名带格式后缀，避免与 local/ipc 的
    // <pcb名>_drc.json 互相覆盖——同一块板换后端跑一次，两个报告要能同时存在，
    // 否则 drcJsonPath/viewUrl 指向的文件会被后一次覆盖成另一个格式。
    const pcbStem = fileName.replace(/\.kicad_pcb$/i, '')
    const pcbDir = dirname(pcbPath)
    const reportPath = join(pcbDir, `${pcbStem}_drc.${REPORT_FORMAT}.json`)
    const report = {
      format: REPORT_FORMAT,
      source: fileName,
      date: new Date().toISOString(),
      endpoint: baseUrl,
      ...lint,
    }
    const drcJson = JSON.stringify(report, null, 2)

    let drcJsonPath: string | null = null
    try {
      mkdirSync(pcbDir, { recursive: true })
      writeFileSync(reportPath, drcJson, 'utf-8')
      drcJsonPath = reportPath
      console.log(`[@huaqiu/dsh-kicad-drc] pcblint 报告已持久化: ${reportPath}`)
    } catch (e) {
      console.warn(`[@huaqiu/dsh-kicad-drc] 写入本地报告失败: ${(e as Error).message}`)
    }

    // stderr 只放"结果口径"提示：哪些检查没跑、哪些被过滤，避免被当成完整 DRC 结论。
    const notes: string[] = []
    if (lint.kicadDrcUsed === false) {
      notes.push(
        '警告: 服务端未执行 kicad-cli 原生检查（kicadDrcAvailable='
        + `${String(lint.kicadDrcAvailable)}），本次只有 pcblint 规则引擎结果，`
        + '不能与本地 kicad-cli 的违规数直接比较',
      )
    }
    if (typeof lint.suppressedCount === 'number' && lint.suppressedCount > 0) {
      notes.push(`提示: 服务端按抑制规则过滤掉 ${lint.suppressedCount} 条违规`)
    }
    if (injection.status === 'injected') {
      if (injection.set.applied.length > 0) {
        notes.push(describeProjectRules(injection.set))
      }
      if (injection.dru) {
        notes.push(
          injection.set.applied.length > 0
            ? '提示: 工程自带的 .kicad_dru 也已合并进会话规则'
            : '工程自带的 .kicad_dru 已合并进会话规则（本次没有板级约束可注入）',
        )
      }
      if (injection.set.skipped.length > 0) {
        notes.push(
          `提示: ${injection.set.skipped.length} 项工程约束未注入（沿用服务端默认值）: `
          + injection.set.skipped.map((s) => s.key).join(', '),
        )
      }
    } else if (injection.status === 'failed') {
      notes.push(
        '警告: 找不到/无法应用工程规则文件，本次按服务端默认工程判定，'
        + `线宽/过孔/间距类结果可能与本地 kicad-cli 不同（${injection.message}）`,
      )
    } else if (injection.status === 'skipped') {
      notes.push(`提示: ${injection.message}，本次按服务端默认工程判定`)
    }
    if (drcRuleState) {
      if (drcRuleState.status === 'applied') {
        notes.push(
          `提示: 已保存 KiCad 内置规则开关（${drcRuleState.keys.join(', ')}），`
          + `服务端当前启用 ${drcRuleState.enabledCount ?? '?'} 条内置规则，`
          + '结果只含已启用内置规则的违规 + pcblint 自研规则',
        )
      } else if (drcRuleState.status === 'observed') {
        // 没给开关时也如实说明覆盖度：默认只启用被锁定的那几条，
        // 不点出来的话调用方会以为内置规则都参与了判定。
        const enabled = drcRuleState.enabledKeys ?? []
        const locked = new Set(drcRuleState.lockedKeys ?? [])
        const userEnabled = enabled.filter((key) => !locked.has(key))
        if (userEnabled.length === 0) {
          notes.push(
            `提示: 服务端当前只启用了被锁定的内置规则（${enabled.join(', ') || '无'}），`
            + '其余内置规则全部关闭；要它们参与判定，用 drcRuleOverrides 显式打开',
          )
        }
      } else if (drcRuleState.status === 'unsupported') {
        notes.push(
          `警告: 服务端没有校验开关接口（${drcRuleState.message ?? ''}），`
          + '内置规则开关未生效，结果按服务端当前开关集返回',
        )
      } else {
        notes.push(
          `警告: 内置规则开关写入失败（${drcRuleState.message ?? ''}），`
          + '结果按服务端当前开关集返回',
        )
      }
    }

    const stdout = JSON.stringify({
      service: 'pcblint',
      endpoint: baseUrl,
      sessionReused: upload.reused === true,
      kicadDrcUsed: lint.kicadDrcUsed ?? null,
      rulesExecuted: lint.rulesExecuted ?? null,
      suppressedCount: lint.suppressedCount ?? null,
      violations: violations.length,
      projectRules: injection.status,
      ...(drcRuleState
        ? {
            drcRulesStatus: drcRuleState.status,
            drcRulesEnabled: drcRuleState.enabledCount,
            drcRulesEnabledKeys: drcRuleState.enabledKeys ?? null,
          }
        : {}),
      drcRulesCount: lint.drcRulesCount ?? null,
      ...(injection.status === 'injected'
        ? {
            projectRulesSource: injection.set.source,
            projectRuleConstraints: injection.set.applied.length,
            projectDruMerged: injection.dru === true,
          }
        : {}),
    })

    // 口径指标同时给结构化和 stdout 两份：stdout 是历史字段（日志/工具输出在用），
    // 结构化字段给程序判定用，避免消费方去 parse 那行 JSON。
    const metrics: DrcRunMetrics = {
      suppressedCount: typeof lint.suppressedCount === 'number' ? lint.suppressedCount : null,
      kicadDrcUsed: typeof lint.kicadDrcUsed === 'boolean' ? lint.kicadDrcUsed : null,
      rulesExecuted: typeof lint.rulesExecuted === 'number' ? lint.rulesExecuted : null,
      drcRulesCount: typeof lint.drcRulesCount === 'number' ? lint.drcRulesCount : null,
    }

    return {
      exitCode: 0,
      stdout,
      stderr: notes.join('\n'),
      drcJson,
      elapsedMs: Math.round(performance.now() - start),
      timedOut: false,
      kicadCliPath: `remote:${baseUrl}`,
      command: `POST ${baseUrl}/api/s/upload → POST ${baseUrl}/api/s/lint-drc (${fileName})`,
      drcJsonPath,
      reportFormat: REPORT_FORMAT,
      projectRules: toPublicRules(injection),
      ...(drcRuleState ? { drcRules: drcRuleState } : {}),
      metrics,
    }
  }

  /**
   * 把工程板级约束写进会话规则文件。
   *
   * 规则来源有两种，优先级从高到低：
   *   1. `options.ruleSources.projectFile`：调用方冻结的 `.kicad_pro` 内容
   *      （自动布局的候选板目录里没有 `.kicad_pro`，只能这样传）
   *   2. 与 `.kicad_pcb` 同目录的 `.kicad_pro`（agent 手动跑 DRC 的常规情况）
   *
   * 另外，`options.ruleSources.drcFile`（工程自带的 `.kicad_dru`）会追加在
   * 板级约束块之前：会话里已有的服务端语义规则保留不动，工程自定义规则叠加。
   *
   * 失败不致命：没有规则源、JSON 坏了、接口不支持，都退回"服务端默认工程"，
   * 只在结果里标注口径——DRC 本身照常跑完，不会因为规则注入失败而没有结论。
   */
  private async injectProjectRules(
    client: PcblintClient,
    pcbPath: string,
    sessionToken: string,
    signal?: AbortSignal,
    ruleSources?: DrcRuleSources,
  ): Promise<ProjectRuleInjection> {
    let projectText: string | undefined
    let sourceName: string
    if (ruleSources?.projectFile) {
      projectText = ruleSources.projectFile
      sourceName = ruleSources.name ?? 'inline'
    } else {
      const proPath = pcbPath.replace(/\.kicad_pcb$/i, '.kicad_pro')
      if (existsSync(proPath)) {
        projectText = readFileSync(proPath, 'utf-8')
        sourceName = basename(proPath)
      } else {
        // 只有 .kicad_dru 时也要注入，此时没有板级约束可用
        projectText = undefined
        sourceName = ruleSources?.name ?? 'inline'
      }
    }

    let set: ProjectRuleSet = { source: sourceName, applied: [], skipped: [], block: '' }
    if (projectText !== undefined) {
      try {
        set = buildProjectRuleSet(projectText, sourceName, readPcbNetNames(pcbPath))
      } catch (e) {
        return { status: 'failed', message: e instanceof Error ? e.message : String(e) }
      }
    }
    if (set.applied.length === 0 && !ruleSources?.drcFile) {
      return { status: 'skipped', message: `${set.source} 里没有可注入的板级约束` }
    }

    try {
      // 先读再写：服务端按板分类生成的语义规则（ic_keepout 等）必须保留
      const current = await client.getDru(sessionToken, signal)
      // 顺序不能反：KiCad 后出现的规则覆盖先出现的，工程自定义规则必须最后写入
      const withRules = injectProjectRules(current.content, set)
      await client.putDru(sessionToken, injectProjectDru(withRules, ruleSources?.drcFile), signal)
      return { status: 'injected', set, ...(ruleSources?.drcFile?.trim() ? { dru: true } : {}) }
    } catch (e) {
      // 取消不是"注入失败"：吞掉会带着已中止的信号继续跑 lint。
      // 用 signal.aborted 判断，因为 AbortError 已被 PcblintClient 包装过。
      if (signal?.aborted) throw e
      return { status: 'failed', message: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 读取（必要时写入）服务端的 KiCad 内置规则开关状态。
   *
   * 两种情况：
   *   - 调用方给了 `overrides` → PUT 写入，响应即写入后的最新状态；
   *   - 没给 → GET 纯读取。
   *
   * 为什么没给也要读：`complete` 判定需要知道"内置规则到底有没有参与本次判定"。
   * lint-drc 返回的 `drcRulesCount` 实测恒为固定值（59 条规则的开关从 1 → 59 → 1
   * 依次改过，它一直是 6），不能当判据；只有这里的 enabled/locked 集合可信。
   *
   * 失败都不致命，只标注不中断：
   *   - 旧版服务没有该接口（404）→ `unsupported`，结果按服务端当前开关集返回；
   *   - 读取/写入失败 → `failed`，同上。
   *   开关是"收窄口径"，不是 DRC 的前提。
   *
   * 注意 404 的识别方式：`PcblintClient.request` 把 HTTP 状态码拼进错误 message，
   * 这里靠正则取回。够用（状态码有独立空格边界），不值得为此改 request 的返回结构。
   */
  private async syncDrcRules(
    client: PcblintClient,
    sessionToken: string,
    overrides: Record<string, DrcRuleSeverity> | undefined,
    signal?: AbortSignal,
  ): Promise<DrcRuleOverridesResult | undefined> {
    const keys = overrides ? Object.keys(overrides) : []
    const write = keys.length > 0
    try {
      const state = write
        ? await client.putDrcRules(sessionToken, overrides as Record<string, DrcRuleSeverity>, signal)
        : await client.getDrcRules(sessionToken, signal)
      const rules = Array.isArray(state.rules) ? state.rules : []
      const enabledRules = rules.filter((rule) => rule.enabled)
      return {
        status: write ? 'applied' : 'observed',
        keys,
        enabledCount: enabledRules.length,
        enabledKeys: enabledRules.map((rule) => rule.key),
        lockedKeys: rules.filter((rule) => rule.locked).map((rule) => rule.key),
      }
    } catch (e) {
      // 取消必须往上抛：吞掉会带着已中止的信号继续往下跑 lint。
      // 判据用 signal.aborted 而不是 e.name——PcblintClient 会把 AbortError
      // 包装成 PcblintError，靠错误类型/名字判断会漏。
      if (signal?.aborted) throw e
      const message = e instanceof Error ? e.message : String(e)
      const status: DrcRuleOverridesResult['status'] = /\b404\b/u.test(message)
        ? 'unsupported'
        : 'failed'
      return { status, keys, enabledCount: null, message }
    }
  }
}
