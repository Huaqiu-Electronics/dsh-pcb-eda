/**
 * 执行器接口 + 结果类型。
 * 两种实现：本地 subprocess（LocalExecutor）和远程 cli-runner（RemoteExecutor）。
 */

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
}

/** 执行器选项。 */
export interface DrcRunOptions {
  /** .kicad_pcb 文件绝对路径。 */
  pcbPath: string
  /** 启用所有严重级别。 */
  severityAll?: boolean
  /** DRC 前重绘填充区。 */
  refillZones?: boolean
  /** 报告所有走线错误。 */
  allTrackErrors?: boolean
  /** 超时秒数。 */
  timeoutSeconds?: number
}

/** 执行器抽象接口。 */
export interface DrcExecutor {
  /** 执行 kicad-cli pcb drc 并返回结果。 */
  run(options: DrcRunOptions): Promise<DrcRunResult>
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutorError'
  }
}
