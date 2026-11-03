/**
 * 自适应执行器：在多个 DRC 后端之间做运行时选择、失败回退与来源标注。
 *
 * 设计要点（顺序即执行顺序）：
 *   1. 硬约束过滤 —— 不可用的后端直接出局（探测结果 / 失败冷却）；
 *   2. 优先级分层 —— `backendPriority` 决定先试谁，默认 ['remote', 'local', 'ipc']：
 *      remote（在线服务）是默认事实来源，统一部署、版本可核对、跨机器一致；
 *      remote 不可用或执行失败才按序降级到 local，再降级到 ipc；
 *   3. 稳定打分 —— 基础成本 + 上传惩罚 + 历史耗时，只在**同一层内**做次序，
 *      同分按固定顺序 tie-break，绝不随机；分层在前，所以更快的后端不能插队；
 *   4. 同板粘滞 —— 同一块板（路径 + mtime + 大小）在会话内锁定首次成功的后端，
 *      避免两次 DRC 走了不同后端导致违规数不一致（粘滞优先于分层）；
 *   5. 失败回退 —— 只在 auto 模式下发生；显式指定模式时直接失败并报错，
 *      因为用户已经明确表达了意图，静默换后端会掩盖问题。
 *
 * 三种后端都参与 auto：ipc 的"读不回结果"问题已由华秋定制版的 RunDrc 解决。
 * 定制版缺失时，ipc 的探测会直接判为不可用（原因写进 BackendHealth.reason），
 * 于是自动退化成 local/remote 二选一，不需要额外配置。
 *
 * 口径差异（不是性能问题，要事先讲清）：远程只上传单个 .kicad_pcb，工程级规则
 * （.kicad_pro）与封装库带不过去，remote 的违规条数可能与 local/ipc 不同——
 * 跨后端比较前先看 verifiedBy，别直接拿两个数字相减。
 *
 * @module
 */
import { statSync } from 'node:fs'
import {
  DrcAbortedError,
  ExecutorError,
  isAbortError,
  type BackendHealth,
  type DrcBackendName,
  type DrcExecutor,
  type DrcMode,
  type DrcRunOptions,
  type DrcRunResult,
  type VerifiedBy,
} from './executor.ts'

/** 来源标注定义在执行器层（`DrcRunResult.verifiedBy` 要用），这里只做转出。 */
export type { VerifiedBy } from './executor.ts'

/** 本后端的基础耗时估计（毫秒），仅在没有历史数据时使用。 */
const BASE_COST_MS: Record<DrcBackendName, number> = {
  /** 实测：405KB 板 + 配置隔离 1.2s，含进程启动与落盘。 */
  local: 1_500,
  /** 上传 + 服务端规则引擎 + kicad-cli 原生检查，实测 78 器件板 5.4s（上传 0.2s + lint 5.2s）。 */
  remote: 6_000,
  /**
   * 板已在进程内、规则已在内存里，只剩 DRC 引擎本身的时间（与 local 同一套引擎），
   * 省掉的是进程启动与配置发现，所以略低于 local。
   */
  ipc: 1_200,
}

/** 同分时的固定顺序（稳定、可复现）。 */
const TIE_BREAK: DrcBackendName[] = ['ipc', 'local', 'remote']

/**
 * 默认的后端优先顺序：越靠前越优先。
 *
 * remote（在线服务）是默认的事实来源——它是统一部署、版本可控的一侧；
 * 只有当 remote 不可用或执行失败时，才依次降级到 local（本地 kicad-cli）与 ipc。
 * 可用 `backendPriority` 配置覆盖（例如内网离线环境改成 ['local', 'ipc', 'remote']）。
 */
export const DEFAULT_BACKEND_PRIORITY: DrcBackendName[] = ['remote', 'local', 'ipc']

/** 远程上传的体积惩罚系数（每 MB 增加的毫秒数）。 */
const UPLOAD_MS_PER_MB = 300

/** 同板粘滞的有效期。 */
const STICKY_TTL_MS = 10 * 60_000

/** 粘滞表容量上限。 */
const STICKY_CAP = 32

/** 单次 auto 调用最多尝试的后端数（防止每个后端都超时把总时长拖爆）。 */
const MAX_ATTEMPTS = 3

/** 历史耗时平滑系数。 */
const EWMA_ALPHA = 0.6

/** 选择结果（纯数据，便于单测）。 */
export interface RankedCandidate {
  backend: DrcBackendName
  executor: DrcExecutor
  score: number
  reasons: string[]
}

/** 打分输入。 */
export interface RankInput {
  backends: DrcExecutor[]
  health: Map<DrcBackendName, BackendHealth>
  /** PCB 文件大小（字节）；未知时传 0。 */
  sizeBytes: number
  /** 历史平均耗时（毫秒）。 */
  history: Map<DrcBackendName, number>
  /** 粘滞锁定的后端。 */
  pinned?: DrcBackendName
  /** 后端优先顺序（分层，越靠前越优先）；缺省用 DEFAULT_BACKEND_PRIORITY。 */
  priority?: DrcBackendName[]
}

/** 后端标识缺失时的兜底：按顺序推断。 */
function backendNameOf(executor: DrcExecutor, index: number): DrcBackendName {
  return executor.name ?? (index === 0 ? 'local' : 'remote')
}

/**
 * 对可用后端打分排序（纯函数）。
 *
 * 分数越低越优先；不可用的后端不进入结果。
 */
export function rankBackends(input: RankInput): RankedCandidate[] {
  const { backends, health, sizeBytes, history, pinned } = input
  const priority = input.priority ?? DEFAULT_BACKEND_PRIORITY
  /** 层号：优先序列里的位次；不在序列中的排在最后。 */
  const tierOf = (backend: DrcBackendName): number => {
    const i = priority.indexOf(backend)
    return i < 0 ? priority.length : i
  }
  /** 粘滞后端整体提到最前：它是同一块板已经验证过、结果可比的那一个。 */
  const sortTierOf = (backend: DrcBackendName): number => (backend === pinned ? -1 : tierOf(backend))
  const out: RankedCandidate[] = []

  backends.forEach((executor, index) => {
    const backend = backendNameOf(executor, index)
    const h = health.get(backend)
    // 探测缺失时按"可用"处理：宁可试一次，也不因为没探测就误判没后端。
    if (h && !h.available) return

    const reasons: string[] = []
    let score = history.get(backend) ?? BASE_COST_MS[backend]

    if (backend === 'remote' && sizeBytes > 0) {
      const mb = sizeBytes / (1024 * 1024)
      if (mb > 1) {
        score += Math.round(mb * UPLOAD_MS_PER_MB)
        reasons.push(`板文件 ${mb.toFixed(1)}MB，上传有额外耗时`)
      }
    }

    if (backend === 'local') {
      reasons.push('本地进程内调用，无上传与排队')
    }

    if (pinned === backend) {
      score = -1
      reasons.push('同一块板本次会话已由该后端成功验证，保持结果可比')
    }

    reasons.push(`后端优先序列第 ${tierOf(backend) + 1} 位`)

    out.push({ backend, executor, score, reasons })
  })

  return out.sort((a, b) => {
    // 优先级分层先决：优先序列决定先试谁，分数只在同一层内做次序。
    const tierDiff = sortTierOf(a.backend) - sortTierOf(b.backend)
    if (tierDiff !== 0) return tierDiff
    if (a.score !== b.score) return a.score - b.score
    return TIE_BREAK.indexOf(a.backend) - TIE_BREAK.indexOf(b.backend)
  })
}

/** 自适应执行器。 */
export class AdaptiveExecutor implements DrcExecutor {
  private readonly backends: DrcExecutor[]
  private readonly defaultMode: DrcMode
  private readonly priority: DrcBackendName[]
  private readonly now: () => number
  /** backend → 平滑后的耗时。 */
  private readonly history = new Map<DrcBackendName, number>()
  /** 粘滞：板指纹 → 后端 + 时间戳。 */
  private readonly sticky = new Map<string, { backend: DrcBackendName, at: number }>()

  constructor(
    backends: DrcExecutor[],
    options: { defaultMode?: DrcMode, priority?: DrcBackendName[], now?: () => number } = {},
  ) {
    this.backends = backends
    this.defaultMode = options.defaultMode ?? 'auto'
    this.priority = options.priority ?? DEFAULT_BACKEND_PRIORITY
    this.now = options.now ?? Date.now
  }

  /** 全部后端的能力探测（供工具暴露给 AI）。 */
  async describe(): Promise<Array<BackendHealth & { estimatedMs: number }>> {
    const out: Array<BackendHealth & { estimatedMs: number }> = []
    for (let i = 0; i < this.backends.length; i++) {
      const executor = this.backends[i]!
      const backend = backendNameOf(executor, i)
      const health = await this.probeOne(executor, backend)
      out.push({
        ...health,
        estimatedMs: this.history.get(backend) ?? BASE_COST_MS[backend],
      })
    }
    return out
  }

  async run(options: DrcRunOptions): Promise<DrcRunResult & { verifiedBy: VerifiedBy }> {
    // 已经取消就别再探活/选后端：探活本身要发 HTTP，用户已经不要结果了
    if (options.signal?.aborted) throw new DrcAbortedError()
    const mode = options.mode ?? this.defaultMode
    const fingerprint = this.fingerprintOf(options.pcbPath)
    const sizeBytes = this.sizeOf(options.pcbPath)

    if (mode !== 'auto') {
      const executor = this.backends.find((b, i) => backendNameOf(b, i) === mode)
      if (!executor) {
        throw new ExecutorError(`未配置 ${mode} 后端（可用：${this.backends.map((b, i) => backendNameOf(b, i)).join(', ')}）`)
      }
      const result = await executor.run({ ...options, mode })
      this.record(mode, result.elapsedMs, fingerprint)
      return { ...result, verifiedBy: this.verified(mode, executor, result, []) }
    }

    const health = new Map<DrcBackendName, BackendHealth>()
    for (let i = 0; i < this.backends.length; i++) {
      const executor = this.backends[i]!
      const backend = backendNameOf(executor, i)
      health.set(backend, await this.probeOne(executor, backend))
    }

    const pinned = this.pinnedFor(fingerprint)
    const ranked = rankBackends({
      backends: this.backends,
      health,
      sizeBytes,
      history: this.history,
      priority: this.priority,
      ...(pinned ? { pinned } : {}),
    })

    if (ranked.length === 0) {
      const why = [...health.values()]
        .map((h) => `${h.backend}: ${h.reason ?? '不可用'}`)
        .join('；')
      throw new ExecutorError(`没有可用的 DRC 后端。${why}`)
    }

    const failures: string[] = []
    let fallbackFrom: DrcBackendName | undefined

    for (const candidate of ranked.slice(0, MAX_ATTEMPTS)) {
      try {
        const result = await candidate.executor.run({ ...options, mode })
        this.record(candidate.backend, result.elapsedMs, fingerprint)
        const reasons = [...candidate.reasons, ...(failures.length > 0 ? [`前序后端失败：${failures.join('；')}`] : [])]
        return {
          ...result,
          verifiedBy: {
            ...this.verified(candidate.backend, candidate.executor, result, reasons),
            ...(fallbackFrom ? { fallbackFrom } : {}),
          },
        }
      } catch (e) {
        // 取消不是"这个后端不行"：再换一个后端试只会白烧一次完整 DRC，用户已经不要了
        if (isAbortError(e) || options.signal?.aborted) throw new DrcAbortedError()
        const message = e instanceof Error ? e.message : String(e)
        failures.push(`${candidate.backend} ${message}`)
        if (!fallbackFrom) fallbackFrom = candidate.backend
        // 失败的后端在冷却期内会被 probe 判为不可用；继续尝试下一个
      }
    }

    throw new ExecutorError(`所有 DRC 后端均失败：${failures.join('；')}`)
  }

  /** 包装探测：探测异常一律视为不可用，不向上抛。 */
  private async probeOne(executor: DrcExecutor, backend: DrcBackendName): Promise<BackendHealth> {
    if (!executor.probe) return { backend, available: true, endpoint: backend }
    try {
      return await executor.probe()
    } catch (e) {
      return {
        backend,
        available: false,
        endpoint: backend,
        reason: e instanceof Error ? e.message : String(e),
      }
    }
  }

  private verified(
    backend: DrcBackendName,
    _executor: DrcExecutor,
    result: DrcRunResult,
    reasons: string[],
  ): VerifiedBy {
    const list = reasons.length > 0 ? [...reasons] : ['唯一可用后端']
    if (result.isolatedConfig) list.push('本地配置隔离已启用（规避默认配置发现开销）')
    const out: VerifiedBy = {
      backend,
      endpoint: result.kicadCliPath,
      elapsedMs: result.elapsedMs,
      reasons: list,
    }
    if (result.isolatedConfig !== undefined) out.isolatedConfig = result.isolatedConfig
    return out
  }

  private record(backend: DrcBackendName, elapsedMs: number, fingerprint: string | null): void {
    const prev = this.history.get(backend)
    this.history.set(
      backend,
      prev === undefined ? elapsedMs : Math.round(prev * (1 - EWMA_ALPHA) + elapsedMs * EWMA_ALPHA),
    )
    if (fingerprint) {
      if (this.sticky.size >= STICKY_CAP) {
        const oldest = this.sticky.keys().next().value
        if (oldest !== undefined) this.sticky.delete(oldest)
      }
      this.sticky.set(fingerprint, { backend, at: this.now() })
    }
  }

  private pinnedFor(fingerprint: string | null): DrcBackendName | undefined {
    if (!fingerprint) return undefined
    const hit = this.sticky.get(fingerprint)
    if (!hit) return undefined
    if (this.now() - hit.at > STICKY_TTL_MS) {
      this.sticky.delete(fingerprint)
      return undefined
    }
    return hit.backend
  }

  /** 板指纹：路径 + mtime + 大小；读不到 stat 时返回 null（不参与粘滞）。 */
  private fingerprintOf(pcbPath: string): string | null {
    try {
      const st = statSync(pcbPath)
      return `${pcbPath}|${st.mtimeMs}|${st.size}`
    } catch {
      return null
    }
  }

  private sizeOf(pcbPath: string): number {
    try {
      return statSync(pcbPath).size
    } catch {
      return 0
    }
  }
}
