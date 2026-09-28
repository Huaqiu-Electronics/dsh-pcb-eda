import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutor, resolveKicadCli } from '../src/local-executor.ts'
import { ExecutorError } from '../src/executor.ts'

test('resolveKicadCli 显式指定存在的路径时直接返回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kicad-drc-test-'))
  try {
    const fake = join(dir, 'kicad-cli.exe')
    writeFileSync(fake, 'fake')
    assert.equal(resolveKicadCli(fake), fake)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveKicadCli 显式指定不存在的路径时抛 ExecutorError', () => {
  const missing = join(tmpdir(), 'no-such-kicad-cli-xyz.exe')
  assert.throws(
    () => resolveKicadCli(missing),
    (e: unknown) => e instanceof ExecutorError && e.message.includes('不存在'),
  )
})

test('LocalExecutor 懒解析：构造时不探测 kicad-cli', () => {
  // 即使显式指定了不存在的路径，构造函数也不应抛错（首次 run() 才解析）
  const executor = new LocalExecutor(join(tmpdir(), 'no-such-kicad-cli-xyz.exe'))
  assert.ok(executor instanceof LocalExecutor)
})

test('LocalExecutor.run PCB 文件不存在时报错', async () => {
  const executor = new LocalExecutor()
  await assert.rejects(
    executor.run({ pcbPath: join(tmpdir(), 'no-such-board.kicad_pcb') }),
    (e: unknown) => e instanceof ExecutorError && e.message.includes('PCB 文件不存在'),
  )
})

test('LocalExecutor.run kicad-cli 解析失败时报错（懒解析生效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kicad-drc-test-'))
  try {
    const pcb = join(dir, 'board.kicad_pcb')
    writeFileSync(pcb, '(kicad_pcb (version 20241120))')
    const executor = new LocalExecutor(join(tmpdir(), 'no-such-kicad-cli-xyz.exe'))
    await assert.rejects(
      executor.run({ pcbPath: pcb }),
      (e: unknown) => e instanceof ExecutorError && e.message.includes('kicad-cli'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
