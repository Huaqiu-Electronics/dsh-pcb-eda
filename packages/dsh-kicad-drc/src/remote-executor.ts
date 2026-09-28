/**
 * 远程 pcblint-java 执行器：HTTP 上传 PCB 文件到 pcblint-java 的 CliProxyController，
 * 由后者转发到 cli-runner 执行 kicad-cli。
 *
 * 调用完成后，drc.json 会自动持久化到用户本地磁盘（与 .kicad_pcb 同目录），
 * 返回的 drcJsonPath 指向该本地持久化文件。
 *
 * 两种获取 drc.json 内容的方式：
 *   1. 配了 fileBaseUrl → 把 cli-runner 返回的绝对路径拼到 fileBaseUrl 上，HTTP 下载
 *      （适合插件与 cli-runner 不在同一文件系统，但有静态文件服务器暴露产物目录）。
 *   2. 没配 fileBaseUrl → 直接从共享磁盘 readFileSync 读取（适合同机/同 PV 部署）。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, resolve, join } from 'node:path'
import { ExecutorError, type DrcExecutor, type DrcRunOptions, type DrcRunResult } from './executor.ts'

/** pcblint-java CliProxyController 的响应结构。 */
interface CliProxyResponse {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  workDir: string
  /** key=输出文件相对路径，value=在共享磁盘上的绝对路径。 */
  outputFilePaths?: Record<string, string>
  elapsedMillis: number
}

/** 延迟（重试间隔用）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 是否中止类错误。超时/主动中止不重试，避免长任务总时长翻倍。 */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

/** 带重试的 fetch：最多 2 次尝试；网络错误或 HTTP 5xx 时重试一次（间隔 1s），中止/超时立即抛出。 */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(url, init)
      if (resp.status >= 500 && attempt < 2) {
        await resp.body?.cancel().catch(() => {})
        console.warn(`[dsh-kicad-drc] ${label} HTTP ${resp.status}，1s 后重试`)
        await sleep(1000)
        continue
      }
      return resp
    } catch (e) {
      if (isAbortError(e) || attempt >= 2) throw e
      console.warn(`[dsh-kicad-drc] ${label} 网络错误: ${(e as Error).message}，1s 后重试`)
      await sleep(1000)
    }
  }
  throw new Error('unreachable')
}

export class RemoteExecutor implements DrcExecutor {
  private readonly baseUrl: string
  private readonly workDirRoot: string
  /** null = 共享磁盘读取模式（fileBaseUrl 显式传空字符串时）。 */
  private readonly fileBaseUrl: string | null

  constructor(opts: {
    baseUrl?: string
    workDirRoot?: string
    /** 静态文件服务器域名。undefined = 用内置默认值；'' = 禁用 HTTP 下载，走共享磁盘。 */
    fileBaseUrl?: string
  } = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://47.100.4.100:8080').replace(/\/$/, '')
    this.workDirRoot = (opts.workDirRoot ?? '/data/kicad/drc').replace(/\/$/, '')
    const fbu = opts.fileBaseUrl?.replace(/\/$/, '') ?? 'http://www.fdatasheets.com'
    this.fileBaseUrl = fbu ? fbu : null
  }

  async run(options: DrcRunOptions): Promise<DrcRunResult> {
    const start = performance.now()
    const pcbPath = resolve(options.pcbPath)
    if (!existsSync(pcbPath)) {
      throw new ExecutorError(`PCB 文件不存在: ${pcbPath}`)
    }

    const filename = basename(pcbPath)
    const fileBytes = readFileSync(pcbPath)
    const jobId = crypto.randomUUID()
    const workDir = `${this.workDirRoot}/${jobId}`
    const outputName = 'drc.json'

    // 持久化目标：与 .kicad_pcb 同目录，命名为 <pcb_stem>_drc.json
    const pcbStem = filename.replace(/\.kicad_pcb$/i, '')
    const pcbDir = dirname(pcbPath)
    const localPersistPath = join(pcbDir, `${pcbStem}_drc.json`)

    // 组装 command
    const cmdParts = ['kicad-cli', 'pcb', 'drc', '--format', 'json', '--output', outputName]
    if (options.severityAll !== false) cmdParts.push('--severity-all')
    if (options.refillZones !== false) cmdParts.push('--refill-zones')
    if (options.allTrackErrors) cmdParts.push('--all-track-errors')
    cmdParts.push(filename)
    const command = cmdParts.join(' ')

    const timeoutSeconds = options.timeoutSeconds ?? 600

    // multipart/form-data 调用 pcblint-java 的 /api/cli/run-with-file
    const url = `${this.baseUrl}/api/cli/run-with-file`
    const formData = new FormData()
    formData.append('file', new Blob([fileBytes]), filename)
    formData.append('workDir', workDir)
    formData.append('command', command)
    // outputFiles 传给 pcblint-java，用于拼 outputFilePaths（不会转发给 cli-runner）
    formData.append('outputFiles', outputName)
    formData.append('timeoutSeconds', String(timeoutSeconds))

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), (timeoutSeconds + 30) * 1000)

    let resp: Response
    try {
      resp = await fetchWithRetry(url, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      }, 'pcblint-java 调用')
    } catch (e) {
      clearTimeout(timeoutId)
      throw new ExecutorError(`pcblint-java HTTP 请求失败: ${(e as Error).message}`)
    }
    clearTimeout(timeoutId)

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new ExecutorError(`pcblint-java 返回 HTTP ${resp.status}: ${text.slice(0, 500)}`)
    }

    const data = (await resp.json()) as CliProxyResponse

    // 获取 drc.json 内容：优先 HTTP 下载（fileBaseUrl 配了），回退共享磁盘
    let drcJson: string | null = null
    if (data.outputFilePaths && outputName in data.outputFilePaths) {
      const remotePath = data.outputFilePaths[outputName]

      if (this.fileBaseUrl) {
        // 方式 1：HTTP 下载
        const fileUrl = `${this.fileBaseUrl}${remotePath}`
        drcJson = await this.downloadViaHttp(fileUrl)
      } else if (remotePath && existsSync(remotePath)) {
        // 方式 2：共享磁盘直接读
        try {
          const raw = readFileSync(remotePath, 'utf-8')
          JSON.parse(raw) // 验证 JSON 合法
          drcJson = raw
        } catch {
          drcJson = null
        }
      } else {
        console.warn(`[dsh-kicad-drc] outputFilePath 不可读: ${remotePath}`)
      }
    }

    // 持久化到用户本地磁盘（与 .kicad_pcb 同目录）
    let drcJsonPath: string | null = null
    if (drcJson) {
      try {
        mkdirSync(pcbDir, { recursive: true })
        writeFileSync(localPersistPath, drcJson, 'utf-8')
        drcJsonPath = localPersistPath
        console.log(`[dsh-kicad-drc] drc.json 已持久化: ${localPersistPath}`)
      } catch (e) {
        console.warn(`[dsh-kicad-drc] 写入本地文件失败: ${(e as Error).message}`)
        drcJsonPath = localPersistPath // 即使写入失败也返回目标路径，方便排查
      }
    }

    // kicad-cli 执行成功但报告取回失败时，在 stderr 里显式标注，避免被误读为"DRC 未生成报告"
    let stderr = data.stderr ?? ''
    if (drcJson === null && data.exitCode === 0) {
      stderr += '\n[dsh-kicad-drc] 警告: kicad-cli 执行成功(exit 0)，但插件未能取回 drc.json（HTTP 下载或共享磁盘读取失败）'
    }

    const elapsedMs = Math.round(performance.now() - start)

    return {
      exitCode: data.exitCode,
      stdout: data.stdout ?? '',
      stderr,
      drcJson,
      elapsedMs,
      timedOut: data.timedOut,
      kicadCliPath: 'remote:' + this.baseUrl,
      command,
      drcJsonPath,
    }
  }

  /** 通过 HTTP 下载产物文件（带重试），验证 JSON 合法后返回内容。 */
  private async downloadViaHttp(fileUrl: string): Promise<string | null> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 30_000)
      const resp = await fetchWithRetry(fileUrl, { signal: ctrl.signal }, '下载 drc.json')
      clearTimeout(t)
      if (!resp.ok) {
        console.warn(`[dsh-kicad-drc] 下载 drc.json 失败: HTTP ${resp.status} ${fileUrl}`)
        return null
      }
      const raw = await resp.text()
      JSON.parse(raw) // 验证 JSON 合法
      return raw
    } catch (e) {
      console.warn(`[dsh-kicad-drc] 下载 drc.json 异常: ${(e as Error).message} ${fileUrl}`)
      return null
    }
  }
}
