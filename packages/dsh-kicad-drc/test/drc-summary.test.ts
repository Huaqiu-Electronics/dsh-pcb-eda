import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDrcSummary, formatSummaryText } from '../src/drc-summary.ts'

const SAMPLE_DRC_JSON = JSON.stringify({
  date: '2026-07-08 10:00:00',
  kicad_version: '9.0.0',
  source: 'demo.kicad_pcb',
  unconnected_items: [
    { severity: 'error', type: 'unconnected_item', description: 'Unconnected pad (F1-1)', pos: { x: 12.5, y: 34 } },
    { severity: 'warning', type: 'unconnected_item', description: 'Possible unconnected' },
  ],
  clearance: [
    { severity: 'error', type: 'clearance', description: 'Clearance violation A', pos: { x: 1, y: 2 } },
    { severity: 'error', type: 'clearance', description: 'Clearance violation B' },
    { severity: 'exclusion', type: 'clearance', description: 'Excluded item' },
  ],
  // 模拟未来 KiCad 版本新增的 section：泛化扫描必须能统计到
  future_check: [
    { severity: 'warning', type: 'new_rule', description: 'From a future version' },
  ],
  ignored_checks: [
    { description: 'Zone connectivity check' },
    { key: 'schematic_parity' },
  ],
})

test('parseDrcSummary 按严重级别统计数量', () => {
  const s = parseDrcSummary(SAMPLE_DRC_JSON)
  assert.equal(s.totalErrors, 3)
  assert.equal(s.totalWarnings, 2)
  assert.equal(s.totalExclusions, 1)
  assert.equal(s.totalIssues, 6)
})

test('parseDrcSummary 按 type 分类并扫描未知 section', () => {
  const s = parseDrcSummary(SAMPLE_DRC_JSON)
  assert.deepEqual(s.categories, { unconnected_item: 2, clearance: 3, new_rule: 1 })
  assert.equal(s.kicadVersion, '9.0.0')
  assert.equal(s.sourceFile, 'demo.kicad_pcb')
  assert.equal(s.date, '2026-07-08 10:00:00')
})

test('parseDrcSummary 示例错误最多取 5 条', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ severity: 'error', type: 'clearance', description: `e${i}` }))
  const s = parseDrcSummary(JSON.stringify({ clearance: items }))
  assert.equal(s.totalErrors, 8)
  assert.equal(s.sampleErrors.length, 5)
})

test('parseDrcSummary 解析 ignored_checks（description 优先于 key）', () => {
  const s = parseDrcSummary(SAMPLE_DRC_JSON)
  assert.deepEqual(s.ignoredChecks, ['Zone connectivity check', 'schematic_parity'])
})

test('parseDrcSummary 空报告返回全零', () => {
  const s = parseDrcSummary('{}')
  assert.equal(s.totalIssues, 0)
  assert.deepEqual(s.categories, {})
  assert.equal(s.kicadVersion, 'unknown')
  assert.equal(s.sourceFile, '?')
})

test('parseDrcSummary 跳过非对象条目', () => {
  const s = parseDrcSummary(JSON.stringify({ clearance: [null, 'oops', { severity: 'error', type: 'clearance' }] }))
  assert.equal(s.totalErrors, 1)
  assert.deepEqual(s.categories, { clearance: 1 })
})

test('parseDrcSummary 支持 KiCad 10 统一 violations 数组格式', () => {
  const json = JSON.stringify({
    kicad_version: '10.0.6', source: 'b.kicad_pcb', date: '2026-09-24T14:47:35',
    coordinate_units: 'mm',
    included_severities: ['error', 'warning', 'exclusion'], // 字符串数组，不应被计入问题
    violations: [
      { severity: 'error', type: 'track_width', description: '走线宽度不足', items: [{ pos: { x: 50, y: 50 } }] },
      { severity: 'warning', type: 'silk_edge_clearance', description: '丝印离板边太近' },
    ],
    ignored_checks: [{ description: 'no courtyard' }],
  })
  const s = parseDrcSummary(json)
  assert.equal(s.totalErrors, 1)
  assert.equal(s.totalWarnings, 1)
  assert.deepEqual(s.categories, { track_width: 1, silk_edge_clearance: 1 })
})

test('formatSummaryText 从 KiCad 10 格式 items[0].pos 取坐标', () => {
  const json = JSON.stringify({
    kicad_version: '10.0.6', source: 'b.kicad_pcb', date: '2026-09-24T14:47:35',
    violations: [
      { severity: 'error', type: 'track_width', description: '走线宽度不足', items: [{ pos: { x: 50, y: 50 } }] },
    ],
  })
  const text = formatSummaryText(parseDrcSummary(json))
  assert.match(text, /pos=\(50, 50\)/)
})

test('formatSummaryText 包含关键行', () => {
  const text = formatSummaryText(parseDrcSummary(SAMPLE_DRC_JSON))
  assert.match(text, /KiCad DRC 报告摘要/)
  assert.match(text, /总计问题: 6/)
  assert.match(text, /错误 \(error\):\s+3/)
  assert.match(text, /clearance: 3/)
  assert.match(text, /示例错误/)
  assert.match(text, /已忽略的检查项 \(2\)/)
})
