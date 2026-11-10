import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PcblintLauncher,
  buildPcblintJavaArgs,
  findFreePort,
} from '../src/pcblint-launcher.ts'
import { inspectPcblintHome } from '../src/pcblint-installation.ts'
import { resolvePcblintDataRoot } from '../src/config.ts'
import { RemoteExecutor } from '../src/remote-executor.ts'
import { ExecutorError } from '../src/executor.ts'

/** 造一个只满足存在性校验的组件目录；测试不会真的启动 JVM。 */
function createComponent(root: string, version = '9.9.9'): string {
  const home = join(root, 'pcblint-local')
  mkdirSync(join(home, 'jre25', 'bin'), { recursive: true })
  mkdirSync(join(home, 'pcblint'), { recursive: true })
  writeFileSync(join(home, 'jre25', 'bin', 'java.exe'), '')
  writeFileSync(join(home, 'pcblint', 'pcblint.jar'), '')
  writeFileSync(join(home, 'pcblint', 'version.txt'), version)
  return home
}

test('buildPcblintJavaArgs：端口、数据路径与 kicad-cli 全部改写到可写位置', () => {
  const dataRoot = join('C:', 'work', 'drc-data')
  const jarPath = join('C:', 'KiCad', 'bin', 'pcblint-local', 'pcblint', 'pcblint.jar')
  const kicadCli = join('C:', 'KiCad', 'bin', 'kicad-cli.exe')
  const args = buildPcblintJavaArgs({
    port: 18096,
    dataRoot,
    jarPath,
    kicadCliPath: kicadCli,
    javaOptions: '-Xmx1536m -Ddemo.enabled=true',
  })
  assert.ok(args.includes('-Dserver.port=18096'))
  assert.ok(args.includes('-Dserver.address=127.0.0.1'))
  assert.ok(args.includes('-Dpcblint.drc.local-mode=true'))
  assert.ok(args.includes(`-Dpcblint.drc.cli-executor.kicad-cli-path=${kicadCli}`))
  assert.ok(args.includes(`-Dpcblint.storage.file-base=${join(dataRoot, 'pcblint-files')}`))
  assert.ok(args.includes(`-Dlogging.file.name=${join(dataRoot, 'pcblint', 'pcblint.log')}`))
  // 用户参数必须排在默认 -Xmx 之后，才能覆盖内存上限
  assert.ok(args.indexOf('-Xmx1536m') > args.indexOf('-Xmx1024m'))
  assert.deepEqual(args.slice(-2), ['-jar', jarPath])
})

test('buildPcblintJavaArgs：kicad-cli 缺失时省略原生检查参数', () => {
  const args = buildPcblintJavaArgs({
    port: 18096,
    dataRoot: join('C:', 'work'),
    jarPath: join('C:', 'pcblint.jar'),
    kicadCliPath: '',
  })
  assert.equal(args.some((arg) => arg.startsWith('-Dpcblint.drc.cli-executor.kicad-cli-path=')), false)
  assert.deepEqual(args.slice(-2), ['-jar', join('C:', 'pcblint.jar')])
})

test('findFreePort：返回合法的回环端口', async () => {
  const port = await findFreePort()
  assert.ok(Number.isInteger(port))
  assert.ok(port > 0 && port < 65536)
})

test('resolvePcblintDataRoot：按 HQ_EDGE_HOME 或用户目录定位', () => {
  assert.equal(
    resolvePcblintDataRoot({ HQ_EDGE_HOME: join('D:', 'hq') }),
    join('D:', 'hq', 'plugin-data', 'dsh-kicad-drc', 'pcblint'),
  )
  // 相对路径不可信（可能落到当前工作目录），按约定回退用户目录
  assert.equal(
    resolvePcblintDataRoot({ HQ_EDGE_HOME: 'relative-home' }),
    join(homedir(), '.hq-edge', 'plugin-data', 'dsh-kicad-drc', 'pcblint'),
  )
  assert.equal(
    resolvePcblintDataRoot({}),
    join(homedir(), '.hq-edge', 'plugin-data', 'dsh-kicad-drc', 'pcblint'),
  )
})

test('describe/probe：组件就绪时报告可用但不启动进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pcblint-launcher-'))
  try {
    const home = createComponent(root)
    const launcher = new PcblintLauncher({
      resolveInstallation: () => inspectPcblintHome(home),
      dataRoot: join(root, 'data'),
    })
    const state = launcher.describe()
    assert.equal(state.running, false)
    assert.equal(state.available, true)
    assert.equal(state.home, home)
    assert.equal(state.version, '9.9.9')
    assert.match(state.reason, /按需启动/u)

    const remote = new RemoteExecutor({ launcher })
    const health = await remote.probe()
    assert.equal(health.available, true)
    assert.equal(health.endpoint, home)
    assert.match(health.reason ?? '', /按需启动/u)
    // 探测绝不能拉起 JVM
    assert.equal(launcher.ownsProcess, false)

    await launcher.dispose()
    assert.equal(launcher.describe().available, false)
    assert.match(launcher.describe().reason, /已释放/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureUp：组件不完整时直接失败，不产生自有进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pcblint-broken-'))
  try {
    const home = join(root, 'pcblint-local')
    mkdirSync(join(home, 'jre25', 'bin'), { recursive: true })
    writeFileSync(join(home, 'jre25', 'bin', 'java.exe'), '')
    const launcher = new PcblintLauncher({
      resolveInstallation: () => inspectPcblintHome(home),
      dataRoot: join(root, 'data'),
    })
    await assert.rejects(launcher.ensureUp(), /PCBLint 本地组件不完整/u)
    assert.equal(launcher.ownsProcess, false)
    assert.equal(launcher.describe().available, false)
    await launcher.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('describe：组件解析失败按冷却期缓存，避免每次探测都全盘搜索', () => {
  let calls = 0
  const launcher = new PcblintLauncher({
    resolveInstallation: () => {
      calls++
      throw new Error('组件不存在')
    },
    dataRoot: join('C:', 'work'),
  })
  assert.equal(launcher.describe().available, false)
  assert.equal(launcher.describe().available, false)
  assert.equal(calls, 1)
})

test('dispose 只结束自有进程：外部进程保持运行', async () => {
  const external = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    await new Promise<void>((done, fail) => {
      external.once('spawn', () => done())
      external.once('error', fail)
    })
    let resolved = false
    const launcher = new PcblintLauncher({
      resolveInstallation: () => {
        resolved = true
        throw new Error('dispose 不应解析组件')
      },
      dataRoot: join('C:', 'work'),
    })
    await launcher.dispose()
    // 负向控制：只管理自己 spawn 的 PID，不能顺手 taskkill 别的 java
    assert.equal(external.exitCode, null)
    assert.equal(external.signalCode, null)
    assert.equal(resolved, false)
  } finally {
    const exited = new Promise<void>((done) => external.once('exit', () => done()))
    external.kill()
    await exited
  }
})

test('PcblintLauncher：非法超时配置在构造时就报错', () => {
  const options = {
    resolveInstallation: () => {
      throw new Error('not used')
    },
    dataRoot: join('C:', 'work'),
  }
  assert.throws(() => new PcblintLauncher({ ...options, startupTimeoutMs: 0 }), ExecutorError)
  assert.throws(() => new PcblintLauncher({ ...options, idleTimeoutMs: -1 }), ExecutorError)
})
