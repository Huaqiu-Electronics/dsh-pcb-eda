/**
 * 从 drc.json 提取统计摘要，避免把整个 JSON 塞给 AI 导致输出过长。
 */

/** 最小 JSON 值类型（与 dsh-llm 的 JsonValue 结构一致），用于给样例明细定型。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type DrcSummary = {
  totalErrors: number
  totalWarnings: number
  totalExclusions: number
  /** pcblint 的 INFO 级条目（规则引擎给出的"建议人工确认"项，kicad-cli 一般不产出）。 */
  totalInfo: number
  totalIssues: number
  /** issue type → count */
  categories: Record<string, number>
  /** 报告格式：`kicad-cli`（本地/ipc）或 `pcblint`（远程）。两者不可直接比较数字。 */
  format: string
  kicadVersion: string
  sourceFile: string
  date: string
  /** 前 5 条 error 级别明细（原始 drc.json 条目，天然是 JSON 值）。 */
  sampleErrors: JsonValue[]
  /** 已忽略的检查项描述列表 */
  ignoredChecks: string[]
}

/**
 * drc.json 顶层中不是问题列表的字段（不参与统计）。
 *
 * `groups` 是 pcblint 给的分类聚合视图（同一份违规的二次归组），
 * 必须排除，否则违规数会被算两遍。
 */
const NON_ISSUE_SECTIONS = new Set(['ignored_checks', 'groups'])

/** 从一条违规里取"检查类型"：kicad-cli 用 type，pcblint 用 ruleId 或 message 前缀。 */
function issueTypeOf(rec: Record<string, unknown>, section: string): string {
  if (typeof rec.type === 'string' && rec.type) return rec.type
  if (typeof rec.ruleId === 'string' && rec.ruleId) return rec.ruleId
  // pcblint 的 message 形如 `courtyards_overlap: Courtyards overlap`
  const msg = typeof rec.message === 'string' ? rec.message : ''
  const idx = msg.indexOf(':')
  if (idx > 0) return msg.slice(0, idx).trim()
  if (typeof rec.title === 'string' && rec.title) return rec.title
  return section
}

/**
 * 从 drc.json 字符串生成 DrcSummary。
 *
 * 泛化扫描所有顶层数组字段（除 NON_ISSUE_SECTIONS 外），
 * 这样未来 KiCad 版本新增的检查 section 也不会被漏计。
 * 兼容两种报告格式：kicad-cli 原生（severity 小写）与 pcblint（severity 大写）。
 */
export function parseDrcSummary(jsonStr: string): DrcSummary {
  const data = JSON.parse(jsonStr) as Record<string, unknown>

  let totalErrors = 0
  let totalWarnings = 0
  let totalExclusions = 0
  let totalInfo = 0
  const categories: Record<string, number> = {}
  const sampleErrors: JsonValue[] = []

  for (const [section, value] of Object.entries(data)) {
    if (NON_ISSUE_SECTIONS.has(section)) continue
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      // pcblint 的 severity 是大写枚举（ERROR/WARNING/INFO），统一小写后归类
      const sev = typeof rec.severity === 'string' ? rec.severity.toLowerCase() : 'unknown'
      if (sev === 'error') totalErrors++
      else if (sev === 'warning') totalWarnings++
      else if (sev === 'exclusion') totalExclusions++
      else if (sev === 'info') totalInfo++
      const cat = issueTypeOf(rec, section)
      categories[cat] = (categories[cat] ?? 0) + 1
      if (sev === 'error' && sampleErrors.length < 5) {
        // item 来自 JSON.parse，结构上必为 JsonValue
        sampleErrors.push(item as JsonValue)
      }
    }
  }

  const ignoredChecks: string[] = []
  const ignoredRaw = data.ignored_checks
  if (Array.isArray(ignoredRaw)) {
    for (const ic of ignoredRaw) {
      const desc = (ic as Record<string, unknown>)?.description as string
        ?? (ic as Record<string, unknown>)?.key as string
        ?? '?'
      ignoredChecks.push(desc)
    }
  }

  return {
    totalErrors,
    totalWarnings,
    totalExclusions,
    totalInfo,
    totalIssues: totalErrors + totalWarnings + totalExclusions + totalInfo,
    categories,
    format: typeof data.format === 'string' ? data.format : 'kicad-cli',
    kicadVersion: (data.kicad_version as string) ?? 'unknown',
    sourceFile: (data.source as string) ?? '?',
    date: (data.date as string) ?? '?',
    sampleErrors,
    ignoredChecks,
  }
}

/** 取违规坐标：kicad-cli 在 pos 或 items[0].pos，pcblint 在 location。 */
function posOf(rec: Record<string, unknown>): { x?: unknown, y?: unknown } {
  const own = rec.pos as Record<string, unknown> | undefined
  if (own) return { x: own.x, y: own.y }
  const items = rec.items
  if (Array.isArray(items) && items.length > 0) {
    const first = items[0] as Record<string, unknown> | undefined
    const p = first?.pos as Record<string, unknown> | undefined
    if (p) return { x: p.x, y: p.y }
  }
  const loc = rec.location as Record<string, unknown> | undefined
  if (loc) return { x: loc.x, y: loc.y }
  return {}
}

/** 生成纯文本摘要，适合给 AI 模型当 tool 输出。 */
export function formatSummaryText(s: DrcSummary): string {
  const title = s.format === 'pcblint' ? 'DRC 报告摘要（pcblint 语义服务）' : 'KiCad DRC 报告摘要'
  const lines: string[] = [
    title,
    `  报告格式:     ${s.format}`,
    `  KiCad 版本:   ${s.kicadVersion}`,
    `  源文件:       ${s.sourceFile}`,
    `  生成时间:     ${s.date}`,
    '',
    `  ⚠️  总计问题: ${s.totalIssues}`,
    `    - 错误 (error):       ${s.totalErrors}`,
    `    - 警告 (warning):     ${s.totalWarnings}`,
    `    - 排除 (exclusion):   ${s.totalExclusions}`,
    // INFO 是 pcblint 规则引擎的"建议人工确认"项；为 0 时不显示，避免干扰 kicad-cli 报告的原有观感
    ...(s.totalInfo > 0 ? [`    - 提示 (info):        ${s.totalInfo}`] : []),
    '',
    '  按类型分类:',
  ]
  const sorted = Object.entries(s.categories).sort((a, b) => b[1] - a[1])
  for (const [cat, count] of sorted) {
    lines.push(`    - ${cat}: ${count}`)
  }
  if (s.sampleErrors.length > 0) {
    lines.push('')
    lines.push(`  示例错误 (前 ${s.sampleErrors.length} 条):`)
    s.sampleErrors.forEach((e, i) => {
      const item = e as Record<string, unknown>
      const pos = posOf(item)
      // pcblint 的条目没有 description 字段，用 title/message 兜底，避免显示成 "?"
      const desc = item.description ?? item.title ?? item.message ?? '?'
      lines.push(
        `    ${i + 1}. [${item.severity ?? '?'}] ${desc}`
        + `  pos=(${pos.x ?? '?'}, ${pos.y ?? '?'})`,
      )
    })
  }
  if (s.ignoredChecks.length > 0) {
    lines.push('')
    lines.push(`  已忽略的检查项 (${s.ignoredChecks.length}): ${s.ignoredChecks.join(', ')}`)
  }
  return lines.join('\n')
}
