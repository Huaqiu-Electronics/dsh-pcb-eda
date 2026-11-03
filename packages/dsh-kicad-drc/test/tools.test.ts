// 本文件已在 devDependencies 对齐 @deepseek-ai/dsh-tools@^0.2.1-rc.2 后纳入 `pnpm test`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDrcTool, createBackendsTool, TOOL_NAME } from '../src/tools.ts'
import type { DrcExecutor, DrcRunOptions, DrcRunResult } from '../src/executor.ts'

/** 一份最小的 KiCad 10 报告，足以让 parseDrcSummary 工作。 */
const REPORT = JSON.stringify({
  kicad_version: '10.0.6',
  source: 'board.kicad_pcb',
  date: '2026-10-21T00:00:00',
  ignored_checks: [],
  violations: [
    { severity: 'warning', type: 'hole_to_hole', description: '钻孔太靠近其他孔', items: [{ pos: { x: 1, y: 2 } }] },
  ],
  unconnected_items: [{ severity: 'error', description: '未连接', items: [{ pos: { x: 3, y: 4 } }] }],
})

function fakeExecutor(overrides: Partial<DrcRunResult> = {}, verifiedBy?: unknown): DrcExecutor {
  const result = {
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    drcJson: REPORT,
    elapsedMs: 1234,
    timedOut: false,
    kicadCliPath: 'D:/KiCad/kicad-cli.exe',
    command: 'kicad-cli pcb drc ...',
    drcJsonPath: 'D:/proj/board_drc.json',
    ...overrides,
    ...(verifiedBy ? { verifiedBy } : {}),
  } as DrcRunResult & { verifiedBy?: unknown }
  return { async run(_o: DrcRunOptions) { return result } }
}

/** 直接调用工具 execute（绕过 DSH 的参数校验，只测我们自己的逻辑）。 */
async function run(tool: unknown, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const t = tool as { execute(a: unknown, e: unknown): Promise<Record<string, unknown>> }
  return t.execute(args, { signal: new AbortController().signal })
}

test('工具名与后端探测工具名保持稳定', () => {
  assert.equal(TOOL_NAME, 'kicad_drc_run')
})

test('execute：把自适应执行器的来源标注透传到输出', async () => {
  const tool = createDrcTool(
    fakeExecutor({}, { backend: 'remote', endpoint: 'remote:http://x', elapsedMs: 900, reasons: ['本地不可用'] }),
    600,
  )
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  const verified = out.verifiedBy as Record<string, unknown>
  assert.equal(verified.backend, 'remote')
  assert.deepEqual(verified.reasons, ['本地不可用'])
})

test('execute：没有自适应标注时按 kicadCliPath 推断后端', async () => {
  const tool = createDrcTool(fakeExecutor({ kicadCliPath: 'remote:http://pcblint' }), 600)
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  assert.equal((out.verifiedBy as Record<string, unknown>).backend, 'remote')
})

test('execute：默认不返回完整 JSON，显式请求才返回', async () => {
  const tool = createDrcTool(fakeExecutor(), 600)
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  assert.equal(out.drcJson, undefined)

  const tool2 = createDrcTool(fakeExecutor(), 600)
  const out2 = await run(tool2, { pcbPath: 'D:/proj/board.kicad_pcb', includeFullJson: true })
  assert.equal(typeof out2.drcJson, 'string')
})

test('execute：摘要统计包含 unconnected_items（KiCad 语义里它们是 error）', async () => {
  const tool = createDrcTool(fakeExecutor(), 600)
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  const summary = out.drcSummary as Record<string, unknown>
  assert.equal(summary.totalErrors, 1)
  assert.equal(summary.totalWarnings, 1)
  assert.equal(summary.totalIssues, 2)
  assert.equal(summary.kicadVersion, '10.0.6')
})

test('execute：执行器抛错时转成结构化失败输出', async () => {
  const failing: DrcExecutor = { async run() { throw new Error('找不到 kicad-cli') } }
  const tool = createDrcTool(failing, 600)
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  assert.equal(out.success, false)
  assert.equal(out.exitCode, -1)
  assert.match(String(out.stderr), /找不到 kicad-cli/)
})

test('execute：登记报告后返回 viewUrl', async () => {
  const registered: Array<[string, string]> = []
  const tool = createDrcTool(fakeExecutor(), 600, (key, p) => registered.push([key, p]))
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0]![1], 'D:/proj/board_drc.json')
  assert.match(String(out.viewUrl), /^\/drc-report\/api\/report\?key=drc-/)
})

test('render：有 viewUrl 时输出摘要块 + 客户端预览 JSON 块', () => {
  const tool = createDrcTool(fakeExecutor(), 600) as unknown as {
    output: { render(a: unknown, v: unknown): Array<{ type: string, text: string }> }
  }
  const blocks = tool.output.render(
    { pcbPath: 'D:/proj/board.kicad_pcb' },
    {
      drcSummary: {
        totalIssues: 1,
        totalErrors: 0,
        totalWarnings: 1,
        totalExclusions: 0,
        totalInfo: 0,
        categories: { silk_overlap: 1 },
        format: 'kicad-cli',
        kicadVersion: '10.0.6',
        sourceFile: 'board.kicad_pcb',
        date: '2026-11-03T00:00:00Z',
        sampleErrors: [],
        ignoredChecks: [],
      },
      drcJsonPath: 'D:/proj/board_drc.json',
      viewUrl: '/drc-report/api/report?key=drc-abc',
    },
  )
  assert.equal(blocks.length, 2)
  assert.match(blocks[0]!.text, /KiCad DRC 报告摘要/)
  const payload = JSON.parse(blocks[1]!.text) as Record<string, unknown>
  assert.equal(payload.ok, true)
  assert.equal(payload.key, 'drc-abc')
  assert.equal(payload.name, 'board.kicad_pcb')
})

test('后端探测工具：把探测结果原样返回', async () => {
  const tool = createBackendsTool(async () => [
    { backend: 'local', available: true, endpoint: 'D:/kicad-cli.exe', estimatedMs: 1200 },
    { backend: 'remote', available: false, endpoint: 'http://x', estimatedMs: 9000, reason: '冷却期' },
  ])
  const out = await run(tool, {})
  const list = out.backends as Array<Record<string, unknown>>
  assert.equal(list.length, 2)
  assert.equal(list[0]!.available, true)
  assert.equal(list[1]!.reason, '冷却期')
})

test('render：ipc 后端无报告时给出"已执行但没取回结果"而不是"未生成报告"', () => {
  const tool = createDrcTool(fakeExecutor(), 600) as unknown as {
    output: { render(a: unknown, v: unknown): Array<{ type: string, text: string }> }
  }
  const blocks = tool.output.render(
    { pcbPath: 'D:/proj/board.kicad_pcb' },
    { verifiedBy: { backend: 'ipc' }, stderr: '' },
  )
  assert.match(blocks[0]!.text, /已在 KiCad 中执行 DRC/)
  assert.doesNotMatch(blocks[0]!.text, /未生成报告/)
})

test('render：普通后端无报告时仍说"未生成报告"', () => {
  const tool = createDrcTool(fakeExecutor(), 600) as unknown as {
    output: { render(a: unknown, v: unknown): Array<{ type: string, text: string }> }
  }
  const blocks = tool.output.render({ pcbPath: 'x' }, { verifiedBy: { backend: 'local' } })
  assert.match(blocks[0]!.text, /未生成报告/)
})

test('execute：服务端没跑 kicad-cli 时标 reportComplete=false，并把警示写在摘要最前面', async () => {
  const tool = createDrcTool(
    fakeExecutor({
      reportFormat: 'pcblint',
      metrics: { suppressedCount: 0, kicadDrcUsed: false, rulesExecuted: 11, drcRulesCount: 5 },
    }),
    600,
  )
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  assert.equal(out.reportComplete, false)
  // 结构化字段里也要留痕：有些消费方只读 verifiedBy，不看正文
  const reasons = (out.verifiedBy as { reasons: string[] }).reasons
  assert.match(reasons.join('\n'), /规则引擎结果（不完整）/)

  const blocks = (tool as unknown as {
    output: { render(a: unknown, v: unknown): Array<{ type: string, text: string }> }
  }).output.render({ pcbPath: 'D:/proj/board.kicad_pcb' }, out)
  // 必须在第一条：模型读到的正文以它开头，就不可能把条数当成完整结论
  assert.match(blocks[0]!.text, /^⚠️ 报告不完整/)
})

test('execute：兜底推断认得 ipc 前缀，不会把 ipc 标成 local', async () => {
  const tool = createDrcTool(fakeExecutor({ kicadCliPath: 'ipc:10.0.6' }), 600)
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  assert.equal((out.verifiedBy as Record<string, unknown>).backend, 'ipc')
})

test('execute：drcRules 参数解析成稀疏映射传给执行器，非法项跳过不致命', async () => {
  const seen: DrcRunOptions[] = []
  const recording: DrcExecutor = {
    async run(options) {
      seen.push(options)
      return fakeExecutor().run(options)
    },
  }
  const tool = createDrcTool(recording, 600)
  await run(tool, {
    pcbPath: 'D:/proj/board.kicad_pcb',
    drcRules: 'silk_edge_clearance=error, unconnected_items=ignore, bad-item, lib_footprint_issues=verbose',
  })
  // 拼错的两项（bad-item、severity=verbose）被跳过，合法项仍然生效
  assert.deepEqual(seen[0]!.drcRuleOverrides, {
    silk_edge_clearance: 'error',
    unconnected_items: 'ignore',
  })
})

test('execute：内置规则开关全关（drcRulesCount=0）时同样标 reportComplete=false', async () => {
  const tool = createDrcTool(fakeExecutor({
    reportFormat: 'pcblint',
    metrics: { suppressedCount: 0, kicadDrcUsed: true, rulesExecuted: 11, drcRulesCount: 0 },
  }), 600)
  const out = await run(tool, { pcbPath: 'D:/proj/board.kicad_pcb' })
  assert.equal(out.reportComplete, false)
  // kicadDrcUsed=true 时也要能区分出"开关全关"这第二种不完整
  const reasons = (out.verifiedBy as { reasons: string[] }).reasons
  assert.match(reasons.join('\n'), /drcRulesCount=0/)
})
