/**
 * 浏览器半边纯函数：从会话节点提取 DRC 预览载荷、把 drc.json 归一化成扁平违规列表。
 *
 * 本模块不依赖 React / DOM，node:test 可直接单测（test/client-parse.test.ts）。
 * 渲染组件在 index.tsx。
 */

/** 工具名（与 host 端 src/tools.ts 的 TOOL_NAME 保持一致；client bundle 不能 import host 代码）。 */
export const DRC_TOOL_NAME = 'kicad_drc_run'

/** 客户端预览载荷：host render() 输出的第二块 JSON 文本。 */
export interface DrcPreview {
  ok: true
  viewUrl: string
  key?: string
  name?: string
}

/** 归一化后的单条违规（新旧两种 KiCad 报告格式统一）。 */
export interface DrcViolation {
  severity: string
  type: string
  description: string
  x?: number
  y?: number
}

/** 归一化后的整份报告。 */
export interface DrcReportData {
  violations: DrcViolation[]
  kicadVersion: string
  sourceFile: string
  totalErrors: number
  totalWarnings: number
  totalExclusions: number
  totalIssues: number
}

/** 会话树遍历深度上限（防御病态嵌套）。 */
const MAX_WALK_DEPTH = 100

/**
 * 从一个 tool-result 节点里取出预览载荷。
 * 先逐块 JSON.parse（host 的 render 会额外回一块 {ok, viewUrl} JSON）；失败则正则兜底。
 */
export function pickPreview(node: unknown): DrcPreview | null {
  const n = node as { content?: Array<{ type?: string; text?: string }> } | null
  const blocks = (Array.isArray(n?.content) ? n.content : []).filter((b) => b?.type === 'text')
  for (const b of blocks) {
    try {
      const v = JSON.parse(String(b.text)) as Record<string, unknown>
      if (v && v.ok === true && typeof v.viewUrl === 'string') {
        return {
          ok: true,
          viewUrl: v.viewUrl,
          key: typeof v.key === 'string' ? v.key : undefined,
          name: typeof v.name === 'string' ? v.name : undefined,
        }
      }
    } catch { /* 非 JSON 块，继续 */ }
  }
  const joined = blocks.map((b) => String(b.text ?? '')).join('\n')
  const m = joined.match(/\/drc-report\/api\/report\?key=([\w.-]+)/)
  if (m) return { ok: true, viewUrl: m[0], key: m[1] }
  return null
}

/**
 * 遍历会话树，索引所有成功的 kicad_drc_run tool-result：
 * - byTurn: assistant turn 号 → 该轮预览载荷（turnTail 插槽按此渲染）
 * - latest: 最近一次预览载荷
 */
export function indexPreviews(nodes: unknown[]): { byTurn: Map<number, DrcPreview>, latest: DrcPreview | null } {
  const visited = new Set<unknown>()
  const byCallId = new Map<string, DrcPreview>()
  let latest: DrcPreview | null = null

  // 第一遍：收集 tool-result → callId 索引
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH || visited.has(node)) return
    const n = node as Record<string, unknown>
    visited.add(n)
    const call = n.call as { name?: string } | undefined
    if (n.kind === 'tool-result' && call?.name === DRC_TOOL_NAME && !n.isError) {
      const p = pickPreview(n)
      if (p) {
        const callId = n.callId
        if (callId != null) byCallId.set(String(callId), p)
        latest = p
      }
    }
    const kids = (Array.isArray(n.children) ? n.children : Array.isArray(n.nodes) ? n.nodes : []) as unknown[]
    for (const k of kids) walk(k, depth + 1)
    if (Array.isArray(n.subCalls)) for (const k of n.subCalls as unknown[]) walk(k, depth + 1)
  }
  for (const root of nodes) walk(root, 0)

  // 第二遍：assistant 轮次 → tool-call 的 callId → 预览载荷
  const byTurn = new Map<number, DrcPreview>()
  const visited2 = new Set<unknown>()
  const walkTurns = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH || visited2.has(node)) return
    const n = node as Record<string, unknown>
    visited2.add(n)
    if (n.kind === 'assistant') {
      for (const b of (Array.isArray(n.blocks) ? n.blocks : []) as Array<Record<string, unknown>>) {
        if (b?.kind !== 'tool-call' || b.name !== DRC_TOOL_NAME) continue
        const callId = b.callId
        const p = callId != null ? byCallId.get(String(callId)) ?? null : null
        if (p && typeof n.turn === 'number') byTurn.set(n.turn as number, p)
      }
    }
    const kids = (Array.isArray(n.children) ? n.children : Array.isArray(n.nodes) ? n.nodes : []) as unknown[]
    for (const k of kids) walkTurns(k, depth + 1)
    if (Array.isArray(n.subCalls)) for (const k of n.subCalls as unknown[]) walkTurns(k, depth + 1)
  }
  for (const root of nodes) walkTurns(root, 0)

  return { byTurn, latest }
}

/** KiCad 报告里的问题数组之外、需要跳过的顶层字段。 */
const NON_ISSUE_SECTIONS = new Set(['ignored_checks'])

/** 从 violation 条目取坐标：旧格式在顶层 pos，KiCad 10 在 items[0].pos。 */
function posOf(it: Record<string, unknown>): { x?: number, y?: number } {
  const p = it.pos as Record<string, unknown> | undefined
  if (p && typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }
  const items = it.items
  if (Array.isArray(items) && items.length > 0) {
    const first = items[0] as Record<string, unknown> | undefined
    const sp = first?.pos as Record<string, unknown> | undefined
    if (sp && typeof sp.x === 'number' && typeof sp.y === 'number') return { x: sp.x, y: sp.y }
  }
  return {}
}

/**
 * 把 drc.json 原始文本归一化成扁平违规列表。
 * 兼容两种格式：旧版按检查类型分顶层数组（clearance/track_width/…），
 * KiCad 10 统一 violations 数组（条目自带 type 字段）。
 */
export function normalizeDrcReport(raw: string): DrcReportData {
  const data = JSON.parse(raw) as Record<string, unknown>
  const violations: DrcViolation[] = []
  for (const [sectionName, value] of Object.entries(data)) {
    if (!Array.isArray(value) || NON_ISSUE_SECTIONS.has(sectionName)) continue
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const it = item as Record<string, unknown>
      violations.push({
        severity: typeof it.severity === 'string' ? it.severity : '',
        type: typeof it.type === 'string' ? it.type : sectionName,
        description: typeof it.description === 'string' ? it.description : '',
        ...posOf(it),
      })
    }
  }
  const totalErrors = violations.filter((v) => v.severity === 'error').length
  const totalWarnings = violations.filter((v) => v.severity === 'warning').length
  const totalExclusions = violations.filter((v) => v.severity === 'exclusion').length
  return {
    violations,
    kicadVersion: typeof data.kicad_version === 'string' ? data.kicad_version : '',
    sourceFile: typeof data.source === 'string' ? data.source : '',
    totalErrors,
    totalWarnings,
    totalExclusions,
    totalIssues: violations.length,
  }
}
