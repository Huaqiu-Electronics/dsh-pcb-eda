/**
 * PCBLint JVM 进程的生命周期封装。
 *
 * 只管理本模块自己 `spawn` 的 PID，不扫描系统里其他 java 进程：
 * 用户手工 `start.bat` 起的服务不能被这里误杀。
 *
 * 关键点：
 *   - 不经过 cmd/shell，参数数组直接交给 `spawn`；
 *   - `taskkill /T` 结束整棵进程树，因为服务端会派生 `kicad-cli`；
 *   - stdout/stderr 落盘并按 5MB 轮转，内存只保留最近 200 行用于失败提示。
 *
 * @module
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { ExecutorError } from './executor.ts'

/** 落盘日志的轮转阈值。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024

/** 内存里保留的最近行数（只用于启动失败提示）。 */
const TAIL_LINES = 200

/** 单行最长保留字符数：日志里偶发超长堆栈时，避免环形缓冲被一行占满。 */
const MAX_LINE_CHARS = 4_000

/** 停止等待上限。 */
const STOP_TIMEOUT_MS = 5_000

/** 停止轮询间隔。 */
const STOP_POLL_MS = 100

/** 延迟（仅用于停止轮询）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

export interface PcblintLaunchInput {
  /** 自带 JRE 的 java.exe。 */
  javaPath: string
  /** 完整 JVM 参数（含 `-jar`）。 */
  args: string[]
  /** 工作目录：数据根，保证相对路径不落到安装目录。 */
  cwd: string
  /** 插件重定向的 stdout/stderr 日志。 */
  logFile: string
  /** 进程退出时回调（正常退出、崩溃、停止都会触发一次）。 */
  onExit?: () => void
}

/** 把超过阈值的旧日志轮转成 `.1`（只保留一份）。 */
function rotateLog(logFile: string): void {
  try {
    if (!existsSync(logFile)) return
    if (statSync(logFile).size <= MAX_LOG_BYTES) return
    const previous = `${logFile}.1`
    rmSync(previous, { force: true })
    renameSync(logFile, previous)
  } catch {
    // 轮转失败不阻止启动：日志会继续追加到原文件
  }
}

export class PcblintProcess {
  readonly pid: number
  private readonly child: ChildProcess
  private readonly log: WriteStream
  private readonly onExit?: () => void
  private readonly tail: string[] = []
  /** 每个流独立的半行缓冲，避免 stdout/stderr 交叉拼接。 */
  private readonly pending = new Map<string, string>()
  private exited = false
  private stopPromise: Promise<void> | undefined

  private constructor(child: ChildProcess, log: WriteStream, input: PcblintLaunchInput) {
    this.child = child
    this.log = log
    this.pid = child.pid ?? -1
    this.onExit = input.onExit
    child.stdout?.on('data', (chunk: Buffer) => this.append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.append('stderr', chunk))
    child.once('exit', () => this.finish())
    // 没有 error 监听时 spawn 失败会变成未捕获异常，直接拖垮宿主
    child.once('error', (err) => {
      this.pushLine(`[launcher] 进程错误: ${err.message}`)
      this.finish()
    })
  }

  /** 启动 JVM。日志文件与工作目录由调用方准备好（这里只兜底建日志目录）。 */
  static launch(input: PcblintLaunchInput): PcblintProcess {
    mkdirSync(dirname(input.logFile), { recursive: true })
    rotateLog(input.logFile)
    const log = createWriteStream(input.logFile, { flags: 'a' })
    const child = spawn(input.javaPath, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      // 不继承宿主 stdio：输出全部进日志，避免 DSH 控制台被 Spring 日志淹没
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return new PcblintProcess(child, log, input)
  }

  /** 进程是否还在运行（spawn 失败、已退出都为 false）。 */
  isAlive(): boolean {
    if (this.exited) return false
    return this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * 结束整棵进程树并等待退出。
   *
   * 幂等：重复调用返回同一个 Promise。超过 5s 仍未退出时抛错，
   * 由调用方决定是否在下次启动前再确认——这里不做无限重试。
   */
  stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopOnce()
    return this.stopPromise
  }

  /** 宿主 `exit` 钩子专用：同步结束，来不及等待。 */
  killSync(): void {
    if (!this.isAlive()) return
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } else {
        this.child.kill('SIGKILL')
      }
    } catch {
      // 进程可能刚好自己退出；exit 钩子里没有补救余地
    }
  }

  /** 读取内存里的日志尾部（不含落盘文件）。 */
  readLogTail(lines: number): Promise<string> {
    return Promise.resolve(this.tail.slice(-Math.max(1, lines)).join('\n'))
  }

  private async stopOnce(): Promise<void> {
    if (!this.isAlive()) {
      this.closeLog()
      return
    }
    await this.killTree()
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (this.isAlive() && Date.now() < deadline) {
      await sleep(STOP_POLL_MS)
    }
    this.closeLog()
    if (this.isAlive()) {
      throw new ExecutorError(`PCBLint 进程 ${this.pid} 在 ${STOP_TIMEOUT_MS / 1000}s 内未退出`)
    }
  }

  private async killTree(): Promise<void> {
    if (process.platform !== 'win32') {
      this.child.kill('SIGKILL')
      return
    }
    await new Promise<void>((done) => {
      spawn('taskkill', ['/PID', String(this.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).once('error', () => done()).once('exit', () => done())
    })
  }

  private finish(): void {
    if (this.exited) return
    this.exited = true
    this.flushPending()
    this.closeLog()
    this.onExit?.()
  }

  private closeLog(): void {
    if (this.log.closed) return
    this.log.end()
  }

  private append(stream: string, chunk: Buffer): void {
    const text = (this.pending.get(stream) ?? '') + chunk.toString('utf-8')
    const lines = text.split(/\r?\n/u)
    this.pending.set(stream, lines.pop() ?? '')
    for (const line of lines) this.pushLine(line)
  }

  /** 进程退出时把没有换行符的最后一段也收进尾部。 */
  private flushPending(): void {
    for (const text of this.pending.values()) {
      if (text) this.pushLine(text)
    }
    this.pending.clear()
  }

  private pushLine(line: string): void {
    const normalized = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
    this.tail.push(normalized)
    if (this.tail.length > TAIL_LINES) this.tail.shift()
    if (!this.log.closed) this.log.write(`${normalized}\n`)
  }
}
