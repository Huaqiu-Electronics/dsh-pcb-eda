/**
 * 从 drc.json 提取统计摘要，避免把整个 JSON 塞给 AI 导致输出过长。
 */

/** 最小 JSON 值类型（与 dsh-llm 的 JsonValue 结构一致），用于给样例明细定型。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type DrcSummary = {
  totalErrors: number
  totalWarnings: number
  totalExclusions: number
  totalIssues: number
  /** issue type → count */
  categories: Record<string, number>
  kicadVersion: string
  sourceFile: string
  date: string
  /** 前 5 条 error 级别明细（原始 drc.json 条目，天然是 JSON 值）。 */
  sampleErrors: JsonValue[]
  /** 已忽略的检查项描述列表 */
  ignoredChecks: string[]
}

/** drc.json 顶层中不是问题列表的字段（不参与统计）。 */
const NON_ISSUE_SECTIONS = new Set(['ignored_checks'])

/**
 * 从 drc.json 字符串生成 DrcSummary。
 *
 * 泛化扫描所有顶层数组字段（除 NON_ISSUE_SECTIONS 外），
 * 这样未来 KiCad 版本新增的检查 section 也不会被漏计。
 */
export function parseDrcSummary(jsonStr: string): DrcSummary {
  const data = JSON.parse(jsonStr) as Record<string, unknown>

  let totalErrors = 0
  let totalWarnings = 0
  let totalExclusions = 0
  const categories: Record<string, number> = {}
  const sampleErrors: JsonValue[] = []

  for (const [section, value] of Object.entries(data)) {
    if (NON_ISSUE_SECTIONS.has(section)) continue
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const sev = typeof rec.severity === 'string' ? rec.severity : 'unknown'
      if (sev === 'error') totalErrors++
      else if (sev === 'warning') totalWarnings++
      else if (sev === 'exclusion') totalExclusions++
      const cat = typeof rec.type === 'string' ? rec.type : section
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
    totalIssues: totalErrors + totalWarnings + totalExclusions,
    categories,
    kicadVersion: (data.kicad_version as string) ?? 'unknown',
    sourceFile: (data.source as string) ?? '?',
    date: (data.date as string) ?? '?',
    sampleErrors,
    ignoredChecks,
  }
}

/** 生成纯文本摘要，适合给 AI 模型当 tool 输出。 */
export function formatSummaryText(s: DrcSummary): string {
  const lines: string[] = [
    'KiCad DRC 报告摘要',
    `  KiCad 版本:   ${s.kicadVersion}`,
    `  源文件:       ${s.sourceFile}`,
    `  生成时间:     ${s.date}`,
    '',
    `  ⚠️  总计问题: ${s.totalIssues}`,
    `    - 错误 (error):       ${s.totalErrors}`,
    `    - 警告 (warning):     ${s.totalWarnings}`,
    `    - 排除 (exclusion):   ${s.totalExclusions}`,
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
      // KiCad 10 的 violation 条目顶层没有 pos，坐标在子项 items[].pos 里；旧格式则直接在顶层
      let pos = item.pos as Record<string, unknown> | undefined
      if (!pos && Array.isArray(item.items) && item.items.length > 0) {
        const first = item.items[0] as Record<string, unknown> | undefined
        pos = first?.pos as Record<string, unknown> | undefined
      }
      lines.push(
        `    ${i + 1}. [${item.severity ?? '?'}] ${item.description ?? '?'}`
        + `  pos=(${pos?.x ?? '?'}, ${pos?.y ?? '?'})`,
      )
    })
  }
  if (s.ignoredChecks.length > 0) {
    lines.push('')
    lines.push(`  已忽略的检查项 (${s.ignoredChecks.length}): ${s.ignoredChecks.join(', ')}`)
  }
  return lines.join('\n')
}
