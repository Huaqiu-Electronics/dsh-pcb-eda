/**
 * DSH 插件入口：KiCad DRC 工具。
 *
 * 在 Host 端注册 kicad_drc_run 工具，AI agent 可调用它对 .kicad_pcb 文件
 * 执行 DRC 检查并获取结构化结果。
 *
 * 两个后端，由 AdaptiveExecutor 在运行时选择（mode=auto 时的默认行为）：
 *   - local:  当前机器 subprocess 调 kicad-cli（需本地安装 KiCad），
 *             默认用隔离的 KICAD_CONFIG_HOME 规避 ~5s 的默认配置发现开销
 *   - remote: HTTP 上传到 pcblint DRC 服务（本地部署版 E:\pcblint-local，生产版同源），
 *             由服务端做语义规则引擎 + 本地 kicad-cli 原生检查后合并返回；
 *             本机无需 KiCad，但只上传单个 .kicad_pcb，工程级规则（.kicad_pro）带不过去
 *
 * 选择依据：可用性 → 预期耗时 → 工程规则完整性；失败自动回退，
 * 并把实际后端写进结果的 verifiedBy 字段。
 *
 * @module @huaqiu/dsh-kicad-drc
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import pkg from '../package.json'
import { LocalExecutor, resolveConfigHome, resolveKicadCli } from './local-executor.ts'
import { RemoteExecutor } from './remote-executor.ts'
import { AdaptiveExecutor } from './adaptive-executor.ts'
import { KicadIpcExecutor } from './kicad-ipc-executor.ts'
import { PcblintLauncher } from './pcblint-launcher.ts'
import { resolvePcblintInstallation, PCBLINT_HOME_ENV } from './pcblint-installation.ts'
import { resolveIpcPython, resolvePcblintDataRoot, IPC_PYTHON_ENV } from './config.ts'
import { createDrcTool, createBackendsTool, TOOL_NAME, BACKENDS_TOOL_NAME } from './tools.ts'
import { createReportRegistry, createDrcReportHandler } from './web-routes.ts'
import { createDrcService, DRC_SERVICE_NAME } from './service.ts'
import type { DrcExecutor, DrcMode, DrcBackendName } from './executor.ts'

/** 插件版本号（唯一来源：package.json），启动时打印用于确认生效版本。 */
const PLUGIN_VERSION = pkg.version

export { createDrcTool, createBackendsTool, TOOL_NAME, BACKENDS_TOOL_NAME } from './tools.ts'
export { LocalExecutor, resolveKicadCli, buildChildEnv, resolveConfigHome } from './local-executor.ts'
export { RemoteExecutor } from './remote-executor.ts'
export { KicadIpcExecutor } from './kicad-ipc-executor.ts'
export { AdaptiveExecutor, rankBackends } from './adaptive-executor.ts'
export { PcblintLauncher, buildPcblintJavaArgs, findFreePort } from './pcblint-launcher.ts'
export type { PcblintLauncherOptions, PcblintLauncherState } from './pcblint-launcher.ts'
export {
  resolvePcblintInstallation,
  inspectPcblintHome,
  PCBLINT_HOME_ENV,
} from './pcblint-installation.ts'
export type { PcblintInstallation } from './pcblint-installation.ts'
export { resolveIpcPython, resolvePcblintDataRoot, IPC_PYTHON_ENV, HQ_EDGE_HOME_ENV } from './config.ts'
export type { RankedCandidate, RankInput, VerifiedBy } from './adaptive-executor.ts'
export { parseDrcSummary, formatSummaryText } from './drc-summary.ts'
export {
  createDrcService,
  parseDrcViolations,
  inRegion,
  DRC_SERVICE_NAME,
} from './service.ts'
export type {
  DrcCheckRequest,
  DrcCheckResult,
  DrcRegion,
  DrcService,
  DrcViolation,
  DrcViolationLocation,
} from './service.ts'
export type { DrcRuleSources } from './executor.ts'
export { DrcAbortedError, ExecutorError, isAbortError } from './executor.ts'
export type {
  BackendHealth,
  DrcBackendName,
  DrcExecutor,
  DrcMode,
  DrcProjectRules,
  DrcProjectRulesStatus,
  DrcRunMetrics,
  DrcRunOptions,
  DrcRunResult,
} from './executor.ts'
export type { DrcSummary, JsonValue } from './drc-summary.ts'

/** 插件配置。 */
export interface Config {
  /** 默认执行模式：auto 自动选择，local / remote / ipc 强制指定。 */
  executorMode: DrcMode
  /**
   * auto 模式下的后端优先顺序（越靠前越优先），默认 remote → local → ipc。
   * remote 不可用或执行失败时才降级，失败回退由自适应执行器完成。
   */
  backendPriority: DrcBackendName[]
  /** 本地模式：kicad-cli 路径，留空自动探测。 */
  kicadCliPath: string
  /** 本地模式：是否用隔离的 KICAD_CONFIG_HOME（实测省 ~5s，但拿不到全局封装库表）。 */
  isolatedConfig: boolean
  /**
   * kicad-ipc 后端使用的 Python 解释器绝对路径（需装 `kipy`）。
   * 留空则读环境变量 `DSH_KICAD_DRC_PYTHON`，再兜底 `python3`。
   * 与 `@huaqiu/dsh-kicad` 的 `DSH_KICAD_PYTHON` 刻意分开：两个插件可能部署在不同机器、
   * 对着不同 KiCad 版本，共用一份解释器配置会让独立部署变得不可能。
   */
  ipcPythonPath: string
  /** 远程模式：pcblint DRC 服务地址（`/api/s/upload` + `/api/s/lint-drc`）。
   *  留空 = 托管随 KiCad 分发的 `pcblint-local`（随机回环端口、按需启停）；
   *  非空 = 外部固定服务（只连接，绝不结束该进程）。 */
  pcblintBaseUrl: string
  /** 托管模式：组件安装目录覆盖（`...\bin\pcblint-local`）。
   *  留空则读 `DSH_PCBLINT_HOME`，再回退到 kicad-cli 同级的 `pcblint-local`。 */
  pcblintHome: string
  /** 托管模式：冷启动等待上限（毫秒）。Spring Boot + H2 首次建库可能 20–40s。 */
  pcblintStartupTimeoutMs: number
  /** 托管模式：空闲关闭时间（毫秒）；0 = 每次用完立即关闭。 */
  pcblintIdleTimeoutMs: number
  /** 托管模式：追加 JVM 参数（空白分隔），如 `-Xmx1536m`。 */
  pcblintJavaOptions: string
  /** 远程模式：`x-token` 鉴权令牌。生产环境必填；本地部署开了
   *  `pcblint.auth.local-bypass` 时留空即可。 */
  pcblintToken: string
  /** DRC 默认超时秒数。 */
  defaultTimeoutSeconds: number
}

/**
 * 运行时配置校验和默认值。
 *
 * 形状以上面的 `Config` 接口为准，这里只负责运行时的默认值与校验。
 *
 * 为什么要 `as unknown as`：schemastery 3.18.4 起 `Schema` 多了第三个类型参数
 * （`default()` 之后变成 `defined`），`Schema<Config>`（`plain`）与 `.default()`
 * 推导出的类型在 `meta.default` 上不兼容；本仓库同时装着 3.18.2（本包）与 3.18.5
 * （cordis 依赖），两份全局 `Schemastery` 声明会合并，写死 `Schema<Config>` 时
 * `pnpm typecheck` 报错、不写死又会让 dts 生成失败（推导类型引用到另一份私有路径）。
 * 两害相权，这里显式标注并断言，保证 typecheck 与声明产物都干净。
 */
export const Config: Schema<Config> = Schema.object({
  executorMode: Schema.union(['auto', 'local', 'remote', 'ipc'] as const).default('auto'),
  backendPriority: Schema.array(Schema.union(['remote', 'local', 'ipc'] as const))
    .default(['remote', 'local', 'ipc']),
  kicadCliPath: Schema.string().default(''),
  isolatedConfig: Schema.boolean().default(true),
  ipcPythonPath: Schema.string().default(''),
  pcblintBaseUrl: Schema.string().default(''),
  pcblintHome: Schema.string().default(''),
  pcblintStartupTimeoutMs: Schema.number().default(90_000),
  pcblintIdleTimeoutMs: Schema.number().default(60_000),
  pcblintJavaOptions: Schema.string().default(''),
  pcblintToken: Schema.string().default(''),
  defaultTimeoutSeconds: Schema.number().default(600),
}) as unknown as Schema<Config>

/** 插件名，Cordis 会显示。 */
export const name = '@huaqiu/dsh-kicad-drc'

/** 依赖的 DSH 服务（webServer 用于 /drc-report 报告查看路由；headless 环境缺失时自动降级）。 */
export const inject = ['tools', 'webServer']

/**
 * 插件入口：构建全部后端、装配自适应执行器并注册工具。
 */
export function apply(ctx: Context, config: Config): void {
  console.log(`[@huaqiu/dsh-kicad-drc] 插件版本: ${PLUGIN_VERSION}`)

  const configHome = resolveConfigHome(config.isolatedConfig)

  // kicad-ipc 后端（第二阶段）要用的解释器。这里先解析并打印，便于部署时确认配置生效；
  // 未配置且未设环境变量时不打印，避免每条启动日志都出现无关信息。
  const ipcPython = resolveIpcPython(config.ipcPythonPath)
  if (config.ipcPythonPath || process.env[IPC_PYTHON_ENV]) {
    console.log(`[@huaqiu/dsh-kicad-drc] kicad-ipc Python 解释器: ${ipcPython}`)
  }

  // 两个后端都构建：mode 可以按次覆盖默认模式，所以本地/远程都需要在场。
  const local = new LocalExecutor(config.kicadCliPath || undefined, { configHome })

  // pcblintBaseUrl 为空 = 托管随 KiCad 分发的组件；非空 = 外部固定服务（只连接，不结束进程）。
  const managedPcblint = config.pcblintBaseUrl.trim() === ''
  const pcblintDataRoot = resolvePcblintDataRoot()
  let launcher: PcblintLauncher | undefined
  let launcherError: string | undefined
  if (managedPcblint) {
    try {
      launcher = new PcblintLauncher({
        // 惰性解析：定位 kicad-cli 的最后一级是全盘搜索，不能放在插件加载的同步路径
        resolveInstallation: () => resolvePcblintInstallation({
          configuredHome: config.pcblintHome,
          // 已显式指定组件目录时无需再定位 kicad-cli
          kicadCliPath: config.pcblintHome.trim()
            ? undefined
            : resolveKicadCli(config.kicadCliPath || undefined),
        }),
        dataRoot: pcblintDataRoot,
        ...(config.kicadCliPath ? { kicadCliPath: config.kicadCliPath } : {}),
        resolveKicadCli: () => resolveKicadCli(),
        startupTimeoutMs: config.pcblintStartupTimeoutMs,
        idleTimeoutMs: config.pcblintIdleTimeoutMs,
        ...(config.pcblintJavaOptions.trim() ? { javaOptions: config.pcblintJavaOptions } : {}),
      })
    } catch (e) {
      // 配置错误不该让整个插件加载失败：remote 判不可用，auto 自动降级 local
      launcherError = e instanceof Error ? e.message : String(e)
      console.warn(`[@huaqiu/dsh-kicad-drc] PCBLint 托管配置无效: ${launcherError}`)
    }
  }

  const remote = new RemoteExecutor({
    ...(launcher ? { launcher } : { baseUrl: config.pcblintBaseUrl }),
    token: config.pcblintToken,
  })

  // 托管进程必须跟着插件生命周期：卸载时停止，宿主 exit 时同步结束（来不及等异步）
  if (launcher) {
    const owned = launcher
    const onHostExit = (): void => { owned.disposeSync() }
    process.once('exit', onHostExit)
    ctx.effect(() => () => {
      process.removeListener('exit', onHostExit)
      void owned.dispose().catch((e: unknown) => {
        console.warn(
          `[@huaqiu/dsh-kicad-drc] 释放 PCBLint 服务失败: ${e instanceof Error ? e.message : String(e)}`,
        )
      })
    }, '@huaqiu/dsh-kicad-drc: pcblint launcher')
  }

  const backends: DrcExecutor[] = [local, remote, new KicadIpcExecutor(ipcPython)]
  const adaptive = new AdaptiveExecutor(backends, {
    defaultMode: config.executorMode,
    priority: config.backendPriority,
  })

  // 宿主服务：其它插件（@huaqiu/dsh-tool-pcb-autoplacement）按
  // `ctx.inject(['kicadDrc'])` 取用。走服务而不是工具，是因为布局候选评估
  // 由插件代码自动驱动、3 候选并行，不经过模型调用。
  const drcService = createDrcService(adaptive)
  ctx.effect(() => ctx.provide(DRC_SERVICE_NAME, drcService))

  console.log(
    `[@huaqiu/dsh-kicad-drc] 模式: ${config.executorMode}`
    + `；后端优先顺序: ${config.backendPriority.join(' → ')}`
    + `；本地配置隔离: ${configHome ? `开（${configHome}）` : '关'}`
    + `；远程: ${
      launcher
        ? `托管 pcblint-local（按需启动，数据 ${pcblintDataRoot}）`
        : launcherError
          ? `不可用（${launcherError}）`
          : `${config.pcblintBaseUrl}${config.pcblintToken ? '（已配 x-token）' : '（无 x-token，需本地免鉴权）'}`
    }`
    + `；kicad-ipc: ${ipcPython}（需要华秋定制版 KiCad 提供 RunDrc）`,
  )

  // 异步预热：探测放到启动之后，避免本机没装 KiCad 时（PowerShell 全盘搜索上限 30s）
  // 同步阻塞 host 启动。失败不致命——kicad-cli 只在真正调用工具时才需要。
  const warmup = setTimeout(() => {
    void adaptive.describe().then((list) => {
      for (const b of list) {
        if (b.available) console.log(`[@huaqiu/dsh-kicad-drc] 后端 ${b.backend} 可用: ${b.endpoint}`)
        else console.warn(`[@huaqiu/dsh-kicad-drc] 后端 ${b.backend} 不可用: ${b.reason ?? '未知原因'}`)
      }
    }).catch((e: unknown) => {
      console.warn(`[@huaqiu/dsh-kicad-drc] 后端预热失败: ${e instanceof Error ? e.message : String(e)}`)
    })
  }, 1500)
  if (typeof warmup.unref === 'function') warmup.unref()

  // /drc-report 路由：浏览器半边（src/client）经此拉取 drc.json 并渲染分页报告卡片。
  // webServer 服务缺失时（headless 环境）静默跳过，工具功能不受影响。
  let registerReport: ((key: string, reportPath: string) => void) | undefined
  const webServer = (ctx as Context & {
    webServer?: { register: (route: unknown) => void }
  }).webServer
  if (webServer && typeof webServer.register === 'function') {
    const registry = createReportRegistry()
    ctx.effect(() => {
      const reg = webServer.register({
        kind: 'prefix',
        path: '/drc-report',
        handler: createDrcReportHandler(registry),
      })
      return () => { if (typeof reg === 'function') (reg as () => void)() }
    }, '@huaqiu/dsh-kicad-drc: /drc-report routes')
    registerReport = (key, reportPath) => registry.register(key, reportPath)
  }

  // 注册工具 — inject=['tools'] 保证 tools 服务已就绪
  const registry = (ctx as Context & { tools: { register: (t: unknown) => void, dispose: (name: string) => void } }).tools
  if (!registry) {
    console.warn('[@huaqiu/dsh-kicad-drc] 未找到 tools 服务，工具未注册')
    return
  }

  const drcTool = createDrcTool(adaptive, config.defaultTimeoutSeconds, registerReport, {
    defaultMode: config.executorMode,
  })
  const backendsTool = createBackendsTool(() => adaptive.describe())

  registry.register(drcTool)
  registry.register(backendsTool)

  ctx.effect(() => {
    console.log(`[@huaqiu/dsh-kicad-drc] 已注册工具: ${TOOL_NAME}, ${BACKENDS_TOOL_NAME}`)
    return () => {
      try { registry.dispose(TOOL_NAME) } catch { /* ignore */ }
      try { registry.dispose(BACKENDS_TOOL_NAME) } catch { /* ignore */ }
      console.log(`[@huaqiu/dsh-kicad-drc] 工具已卸载: ${TOOL_NAME}, ${BACKENDS_TOOL_NAME}`)
    }
  }, '@huaqiu/dsh-kicad-drc.lifecycle')
}
