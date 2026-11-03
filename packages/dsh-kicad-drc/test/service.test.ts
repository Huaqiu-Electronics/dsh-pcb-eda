/**
 * 宿主服务（service.ts）测试。
 *
 * 覆盖三件容易出错的事：
 *   1. 两种报告格式归一化后条数/级别不能丢（pcblint 大写枚举、kicad-cli 分区数组）
 *   2. 局部检查只做结果过滤，且必须如实标注被过滤掉的条数
 *   3. 无坐标的条目不能因为区域过滤被悄悄丢掉
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AdaptiveExecutor } from '../src/adaptive-executor.ts'
import type { DrcRunResult } from '../src/executor.ts'
import { createDrcService, inRegion, parseDrcViolations } from '../src/service.ts'

const PCB_LINT_REPORT = JSON.stringify({
  format: 'pcblint',
  kicadDrcAvailable: true,
  kicadDrcUsed: true,
  rulesExecuted: 26,
  suppressedCount: 3,
  violations: [
    {
      ruleId: '', title: 'Courtyards overlap', severity: 'ERROR', confidence: 'HIGH',
      message: 'courtyards_overlap: Courtyards overlap',
      location: { x: 10, y: 10 }, objects: ['C13', 'OLED1'], backend: 'EDA_DRC',
    },
    {
      ruleId: 'clearance', title: 'Clearance', severity: 'ERROR', confidence: 'MEDIUM',
      message: 'clearance: Clearance violation', location: { x: 90, y: 90 }, objects: [],
    },
    {
      ruleId: '', title: 'Silkscreen overlap', severity: 'WARNING', confidence: 'HIGH',
      message: 'silk_overlap: Silkscreen overlap', objects: ['R1'],
    },
    {
      ruleId: 'x', title: 'Advisory', severity: 'INFO', confidence: 'LOW',
      message: 'advisory: check manually', location: { x: 12, y: 12 }, objects: [],
    },
  ],
})

const KICAD_CLI_REPORT = JSON.stringify({
  ignored_checks: [{ type: 'silk_over_copper' }],
  groups: [{ id: 'g1' }],
  violations: undefined,
  courtyard_overlap: [
    {
      severity: 'error', type: 'courtyards_overlap', description: 'Courtyards overlap',
      items: [{ description: 'C13', pos: { x: 5, y: 5 } }, { description: 'OLED1' }],
    },
  ],
  clearance: [
    { severity: 'warning', type: 'clearance', description: 'Clearance', items: [] },
  ],
})

/** 执行器 stdout 的真实形状（RemoteExecutor 会把服务端口径写进这一行 JSON）。 */
const STDIO = JSON.stringify({
  service: 'pcblint',
  kicadDrcUsed: true,
  rulesExecuted: 26,
  suppressedCount: 3,
})

function fakeAdaptive(result: Partial<DrcRunResult>) {
  const calls: unknown[] = []
  const adaptive = {
    async run(options: unknown) {
      calls.push(options)
      return {
        exitCode: 0,
        stdout: STDIO,
        stderr: '',
        drcJson: null,
        elapsedMs: 12,
        timedOut: false,
        kicadCliPath: 'test',
        command: 'test',
        drcJsonPath: null,
        ...result,
      } satisfies DrcRunResult
    },
    async describe() {
      return []
    },
  }
  return { adaptive: adaptive as unknown as AdaptiveExecutor, calls }
}

test('pcblint 格式归一化：级别、置信度、位置、对象都不丢', () => {
  const violations = parseDrcViolations(PCB_LINT_REPORT)
  assert.equal(violations.length, 4)
  assert.deepEqual(violations[0], {
    severity: 'error',
    ruleId: 'courtyards_overlap',
    title: 'Courtyards overlap',
    message: 'courtyards_overlap: Courtyards overlap',
    confidence: 'HIGH',
    backend: 'EDA_DRC',
    location: { x: 10, y: 10 },
    objects: ['C13', 'OLED1'],
  })
  assert.equal(violations[2]?.severity, 'warning')
  assert.equal(violations[2]?.location, undefined)
  assert.equal(violations[3]?.severity, 'info')
})

test('kicad-cli 格式归一化：跳过非违规分区，坐标取 items[].pos', () => {
  const violations = parseDrcViolations(KICAD_CLI_REPORT)
  assert.equal(violations.length, 2)
  assert.deepEqual(violations[0], {
    severity: 'error',
    ruleId: 'courtyards_overlap',
    title: 'courtyards_overlap',
    message: 'Courtyards overlap',
    location: { x: 5, y: 5 },
    objects: ['C13', 'OLED1'],
  })
  // 没有 items 位置时不给 location，而不是伪造 (0,0)
  assert.equal(violations[1]?.location, undefined)
})

test('矩形命中判定含边界', () => {
  const region = { x: 0, y: 0, width: 10, height: 10 }
  assert.equal(inRegion({ x: 0, y: 0 }, region), true)
  assert.equal(inRegion({ x: 10, y: 10 }, region), true)
  assert.equal(inRegion({ x: 10.01, y: 5 }, region), false)
})

test('整板检查：不传 region 时全部保留并统计', async () => {
  const { adaptive } = fakeAdaptive({ drcJson: PCB_LINT_REPORT, reportFormat: 'pcblint' })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb' })
  assert.equal(result.scope, 'full')
  assert.equal(result.outsideRegion, 0)
  assert.equal(result.unknownRegion, 0)
  assert.deepEqual(result.counts, { error: 2, warning: 1, info: 1, other: 0, total: 4 })
  assert.equal(result.suppressedCount, 3)
  assert.equal(result.kicadDrcUsed, true)
  assert.equal(result.complete, true)
  assert.equal(result.rulesExecuted, 26)
})

test('局部检查：只保留区域内，区域外计数，无坐标条目不丢', async () => {
  const { adaptive } = fakeAdaptive({ drcJson: PCB_LINT_REPORT, reportFormat: 'pcblint' })
  const result = await createDrcService(adaptive).check({
    pcbPath: 'board.kicad_pcb',
    region: { x: 0, y: 0, width: 20, height: 20 },
  })
  assert.equal(result.scope, 'region')
  // (10,10)、(12,12) 在区域内；(90,90) 在外；silk_overlap 无坐标 → 保留并计数
  assert.equal(result.counts.total, 3)
  assert.equal(result.outsideRegion, 1)
  assert.equal(result.unknownRegion, 1)
  assert.equal(result.violations.some((v) => v.severity === 'warning'), true)
})

test('规则源与超时原样传给执行器', async () => {
  const { adaptive, calls } = fakeAdaptive({ drcJson: PCB_LINT_REPORT })
  await createDrcService(adaptive).check({
    pcbPath: 'candidate.kicad_pcb',
    ruleSources: { projectFile: '{"board":{}}', name: 'frozen.kicad_pro' },
    mode: 'remote',
    timeoutSeconds: 30,
  })
  assert.deepEqual(calls[0], {
    pcbPath: 'candidate.kicad_pcb',
    ruleSources: { projectFile: '{"board":{}}', name: 'frozen.kicad_pro' },
    mode: 'remote',
    timeoutSeconds: 30,
  })
})

test('没有报告时返回空结果而不是抛错', async () => {
  const { adaptive } = fakeAdaptive({ drcJson: null, stdout: '{}' })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb' })
  assert.deepEqual(result.counts, { error: 0, warning: 0, info: 0, other: 0, total: 0 })
  assert.equal(result.kicadDrcUsed, null)
  // 后端没给口径不等于"不完整"：没证据就不降级可信度
  assert.equal(result.complete, true)
})

test('缺少 pcbPath 直接拒绝', async () => {
  const { adaptive } = fakeAdaptive({ drcJson: PCB_LINT_REPORT })
  await assert.rejects(
    () => createDrcService(adaptive).check({ pcbPath: '' }),
    /缺少 pcbPath/u,
  )
})

test('取消信号原样传给执行器（否则取消任务后 DRC 仍会跑完）', async () => {
  const { adaptive, calls } = fakeAdaptive({ drcJson: PCB_LINT_REPORT })
  const ctrl = new AbortController()
  await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb', signal: ctrl.signal })
  assert.equal((calls[0] as { signal?: AbortSignal }).signal, ctrl.signal)
})

test('执行器给了结构化 metrics 时不再解析 stdout', async () => {
  const { adaptive } = fakeAdaptive({
    drcJson: PCB_LINT_REPORT,
    // stdout 里的数字与 metrics 故意不同：以 metrics 为准
    metrics: { suppressedCount: 7, kicadDrcUsed: false, rulesExecuted: 11, drcRulesCount: 5 },
  })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb' })
  assert.equal(result.suppressedCount, 7)
  assert.equal(result.kicadDrcUsed, false)
  assert.equal(result.rulesExecuted, 11)
  // kicad-cli 没跑起来：必须能被调用方直接判成"不完整"，不能只留一句 notes
  assert.equal(result.complete, false)
})

test('没有结构化 metrics 时回退到 stdout（兼容直接调用单个执行器）', async () => {
  const { adaptive } = fakeAdaptive({ drcJson: PCB_LINT_REPORT })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb' })
  assert.equal(result.suppressedCount, 3)
  assert.equal(result.kicadDrcUsed, true)
  assert.equal(result.complete, true)
  assert.equal(result.rulesExecuted, 26)
})

test('规则注入结果以结构化字段透出，而不是只留一句文本', async () => {
  const { adaptive } = fakeAdaptive({
    drcJson: PCB_LINT_REPORT,
    projectRules: {
      status: 'skipped',
      applied: 0,
      skipped: [],
      druMerged: false,
      message: 'board.kicad_pro 里没有可注入的板级约束',
    },
  })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb' })
  assert.equal(result.projectRules.status, 'skipped')
  assert.match(result.projectRules.message ?? '', /没有可注入/u)
})

test('drcRuleOverrides 透传给执行器，落地结果原样回传', async () => {
  const drcRules = { status: 'applied' as const, keys: ['silk_edge_clearance'], enabledCount: 1 }
  const { adaptive, calls } = fakeAdaptive({ drcJson: PCB_LINT_REPORT, drcRules })
  const result = await createDrcService(adaptive).check({
    pcbPath: 'board.kicad_pcb',
    drcRuleOverrides: { silk_edge_clearance: 'error' },
  })
  // 布局插件要的规则维度过滤，必须一比一传到执行器
  assert.deepEqual(
    (calls[0] as { drcRuleOverrides?: unknown }).drcRuleOverrides,
    { silk_edge_clearance: 'error' },
  )
  assert.deepEqual(result.drcRules, drcRules)
})

test('drcRulesCount=0：kicadDrcUsed=true 也判不完整，notes 给出打开开关的指引', async () => {
  const { adaptive } = fakeAdaptive({
    drcJson: PCB_LINT_REPORT,
    metrics: { suppressedCount: 0, kicadDrcUsed: true, rulesExecuted: 4, drcRulesCount: 0 },
  })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb' })
  // pcblint 新版默认一条内置规则都不开：结果只有自研规则，kicadDrcUsed=true 也救不了
  assert.equal(result.complete, false)
  assert.match(result.notes, /一条 KiCad 内置规则都没启用/)
})

test('给了 remote 专属参数却没指定 mode 时按 remote 执行，不静默落到 local', async () => {
  // ruleSources / drcRuleOverrides 只有 remote 认。走 auto 有概率落到 local/ipc，
  // 规则被丢掉而调用方毫无察觉——比 remote 不可用直接报错更糟。
  const { adaptive, calls } = fakeAdaptive({ drcJson: PCB_LINT_REPORT })
  const result = await createDrcService(adaptive).check({
    pcbPath: 'board.kicad_pcb',
    ruleSources: { projectFile: '(board)', name: 'board.kicad_pro' },
  })
  assert.equal((calls[0] as { mode?: string }).mode, 'remote')
  // 行为变了要能看出来，不能只改不报
  assert.match(result.notes, /按 remote 执行/)
})

test('没给 remote 专属参数、也没指定 mode 时仍走 auto', async () => {
  const { adaptive, calls } = fakeAdaptive({ drcJson: PCB_LINT_REPORT })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb' })
  assert.equal((calls[0] as { mode?: string }).mode, 'auto')
  assert.doesNotMatch(result.notes, /按 remote 执行/)
})

test('显式 mode 优先于 remote 专属参数的隐含选择', async () => {
  // 调用方明确说了要 local，就尊重它——隐含默认只在"没表态"时兜底
  const { adaptive, calls } = fakeAdaptive({ drcJson: KICAD_CLI_REPORT, reportFormat: 'kicad-cli' })
  await createDrcService(adaptive).check({
    pcbPath: 'board.kicad_pcb',
    drcRuleOverrides: { silk_edge_clearance: 'error' },
    mode: 'local',
  })
  assert.equal((calls[0] as { mode?: string }).mode, 'local')
})

test('local/ipc 没有注入过程，标为 not-applicable 而不是"按默认参数跑了"', async () => {
  const { adaptive } = fakeAdaptive({ drcJson: KICAD_CLI_REPORT, reportFormat: 'kicad-cli' })
  const result = await createDrcService(adaptive).check({ pcbPath: 'board.kicad_pcb', mode: 'local' })
  assert.equal(result.projectRules.status, 'not-applicable')
})
