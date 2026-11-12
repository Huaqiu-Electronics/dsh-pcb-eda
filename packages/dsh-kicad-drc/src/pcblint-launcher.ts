/**
 * PCBLint 本地服务托管器：按需启动、引用计数、空闲关闭。
 *
 * 设计口径（与 FreeRouting 托管一致）：
 *   - 只有真正执行 DRC 时才启动 JVM；`probe()`/`describe()` 绝不拉起进程；
 *   - 单飞启动：并发调用共享同一个启动 Promise，不会出现第二个 JVM；
 *   - 每次 `run()` 结束 `release()`；引用计数归零后按空闲超时停止，
 *     `idleTimeoutMs=0` 表示用完立即停止；
 *   - 启动失败进入 60s 冷却，期间 `probe()` 报不可用，让 auto 模式降级到 local；
 *   - 只停止自己 `spawn` 的进程（记录 PID + `taskkill /T`）。
 *
 * @module
 */
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { DrcAbortedError, ExecutorError } from './executor.ts'
import { PcblintProcess } from './pcblint-process.ts'
import type { PcblintInstallation } from './pcblint-installation.ts'
import type { PcblintDownloader } from './pcblint-downloader.ts'

/** 健康轮询间隔。 */
const HEALTH_POLL_MS = 500

/** 单次健康请求超时：不能让一次挂起拖住整个轮询。 */
const HEALTH_REQUEST_TIMEOUT_MS = 1_000

/** 启动失败后的冷却时间（与 RemoteExecutor 的失败冷却一致）。 */
const FAILURE_COOLDOWN_MS = 60_000

/** 只允许回环地址：服务不应暴露到局域网。 */
const LOOPBACK = '127.0.0.1'

/** 数据根下需要预先创建的目录（服务端不会自己建）。 */
const DATA_SUBDIRS = ['pcblint', 'pcblint-files', 'pcblint-preview', 'shared', 'cli-runner-tmp']

export interface PcblintLauncherOptions {
  /** 组件位置解析（惰性：首次使用时才定位 kicad-cli）。 */
  resolveInstallation: () => PcblintInstallation
  /** 可写数据根（`HQ_EDGE_HOME` 下的插件数据目录）。 */
  dataRoot: string
  /** 配置的 kicad-cli 路径；用于服务端原生检查。 */
  kicadCliPath?: string
  /** kicad-cli 兜底探测（仅在安装目录同级找不到时调用）。 */
  resolveKicadCli?: () => string
  /** 冷启动等待上限，默认 90s。 */
  startupTimeoutMs?: number
  /** 空闲关闭时间，默认 60s；0 = 每次用完立即关闭。 */
  idleTimeoutMs?: number
  /** 追加 JVM 参数（空白分隔），如 `-Xmx1536m`。 */
  javaOptions?: string
  /** 固定端口（0/缺省 = 随机回环端口）。 */
  port?: number
  /** 注入 fetch，便于单测。 */
  fetchImpl?: typeof fetch
  /** 可选：组件下载器。首次启动时组件不在磁盘上则触发下载；已存在且版本匹配时跳过。 */
  downloader?: PcblintDownloader
  /** 是否允许自动下载。默认 true；false 时 downloader 不生效。 */
  autoDownload?: boolean
}

/** 托管状态的只读快照，供 `probe()` 使用。 */
export interface PcblintLauncherState {
  /** 是否已有自己启动的进程在运行。 */
  running: boolean
  /** 是否具备启动条件（组件完整、不在冷却期、未释放）。 */
  available: boolean
  /** 组件安装目录；解析失败时为空串。 */
  home: string
  /** 安装包版本号。 */
  version?: string
  /** 运行中的服务地址。 */
  baseUrl?: string
  /** 人类可读状态说明（直接写进 BackendHealth.reason）。 */
  reason: string
}

export interface BuildPcblintJavaArgsInput {
  port: number
  dataRoot: string
  jarPath: string
  /** 为空时省略原生检查相关参数（服务端只跑规则引擎）。 */
  kicadCliPath: string
  javaOptions?: string
}

/** 错误对象 → 可读文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 延迟。 */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/**
 * 申请一个随机回环端口。
 *
 * 用 `net` 而不是固定 8096：固定端口会与用户手工启动的服务撞车，
 * 也会让"只管理自有 PID"的边界变得可疑。监听 0 由系统分配后立即释放，
 * 存在极小概率被其他进程抢占，启动失败会进入冷却并报端口错误。
 */
export function findFreePort(host = LOOPBACK): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.unref()
    server.once('error', fail)
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => fail(new Error('无法分配回环端口')))
        return
      }
      const { port } = address
      server.close(() => done(port))
    })
  })
}

/** 把配置里的 JVM 参数拆成数组；不支持带空格的参数值。 */
function splitJavaOptions(javaOptions?: string): string[] {
  return javaOptions?.trim() ? javaOptions.trim().split(/\s+/u) : []
}

/**
 * 组装 JVM 参数（照搬 `start.bat`，所有可写路径改到数据根）。
 *
 * 单独导出便于单测：参数拼错时 JVM 能起来但行为不对，是最难排查的一类问题。
 */
export function buildPcblintJavaArgs(input: BuildPcblintJavaArgsInput): string[] {
  const { dataRoot, port } = input
  const logFile = join(dataRoot, 'pcblint', 'pcblint.log')
  const args = [
    '-Xms256m',
    '-Xmx1024m',
    '-Dfile.encoding=UTF-8',
    '-Duser.timezone=Asia/Shanghai',
    `-Dserver.port=${port}`,
    `-Dserver.address=${LOOPBACK}`,
    `-Dspring.datasource.url=jdbc:h2:file:${join(dataRoot, 'pcblintdb')}`
      + ';MODE=MySQL;DATABASE_TO_LOWER=TRUE;AUTO_SERVER=TRUE',
    '-Dspring.datasource.username=sa',
    '-Dspring.datasource.password=',
    '-Dspring.datasource.driver-class-name=org.h2.Driver',
    '-Dspring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect',
    `-Dpcblint.storage.file-base=${join(dataRoot, 'pcblint-files')}`,
    `-Dpcblint.preview.output-base=${join(dataRoot, 'pcblint-preview')}`,
    `-Dpcblint.preview.url-base=http://${LOOPBACK}:${port}/data/design/preview`,
    `-Dpcblint.drc.dru-output-base=${join(dataRoot, 'shared')}`,
    `-Dpcblint.drc.cli-runner.work-dir-base=${join(dataRoot, 'shared')}`,
    '-Dpcblint.drc.local-mode=true',
    `-Dpcblint.drc.cli-executor.work-dir=${join(dataRoot, 'cli-runner-tmp')}`,
    `-Dpcblint.drc.cli-executor.allowed-work-roots[0]=${join(dataRoot, 'shared')}`,
    '-Dpcblint.seed.system-rules.enabled=true',
    '-Dpcblint.auth.local-bypass.enabled=true',
    '-Dpcblint.auth.local-bypass.uid=local',
    '-Dspring.cloud.nacos.config.enabled=false',
    '-Dspring.cloud.nacos.discovery.enabled=false',
    `-Dlogging.file.name=${logFile}`,
  ]
  if (input.kicadCliPath) {
    args.push(`-Dpcblint.drc.cli-executor.kicad-cli-path=${input.kicadCliPath}`)
  }
  args.push(...splitJavaOptions(input.javaOptions))
  args.push('-jar', input.jarPath)
  return args
}

/** 健康检查：只有显式 `status: 'ok'` 才算就绪，避免把 404/错误页当成启动完成。 */
async function isHealthy(
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HEALTH_REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal
  try {
    const resp = await fetchImpl(`${baseUrl}/api/s/health`, { signal: combined })
    if (!resp.ok) return false
    const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
    return body.status === 'ok'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 启动等待条件。 */
interface WaitForHealthOptions {
  timeoutMs: number
  signal?: AbortSignal
  isAlive: () => boolean
  isDisposed: () => boolean
}

/** 轮询健康接口直到就绪；进程退出、超时、取消、释放都会结束等待。 */
async function waitForHealth(
  baseUrl: string,
  fetchImpl: typeof fetch,
  options: WaitForHealthOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  while (true) {
    if (options.signal?.aborted) throw new DrcAbortedError()
    if (options.isDisposed()) throw new ExecutorError('PCBLint 托管器已释放')
    if (!options.isAlive()) throw new ExecutorError('PCBLint 进程在服务就绪前退出')
    if (Date.now() > deadline) {
      throw new ExecutorError(`等待 PCBLint 服务就绪超时（${Math.round(options.timeoutMs / 1000)}s）`)
    }
    if (await isHealthy(baseUrl, fetchImpl, options.signal)) return
    await sleep(HEALTH_POLL_MS)
  }
}

export class PcblintLauncher {
  private readonly options: PcblintLauncherOptions
  private readonly fetchImpl: typeof fetch
  private child: PcblintProcess | undefined
  private url = ''
  /** 健康检查通过后才允许复用；启动中或启动失败都不能把地址交出去。 */
  private healthy = false
  private refCount = 0
  private launchInFlight: Promise<string> | undefined
  private stopInFlight: Promise<void> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private lastFailureAt = 0
  private lastFailureMessage = ''
  private disposed = false
  private installation: PcblintInstallation | undefined
  /** 组件解析失败也缓存一小段时间：定位 kicad-cli 可能触发全盘搜索，不能被每次探测反复触发。 */
  private installationFailure = ''
  private installationFailureAt = 0

  constructor(options: PcblintLauncherOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    const startup = options.startupTimeoutMs ?? 90_000
    const idle = options.idleTimeoutMs ?? 60_000
    if (!(startup > 0)) {
      throw new ExecutorError(`pcblintStartupTimeoutMs 必须是正数（当前 ${startup}）`)
    }
    if (idle < 0) {
      throw new ExecutorError(`pcblintIdleTimeoutMs 不能为负数（当前 ${idle}）`)
    }
  }

  /** 运行中的服务地址；未启动或未就绪时为空串。 */
  get baseUrl(): string {
    return this.healthy && this.child?.isAlive() ? this.url : ''
  }

  /** 是否持有自己启动的进程（外部固定服务不归这里管）。 */
  get ownsProcess(): boolean {
    return this.child !== undefined
  }

  /**
   * 确保服务可用并占用一个引用。
   *
   * 调用方必须在 `finally` 里 `release()`；启动失败不增加引用。
   */
  async ensureUp(signal?: AbortSignal): Promise<string> {
    if (this.disposed) throw new ExecutorError('PCBLint 托管器已释放')
    if (signal?.aborted) throw new DrcAbortedError()
    // 先清空闲计时器：旧计时器可能在本次冷启动期间触发，把刚拉起的进程停掉
    this.clearIdleTimer()
    if (this.healthy && this.child?.isAlive() && this.url) {
      this.refCount++
      return this.url
    }
    if (this.stopInFlight) await this.stopInFlight
    if (Date.now() - this.lastFailureAt < FAILURE_COOLDOWN_MS) {
      throw new ExecutorError(
        `PCBLint 服务最近启动失败，冷却期内不再重试：${this.lastFailureMessage}`,
      )
    }
    if (!this.launchInFlight) {
      this.launchInFlight = this.start(signal).finally(() => {
        this.launchInFlight = undefined
      })
    }
    const url = await this.launchInFlight
    this.refCount++
    this.clearIdleTimer()
    return url
  }

  /** 每次 `run()` 结束调用：引用归零后按空闲超时停止。 */
  release(): void {
    if (this.refCount > 0) this.refCount--
    if (this.refCount > 0 || !this.child) return
    this.scheduleIdleStop()
  }

  /** 停止服务。幂等；停止中再次调用复用同一个 Promise。 */
  stop(): Promise<void> {
    this.clearIdleTimer()
    if (this.stopInFlight) return this.stopInFlight
    const child = this.child
    if (!child) return Promise.resolve()
    // 从决定停止这一刻起不再对外提供地址，避免 ensureUp 复用一个正在关闭的服务
    this.healthy = false
    this.stopInFlight = child.stop()
      .then(() => undefined)
      .finally(() => {
        // 停止失败时保留引用：进程可能还活着，丢掉引用会导致下次启动出现两个 JVM
        if (this.child === child && !child.isAlive()) {
          this.child = undefined
          this.url = ''
        }
        this.stopInFlight = undefined
      })
    return this.stopInFlight
  }

  /** 卸载时释放全部资源：取消进行中的启动、清计时器、停自有进程。 */
  async dispose(): Promise<void> {
    this.disposed = true
    this.clearIdleTimer()
    await this.stop()
  }

  /** 宿主 `exit` 钩子：同步结束自有进程（此时不能再等异步）。 */
  disposeSync(): void {
    this.disposed = true
    this.healthy = false
    this.clearIdleTimer()
    this.child?.killSync()
    this.child = undefined
    this.url = ''
  }

  /** 只读状态快照。绝不在探测路径里启动进程。 */
  describe(): PcblintLauncherState {
    if (this.disposed) {
      return { running: false, available: false, home: '', reason: 'PCBLint 托管器已释放' }
    }
    let installation: PcblintInstallation
    try {
      installation = this.resolveInstallation()
    } catch (error) {
      // 启用自下载时不能判"不可用"：auto 模式会直接过滤掉不可用后端，
      // 那样 start() 永远不会执行，下载也就永远触发不了。
      if (this.options.autoDownload !== false && this.options.downloader) {
        return {
          running: false,
          available: true,
          home: this.options.downloader.installedHome,
          reason: 'PCBLint 组件尚未安装，执行检查时会从云端自动下载',
        }
      }
      return { running: false, available: false, home: '', reason: messageOf(error) }
    }
    const base = { home: installation.home, ...(installation.version ? { version: installation.version } : {}) }
    if (this.launchInFlight) {
      return {
        ...base,
        running: false,
        available: true,
        reason: 'PCBLint 本地服务启动中，就绪后自动使用',
      }
    }
    if (this.healthy && this.child?.isAlive() && this.url) {
      return {
        ...base,
        running: true,
        available: true,
        baseUrl: this.url,
        reason: 'PCBLint 本地服务运行中（按需启动，空闲后自动关闭）',
      }
    }
    if (Date.now() - this.lastFailureAt < FAILURE_COOLDOWN_MS) {
      return {
        ...base,
        running: false,
        available: false,
        reason: `最近一次启动失败，冷却期内降级：${this.lastFailureMessage}`,
      }
    }
    const version = installation.version ? `（版本 ${installation.version}）` : ''
    return {
      ...base,
      running: false,
      available: true,
      reason: `PCBLint 组件就绪${version}，执行检查时按需启动`,
    }
  }

  /** 组件位置只解析一次；失败也按冷却期缓存，避免反复全盘搜索。 */
  private resolveInstallation(): PcblintInstallation {
    if (this.installation) return this.installation
    if (
      this.installationFailure
      && Date.now() - this.installationFailureAt < FAILURE_COOLDOWN_MS
    ) {
      throw new ExecutorError(this.installationFailure)
    }
    try {
      this.installation = this.options.resolveInstallation()
      this.installationFailure = ''
      return this.installation
    } catch (error) {
      this.installationFailure = messageOf(error)
      this.installationFailureAt = Date.now()
      throw error
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer()
    const idle = this.options.idleTimeoutMs ?? 60_000
    if (idle === 0) {
      void this.stop().catch((error: unknown) => {
        console.warn(`[@huaqiu/dsh-kicad-drc] 停止 PCBLint 服务失败: ${messageOf(error)}`)
      })
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.stop().catch((error: unknown) => {
        console.warn(`[@huaqiu/dsh-kicad-drc] 停止 PCBLint 服务失败: ${messageOf(error)}`)
      })
    }, idle)
    this.idleTimer.unref?.()
  }

  /** 启动一次：准备数据目录 → 选端口 → spawn → 等健康检查。 */
  private async start(signal?: AbortSignal): Promise<string> {
    // 上次停止失败或进程已自行退出：先把残留引用收干净，避免同时存在两个 JVM
    if (this.child) {
      if (this.child.isAlive()) {
        await this.stop()
      } else {
        this.child = undefined
        this.url = ''
      }
    }
    // 如果有 downloader，先确保组件在磁盘上：首次启动时可能需要从云端下载
    // ensure() 内部会先检查已安装版本，版本对就直接返回，不影响冷启动时间
    const shouldDownload = this.options.autoDownload !== false
    if (shouldDownload && this.options.downloader) {
      try {
        await this.options.downloader.ensure(signal)
        // 下载前的 describe() 会缓存"组件不存在"；不清掉会继续抛 60s
        this.installation = undefined
        this.installationFailure = ''
      } catch (error) {
        // 下载失败进入冷却：让 probe 判不可用，auto 模式降级 local
        this.lastFailureAt = Date.now()
        this.lastFailureMessage = `PCBLint 组件下载失败：${messageOf(error)}`
        throw new ExecutorError(this.lastFailureMessage)
      }
    }
    const installation = this.resolveInstallation()
    if (this.disposed) throw new ExecutorError('PCBLint 托管器已释放')
    this.prepareDataRoot()
    const port = this.options.port && this.options.port > 0
      ? this.options.port
      : await findFreePort()
    const kicadCliPath = this.resolveServiceKicadCli(installation)
    if (!kicadCliPath) {
      console.warn(
        '[@huaqiu/dsh-kicad-drc] 未找到 kicad-cli，PCBLint 本次只跑规则引擎（结果缺少原生 DRC 条目）',
      )
    }
    const args = buildPcblintJavaArgs({
      port,
      dataRoot: this.options.dataRoot,
      jarPath: installation.jarPath,
      kicadCliPath,
      ...(this.options.javaOptions ? { javaOptions: this.options.javaOptions } : {}),
    })

    let child: PcblintProcess | undefined
    const url = `http://${LOOPBACK}:${port}`
    try {
      child = PcblintProcess.launch({
        javaPath: installation.javaPath,
        args,
        cwd: this.options.dataRoot,
        logFile: join(this.options.dataRoot, 'pcblint', 'launcher.log'),
        onExit: () => {
          if (this.child === child) {
            this.healthy = false
            this.child = undefined
            this.url = ''
          }
        },
      })
    } catch (error) {
      this.lastFailureAt = Date.now()
      this.lastFailureMessage = messageOf(error)
      throw new ExecutorError(`PCBLint 启动失败：${this.lastFailureMessage}`)
    }
    this.child = child
    this.url = url
    this.healthy = false

    try {
      await waitForHealth(url, this.fetchImpl, {
        timeoutMs: this.options.startupTimeoutMs ?? 90_000,
        ...(signal ? { signal } : {}),
        isAlive: () => child?.isAlive() === true,
        isDisposed: () => this.disposed,
      })
      this.healthy = true
      return url
    } catch (error) {
      const tail = await child.readLogTail(30).catch(() => '')
      await this.stop().catch(() => {})
      // 用户取消 / 插件卸载不是服务失败，不能占用 60s 冷却
      if (signal?.aborted || error instanceof DrcAbortedError) {
        throw new DrcAbortedError()
      }
      this.lastFailureAt = Date.now()
      this.lastFailureMessage = messageOf(error)
      const detail = tail
        ? `\n日志尾部（${join(this.options.dataRoot, 'pcblint', 'launcher.log')}）：\n${tail}`
        : `\n日志：${join(this.options.dataRoot, 'pcblint', 'launcher.log')}`
      throw new ExecutorError(`PCBLint 启动失败：${this.lastFailureMessage}${detail}`)
    }
  }

  /** 该服务端会派生 kicad-cli；优先用组件同级的随包版本，避免全盘搜索。 */
  private resolveServiceKicadCli(installation: PcblintInstallation): string {
    const beside = join(dirname(installation.home), 'kicad-cli.exe')
    if (existsSync(beside)) return beside
    const configured = this.options.kicadCliPath?.trim()
    if (configured) {
      if (existsSync(configured)) return configured
      console.warn(`[@huaqiu/dsh-kicad-drc] 配置的 kicad-cli 不存在: ${configured}，尝试自动定位`)
    }
    if (!this.options.resolveKicadCli) return ''
    try {
      return this.options.resolveKicadCli()
    } catch {
      // kicad-cli 缺失不影响服务启动：结果里只有规则引擎条目
      return ''
    }
  }

  /** 运行时数据必须落在可写目录；安装目录（Program Files）只读。 */
  private prepareDataRoot(): void {
    try {
      for (const sub of DATA_SUBDIRS) {
        mkdirSync(join(this.options.dataRoot, sub), { recursive: true })
      }
    } catch (error) {
      throw new ExecutorError(
        `无法创建 PCBLint 数据目录 ${this.options.dataRoot}：${messageOf(error)}`,
      )
    }
  }
}
