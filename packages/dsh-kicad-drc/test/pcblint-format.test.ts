/**
 * pcblint 报告格式的兼容性测试。
 *
 * remote 后端返回的是 pcblint 语义服务格式（顶层 violations、severity 大写、
 * 带 confidence/backend/groups），与 local/ipc 的 kicad-cli 原生格式不同。
 * 摘要与浏览器卡片都必须能正确读懂它，否则 remote 的结果会被统计成 0 条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDrcSummary, formatSummaryText } from '../src/drc-summary.ts'
import { normalizeDrcReport } from '../src/client/parse.ts'

/** 与 RemoteExecutor 落盘结构一致的样本（外层 4 个字段由插件补，内层原样来自服务端）。 */
const PCB_LINT_REPORT = JSON.stringify({
  format: 'pcblint',
  source: 'board.kicad_pcb',
  date: '2026-10-29T10:00:00.000Z',
  endpoint: 'http://127.0.0.1:8096',
  kicadDrcAvailable: true,
  kicadDrcUsed: true,
  rulesExecuted: 26,
  suppressedCount: 2,
  violations: [
    {
      ruleId: '', title: 'Courtyards overlap', severity: 'ERROR', confidence: 'HIGH',
      message: 'courtyards_overlap: Courtyards overlap',
      location: { x: 138.255, y: 94.059 }, objects: ['C13', 'OLED1'], backend: 'EDA_DRC',
    },
    {
      ruleId: '', title: 'Silkscreen overlap', severity: 'WARNING', confidence: 'HIGH',
      message: 'silk_overlap: Silkscreen overlap',
      location: { x: 10, y: 20 }, objects: ['R1'], backend: 'EDA_DRC',
    },
    {
      ruleId: 'crystal_ground_plane', title: '晶振下方应有完整地平面', severity: 'INFO', confidence: 'MEDIUM',
      message: '请确认 Y1 晶振下方有完整的接地平面', location: { x: 145.494, y: 79.835 },
      objects: ['Y1'], backend: 'NATIVE',
    },
  ],
  groups: [
    { backend: 'EDA_DRC', severity: 'ERROR', count: 1, key: 'courtyards_overlap' },
    { backend: 'EDA_DRC', severity: 'WARNING', count: 1, key: 'silk_overlap' },
  ],
})

test('parseDrcSummary 读得懂 pcblint 格式：severity 大写、groups 不重复计数', () => {
  const s = parseDrcSummary(PCB_LINT_REPORT)
  assert.equal(s.format, 'pcblint')
  assert.equal(s.totalErrors, 1)
  assert.equal(s.totalWarnings, 1)
  // groups 是同一批违规的聚合视图，不能被当成额外违规；INFO 单独计数但不丢
  assert.equal(s.totalInfo, 1)
  assert.equal(s.totalIssues, 3)
  assert.equal(s.sourceFile, 'board.kicad_pcb')
  assert.equal(s.date, '2026-10-29T10:00:00.000Z')
})

test('parseDrcSummary 对 pcblint 条目按 ruleId 或 message 前缀分类', () => {
  const s = parseDrcSummary(PCB_LINT_REPORT)
  assert.deepEqual(s.categories, {
    courtyards_overlap: 1,
    silk_overlap: 1,
    crystal_ground_plane: 1,
  })
})

test('formatSummaryText 对 pcblint 报告取 location 坐标并回退 title 作描述', () => {
  const text = formatSummaryText(parseDrcSummary(PCB_LINT_REPORT))
  assert.match(text, /DRC 报告摘要（pcblint 语义服务）/)
  assert.match(text, /报告格式:\s+pcblint/)
  assert.match(text, /\[ERROR\] Courtyards overlap\s+pos=\(138\.255, 94\.059\)/)
  assert.match(text, /提示 \(info\):\s+1/)
  assert.match(text, /总计问题: 3/)
})

test('normalizeDrcReport 把 pcblint 条目归一化成扁平列表（severity 小写、location 取坐标）', () => {
  const d = normalizeDrcReport(PCB_LINT_REPORT)
  assert.equal(d.totalIssues, 3)
  assert.equal(d.totalErrors, 1)
  assert.equal(d.totalWarnings, 1)
  assert.equal(d.sourceFile, 'board.kicad_pcb')

  const err = d.violations.find((v) => v.severity === 'error')
  assert.ok(err)
  assert.equal(err.type, 'courtyards_overlap')
  assert.equal(err.description, 'Courtyards overlap')
  assert.equal(err.x, 138.255)
  assert.equal(err.y, 94.059)
})
