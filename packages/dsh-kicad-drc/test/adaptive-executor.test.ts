import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdaptiveExecutor, rankBackends } from '../src/adaptive-executor.ts'
import { DrcAbortedError } from '../src/executor.ts'
import type {
  BackendHealth,
  DrcBackendName,
  DrcExecutor,
  DrcRunOptions,
  DrcRunResult,
} from '../src/executor.ts'

/** 构造一个成功结果。 */
function okResult(endpoint = 'x', elapsedMs = 42): DrcRunResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    drcJson: null,
    elapsedMs,
    timedOut: false,
    kicadCliPath: endpoint,
    command: '',
    drcJsonPath: null,
  }
}

interface FakeBackend extends DrcExecutor {
  calls: number
}

/** 构造可控的后端替身。 */
function fakeBackend(
  name: DrcBackendName,
  options: {
    available?: boolean
    run?: (o: DrcRunOptions) => Promise<DrcRunResult>
  } = {},
): FakeBackend {
  const backend: FakeBackend = {
    name,
    calls: 0,
    async probe(): Promise<BackendHealth> {
      return { backend: name, available: options.available !== false, endpoint: `${name}-endpoint` }
    },
    async run(o: DrcRunOptions): Promise<DrcRunResult> {
      backend.calls++
      if (options.run) return options.run(o)
      return okResult(`${name}-endpoint`)
    },
  }
  return backend
}

/** 两个后端都可用的健康表。 */
function healthy(): Map<DrcBackendName, BackendHealth> {
  return new Map<DrcBackendName, BackendHealth>([
    ['local', { backend: 'local', available: true, endpoint: '/usr/bin/kicad-cli' }],
    ['remote', { backend: 'remote', available: true, endpoint: 'http://pcblint' }],
  ])
}

test('rankBackends：默认按 remote → local 的优先序列分层（与耗时无关）', () => {
  const local = fakeBackend('local')
  const remote = fakeBackend('remote')
  const ranked = rankBackends({
    backends: [local, remote],
    health: healthy(),
    sizeBytes: 0,
    history: new Map(),
  })
  assert.deepEqual(ranked.map((r) => r.backend), ['remote', 'local'])
  // remote 基础耗时更高（9000ms vs 1500ms），但优先序列在前，排序不以分数为准
  assert.ok(ranked[0]!.score > ranked[1]!.score)
  assert.ok(ranked[0]!.reasons.some((r) => r.includes('优先序列第 1 位')))
})

test('rankBackends：大板给远程加上传惩罚', () => {
  const small = rankBackends({
    backends: [fakeBackend('remote')],
    health: healthy(),
    sizeBytes: 100 * 1024,
    history: new Map(),
  })[0]!
  const big = rankBackends({
    backends: [fakeBackend('remote')],
    health: healthy(),
    sizeBytes: 20 * 1024 * 1024,
    history: new Map(),
  })[0]!
  assert.ok(big.score > small.score)
  assert.ok(big.reasons.some((r) => r.includes('20.0MB')))
})

test('rankBackends：不可用后端被过滤', () => {
  const health = healthy()
  health.set('local', { backend: 'local', available: false, endpoint: '', reason: '未找到 kicad-cli' })
  const ranked = rankBackends({
    backends: [fakeBackend('local'), fakeBackend('remote')],
    health,
    sizeBytes: 0,
    history: new Map(),
  })
  assert.deepEqual(ranked.map((r) => r.backend), ['remote'])
})

test('rankBackends：粘滞后端被置顶（即使分数更高）', () => {
  const ranked = rankBackends({
    backends: [fakeBackend('local'), fakeBackend('remote')],
    health: healthy(),
    sizeBytes: 0,
    history: new Map(),
    pinned: 'remote',
  })
  assert.equal(ranked[0]!.backend, 'remote')
  assert.ok(ranked[0]!.reasons.some((r) => r.includes('保持结果可比')))
})

test('AdaptiveExecutor：auto 模式下远程失败自动回退本地并标注来源', async () => {
  const local = fakeBackend('local')
  const remote = fakeBackend('remote', { run: async () => { throw new Error('远程服务不可用') } })
  const adaptive = new AdaptiveExecutor([local, remote])

  const out = await adaptive.run({ pcbPath: join(tmpdir(), 'no-such-board.kicad_pcb') })
  assert.equal(out.verifiedBy.backend, 'local')
  assert.equal(out.verifiedBy.fallbackFrom, 'remote')
  assert.ok(out.verifiedBy.reasons.some((r) => r.includes('前序后端失败')))
  assert.equal(remote.calls, 1)
  assert.equal(local.calls, 1)
})

test('AdaptiveExecutor：显式 mode 不走自适应也不回退', async () => {
  const local = fakeBackend('local')
  const remote = fakeBackend('remote', { run: async () => { throw new Error('远程不可用') } })
  const adaptive = new AdaptiveExecutor([local, remote])

  await assert.rejects(
    adaptive.run({ pcbPath: join(tmpdir(), 'no-such-board.kicad_pcb'), mode: 'remote' }),
    /远程不可用/,
  )
  assert.equal(local.calls, 0, '显式 remote 时不应触碰本地后端')
})

test('AdaptiveExecutor：同一块板保持首次成功的后端', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kicad-drc-adaptive-'))
  try {
    const pcb = join(dir, 'board.kicad_pcb')
    writeFileSync(pcb, '(kicad_pcb (version 20241120))')

    const local = fakeBackend('local')
    const remote = fakeBackend('remote', { run: async () => { throw new Error('远程挂了') } })
    const adaptive = new AdaptiveExecutor([local, remote])

    const first = await adaptive.run({ pcbPath: pcb })
    assert.equal(first.verifiedBy.backend, 'local')
    assert.equal(first.verifiedBy.fallbackFrom, 'remote')

    // 第二次：粘滞应继续用本地，不再重试远程
    const second = await adaptive.run({ pcbPath: pcb })
    assert.equal(second.verifiedBy.backend, 'local')
    assert.ok(second.verifiedBy.reasons.some((r) => r.includes('保持结果可比')))
    assert.equal(remote.calls, 1, '粘滞生效时不应再次尝试远程')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AdaptiveExecutor：全部后端失败时抛出聚合错误', async () => {
  const adaptive = new AdaptiveExecutor([
    fakeBackend('local', { run: async () => { throw new Error('本地炸') } }),
    fakeBackend('remote', { run: async () => { throw new Error('远程炸') } }),
  ])
  await assert.rejects(
    adaptive.run({ pcbPath: join(tmpdir(), 'no-such-board.kicad_pcb') }),
    (e: unknown) => e instanceof Error
      && e.message.includes('所有 DRC 后端均失败')
      && e.message.includes('本地炸')
      && e.message.includes('远程炸'),
  )
})

test('AdaptiveExecutor：没有可用后端时给出每个后端的原因', async () => {
  const adaptive = new AdaptiveExecutor([
    fakeBackend('local', { available: false }),
    fakeBackend('remote', { available: false }),
  ])
  await assert.rejects(
    adaptive.run({ pcbPath: join(tmpdir(), 'no-such-board.kicad_pcb') }),
    /没有可用的 DRC 后端/,
  )
})

test('AdaptiveExecutor.describe：返回预计耗时', async () => {
  const adaptive = new AdaptiveExecutor([fakeBackend('local'), fakeBackend('remote')])
  const list = await adaptive.describe()
  assert.equal(list.length, 2)
  assert.ok(list.every((b) => typeof b.estimatedMs === 'number' && b.estimatedMs > 0))
  assert.equal(list[0]!.backend, 'local')
})

test('rankBackends：ipc 可用时仍排在 remote / local 之后（优先序列第 3 位）', () => {
  const health = healthy()
  health.set('ipc', { backend: 'ipc', available: true, endpoint: 'D:/py' })
  const ranked = rankBackends({
    backends: [fakeBackend('local'), fakeBackend('remote'), fakeBackend('ipc')],
    health,
    sizeBytes: 0,
    history: new Map(),
  })
  assert.deepEqual(ranked.map((r) => r.backend), ['remote', 'local', 'ipc'])
})

test('signal 已取消时直接抛 DrcAbortedError，不探活也不跑后端', async () => {
  const local = fakeBackend('local')
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(
    () => new AdaptiveExecutor([local]).run({ pcbPath: '/tmp/not-exist.kicad_pcb', signal: ctrl.signal }),
    (e: unknown) => e instanceof DrcAbortedError,
  )
  assert.equal(local.calls, 0)
})

test('取消不触发后端回退：后面的后端一次都不跑', async () => {
  const ctrl = new AbortController()
  const remote = fakeBackend('remote', {
    run: async () => {
      ctrl.abort()
      throw new DrcAbortedError()
    },
  })
  const local = fakeBackend('local')
  await assert.rejects(
    () => new AdaptiveExecutor([remote, local]).run({ pcbPath: '/tmp/not-exist.kicad_pcb', signal: ctrl.signal }),
    (e: unknown) => e instanceof DrcAbortedError,
  )
  assert.equal(remote.calls, 1)
  assert.equal(local.calls, 0, '取消不是失败，不能换个后端再烧一次')
})
