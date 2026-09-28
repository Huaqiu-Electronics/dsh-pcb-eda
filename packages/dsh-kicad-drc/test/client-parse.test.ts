import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickPreview, indexPreviews, normalizeDrcReport, DRC_TOOL_NAME } from '../src/client/parse.ts'

test('pickPreview：从 content 块解析 {ok, viewUrl} JSON', () => {
  const node = {
    kind: 'tool-result',
    call: { name: DRC_TOOL_NAME },
    content: [
      { type: 'text', text: 'KiCad DRC 报告摘要\n  ⚠️ 总计问题: 2' },
      { type: 'text', text: JSON.stringify({ ok: true, viewUrl: '/drc-report/api/report?key=drc-123', key: 'drc-123', name: 'board.kicad_pcb' }) },
    ],
  }
  const p = pickPreview(node)
  assert.ok(p)
  assert.equal(p.viewUrl, '/drc-report/api/report?key=drc-123')
  assert.equal(p.name, 'board.kicad_pcb')
})

test('pickPreview：无 JSON 块时正则兜底', () => {
  const node = {
    content: [{ type: 'text', text: '报告地址 /drc-report/api/report?key=abc-456 已登记' }],
  }
  const p = pickPreview(node)
  assert.ok(p)
  assert.equal(p.key, 'abc-456')
})

test('pickPreview：无载荷 → null', () => {
  assert.equal(pickPreview({ content: [{ type: 'text', text: '普通文本' }] }), null)
  assert.equal(pickPreview(null), null)
})

test('indexPreviews：按轮次索引成功的 DRC 结果，忽略其他工具与错误结果', () => {
  const previewJson = JSON.stringify({ ok: true, viewUrl: '/drc-report/api/report?key=drc-1' })
  const nodes = [
    {
      kind: 'assistant', turn: 3,
      blocks: [{ kind: 'tool-call', name: DRC_TOOL_NAME, callId: 'c1' }],
      children: [
        { kind: 'tool-result', call: { name: DRC_TOOL_NAME }, callId: 'c1', isError: false, content: [{ type: 'text', text: previewJson }] },
      ],
    },
    {
      kind: 'assistant', turn: 4,
      blocks: [{ kind: 'tool-call', name: 'read_file', callId: 'c2' }],
      children: [
        { kind: 'tool-result', call: { name: 'read_file' }, callId: 'c2', isError: false, content: [{ type: 'text', text: previewJson }] },
      ],
    },
    {
      kind: 'assistant', turn: 5,
      blocks: [{ kind: 'tool-call', name: DRC_TOOL_NAME, callId: 'c3' }],
      children: [
        { kind: 'tool-result', call: { name: DRC_TOOL_NAME }, callId: 'c3', isError: true, content: [] },
      ],
    },
  ]
  const { byTurn, latest } = indexPreviews(nodes)
  assert.equal(byTurn.size, 1)
  assert.ok(byTurn.get(3))
  assert.equal(byTurn.get(3)?.viewUrl, '/drc-report/api/report?key=drc-1')
  assert.equal(byTurn.has(4), false, '其他工具不应索引')
  assert.equal(byTurn.has(5), false, '错误结果不应索引')
  assert.ok(latest)
})

test('normalizeDrcReport：KiCad 10 统一 violations 格式（坐标在 items[0].pos）', () => {
  const raw = JSON.stringify({
    kicad_version: '10.0.6', source: 'board.kicad_pcb', date: '2026-09-24T14:47:35',
    included_severities: ['error', 'warning'],
    violations: [
      { severity: 'error', type: 'track_width', description: '走线宽度不足', items: [{ pos: { x: 50, y: 50 } }] },
      { severity: 'warning', type: 'silk_edge_clearance', description: '丝印离板边太近' },
    ],
    ignored_checks: [{ description: 'no courtyard' }],
  })
  const d = normalizeDrcReport(raw)
  assert.equal(d.totalIssues, 2)
  assert.equal(d.totalErrors, 1)
  assert.equal(d.totalWarnings, 1)
  assert.equal(d.kicadVersion, '10.0.6')
  assert.equal(d.sourceFile, 'board.kicad_pcb')
  const err = d.violations.find((v) => v.severity === 'error')
  assert.ok(err)
  assert.equal(err.x, 50)
  assert.equal(err.y, 50)
})

test('normalizeDrcReport：旧版按 section 分数组格式（坐标在顶层 pos）', () => {
  const raw = JSON.stringify({
    kicad_version: '8.0.2', source: 'old.kicad_pcb',
    clearance: [{ severity: 'error', type: 'clearance', description: '间距不足', pos: { x: 1, y: 2 } }],
    track_width: [{ severity: 'warning', type: 'track_width', description: '走线过细' }],
    ignored_checks: ['a', 'b'],
  })
  const d = normalizeDrcReport(raw)
  assert.equal(d.totalIssues, 2)
  const c = d.violations.find((v) => v.type === 'clearance')
  assert.ok(c)
  assert.equal(c.x, 1)
  assert.equal(c.y, 2)
})
