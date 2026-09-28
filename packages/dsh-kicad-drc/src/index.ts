/**
 * DSH 插件入口：KiCad DRC 工具。
 *
 * 在 Host 端注册 kicad_drc_run 工具，AI agent 可调用它对 .kicad_pcb 文件
 * 执行 DRC 检查并获取结构化结果。
 *
 * 支持两种执行模式：
 *   - local:  当前机器 subprocess 调 kicad-cli（需本地安装 KiCad）
 *   - remote: HTTP 上传到 pcblint-java 服务（由其转发到 cli-runner 执行 kicad-cli，
 *             不做 base64 回读，返回 outputFilePaths 由本插件从共享磁盘读取）
 *
 * @module dsh-kicad-drc
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import pkg from '../package.json'
import { LocalExecutor, resolveKicadCli } from './local-executor.ts'
import { RemoteExecutor } from './remote-executor.ts'
import { createDrcTool, TOOL_NAME } from './tools.ts'
import { createReportRegistry, createDrcReportHandler } from './web-routes.ts'

/** 插件版本号（唯一来源：package.json），启动时打印用于确认生效版本。 */
const PLUGIN_VERSION = pkg.version

export { createDrcTool } from './tools.ts'
export { LocalExecutor, resolveKicadCli } from './local-executor.ts'
export { RemoteExecutor } from './remote-executor.ts'
export { parseDrcSummary, formatSummaryText } from './drc-summary.ts'
export type { DrcExecutor, DrcRunOptions, DrcRunResult } from './executor.ts'
export type { DrcSummary, JsonValue } from './drc-summary.ts'

/** 插件配置。 */
export interface Config {
  /** 执行模式：local（本地 subprocess）或 remote（HTTP 调 pcblint-java）。 */
  executorMode: 'local' | 'remote'
  /** 本地模式：kicad-cli 路径，留空自动探测。 */
  kicadCliPath: string
  /** 远程模式：pcblint-java 服务地址（由其转发到 cli-runner 执行 kicad-cli）。 */
  pcblintBaseUrl: string
  /** 远程模式：cli-runner 工作目录根（共享磁盘上的路径，pcblint-java 和本插件均可访问）。 */
  cliRunnerWorkDirRoot: string
  /** 远程模式：静态文件服务器域名，用于把 cli-runner 返回的绝对路径（如 /data/kicad/drc/xxx/drc.json）
   *  拼接成完整下载 URL（如 http://www.fdatasheets.com/data/kicad/drc/xxx/drc.json）。
   *  配了之后插件通过 HTTP 下载 drc.json；显式设为空字符串则回退到共享磁盘 readFileSync。 */
  fileBaseUrl: string
  /** DRC 默认超时秒数。 */
  defaultTimeoutSeconds: number
}

/** 运行时配置校验和默认值。 */
export const Config: Schema<Config> = Schema.object({
  executorMode: Schema.union(['local', 'remote'] as const).default('remote'),
  kicadCliPath: Schema.string().default(''),
  pcblintBaseUrl: Schema.string().default('http://47.100.4.100:8080'),
  cliRunnerWorkDirRoot: Schema.string().default('/data/kicad/drc'),
  fileBaseUrl: Schema.string().default('http://www.fdatasheets.com'),
  defaultTimeoutSeconds: Schema.number().default(600),
})

/** 插件名，Cordis 会显示。 */
export const name = 'dsh-kicad-drc'

/** 依赖的 DSH 服务（webServer 用于 /drc-report 报告查看路由；headless 环境缺失时自动降级）。 */
export const inject = ['tools', 'webServer']

/**
 * 插件入口：根据配置构建执行器并注册工具。
 */
export function apply(ctx: Context, config: Config): void {
  console.log(`[dsh-kicad-drc] 插件版本: ${PLUGIN_VERSION}`)
  // 构建执行器
  let executor
  if (config.executorMode === 'remote') {
    // 注意：必须原样传递 config.fileBaseUrl（空字符串 = 显式禁用 HTTP 下载，走共享磁盘）；
    // 若在这里转成 undefined，构造函数会兜底回硬编码默认值，导致"共享磁盘模式"永远无法启用。
    executor = new RemoteExecutor({
      baseUrl: config.pcblintBaseUrl,
      workDirRoot: config.cliRunnerWorkDirRoot,
      fileBaseUrl: config.fileBaseUrl,
    })
    console.log(
      `[dsh-kicad-drc] 使用远程 pcblint-java: ${config.pcblintBaseUrl}`
      + (config.fileBaseUrl ? `, fileBaseUrl: ${config.fileBaseUrl}` : '（fileBaseUrl 为空，共享磁盘读取模式）'),
    )
  } else {
    // 启动时先探测一次（供日志展示）；成功则把结果传给执行器缓存，
    // 避免首次 run() 时重复走完整探测链（慢路径如全盘搜索可达 30s）。
    let cliPath: string | undefined
    try {
      cliPath = resolveKicadCli(config.kicadCliPath || undefined)
      console.log(`[dsh-kicad-drc] 使用本地 kicad-cli: ${cliPath}`)
    } catch {
      // 启动时探测失败不致命：kicad-cli 在首次调用工具时才真正需要
      console.warn('[dsh-kicad-drc] 本地模式：启动时未找到 kicad-cli，将在首次调用工具时重新探测')
    }
    executor = new LocalExecutor(cliPath ?? (config.kicadCliPath || undefined))
  }

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
    }, 'dsh-kicad-drc: /drc-report routes')
    registerReport = (key, reportPath) => registry.register(key, reportPath)
  }

  // 注册工具 — inject=['tools'] 保证 tools 服务已就绪
  const tool = createDrcTool(executor, config.defaultTimeoutSeconds, registerReport)
  const registry = (ctx as Context & { tools: { register: (t: unknown) => void; dispose: (name: string) => void } }).tools
  if (registry) {
    registry.register(tool)
    ctx.effect(() => {
      console.log(`[dsh-kicad-drc] 已注册工具: ${TOOL_NAME}`)
      return () => {
        try { registry.dispose(TOOL_NAME) } catch { /* ignore */ }
        console.log(`[dsh-kicad-drc] 工具已卸载: ${TOOL_NAME}`)
      }
    }, 'dsh-kicad-drc.lifecycle')
  } else {
    console.warn('[dsh-kicad-drc] 未找到 tools 服务，工具未注册')
  }
}
